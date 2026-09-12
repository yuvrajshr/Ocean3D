"""Everything that talks to Gemini lives here. The API key stays on the server.

Uses google-genai's interactions API: client.interactions.create(...) returns an
Interaction with steps and output_text; a function_call step is answered with a
function_result entry.

Speed:
- gemini-3.5-flash-lite with minimal thinking (~2 s per round)
- a turn that only runs actions ends after one round, with the confirmation
  built from the actions instead of asking the model
- reads in a round run in parallel with a time budget
- on a rate limit we move to the next model (quota is per model)
- the Google Search check happens in the background

Read tools run here. Action tools change React state, so we only validate them
against the client's screen state and send them back for the client to apply.
"""

from __future__ import annotations

import copy
import json
import math
import re
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from typing import Any, Callable

from ..config import (
    ASSISTANT_CACHE_TTL_SECONDS,
    ASSISTANT_MAX_STEPS,
    ASSISTANT_READ_BUDGET_SECONDS,
    GEMINI_API_KEY,
    GEMINI_AVAILABLE,
    GEMINI_FALLBACK_MODELS,
    GEMINI_MODEL,
    GEMINI_SEARCH,
    GEMINI_THINKING,
    GEMINI_TIMEOUT_SECONDS,
)
from . import reads as reads_module
from .prompt import build_system_prompt
from .reads import READ_TOOLS, ReadError, cache_context, status_for
from .tools import (
    ACTION_TOOLS,
    ActionError,
    ScreenState,
    advance_state,
    declarations_for,
    describe_actions,
    validate_action,
)


class AssistantUnavailable(Exception):
    """No API key, or no model answered. The message is shown to the user."""


@dataclass
class TurnResult:
    text: str = ""
    actions: list[dict[str, Any]] = field(default_factory=list)
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    web_sources: list[dict[str, Any]] = field(default_factory=list)
    # Model used for the last round, and how many rounds it took.
    model: str | None = None
    rounds: int = 0

    @property
    def citations(self) -> list[dict[str, Any]]:
        """Citations for the answer, built from the tool calls that actually ran (not
        from the text). kind="data" is one of our datasets, kind="web" is a Google
        Search result; they're shown differently.
        """
        out: list[dict[str, Any]] = []
        for call in self.tool_calls:
            result = call.get("result")
            prov = result.get("provenance") if isinstance(result, dict) else None
            if prov:
                out.append({"kind": "data", "tool": call["name"], **prov})
        for source in self.web_sources:
            out.append({"kind": "web", **source})
        return out


def is_available() -> bool:
    return GEMINI_AVAILABLE


# --- Client and model chain ---

_client_lock = threading.Lock()
_client_obj: Any = None


def _client():
    """One client per process so the connection pool is reused."""
    global _client_obj
    if not GEMINI_AVAILABLE:
        raise AssistantUnavailable(
            "The assistant needs a Gemini API key. Add GEMINI_API_KEY to backend/.env "
            "and restart the backend."
        )
    with _client_lock:
        if _client_obj is None:
            from google import genai  # lazy import

            _client_obj = genai.Client(api_key=GEMINI_API_KEY)
        return _client_obj


class ModelChain:
    """Models to try in order, and when each can be retried."""

    def __init__(self, models) -> None:
        self.models = list(dict.fromkeys(m for m in models if m))
        self._until: dict[str, float] = {}
        self._lock = threading.Lock()

    def usable(self, now: float) -> list[str]:
        with self._lock:
            return [m for m in self.models if self._until.get(m, 0.0) <= now]

    def cool(self, model: str, seconds: float, now: float) -> None:
        with self._lock:
            self._until[model] = max(self._until.get(model, 0.0), now + seconds)

    def soonest(self, now: float) -> float:
        with self._lock:
            return min((self._until.get(m, now) for m in self.models), default=now)


_chain = ModelChain([GEMINI_MODEL, *GEMINI_FALLBACK_MODELS])
# Models that rejected thinking_level; we stop sending it to them.
_thinking_refused: set[str] = set()
# Longest we'll wait for a rate-limited model before giving up.
MAX_QUOTA_WAIT_SECONDS = 15.0


def _is_quota_error(text: str) -> bool:
    return "429" in text or "RESOURCE_EXHAUSTED" in text.upper()


def _is_timeout(exc: Exception) -> bool:
    return (
        isinstance(exc, TimeoutError)
        or "timeout" in type(exc).__name__.lower()
        or "timed out" in str(exc).lower()
    )


def _retry_delay(message: str) -> float | None:
    """The retry delay Gemini asks for in a 429 ("Please retry in 30.6s")."""
    match = re.search(r"retry in ([\d.]+)\s*s", message)
    return float(match.group(1)) if match else None


def _create(client: Any, *, on_status: Callable[[str], None] | None, **request: Any):
    """One request across the model chain. Returns (interaction, model)."""
    last_error: Exception | None = None
    for _ in range(2 * len(_chain.models) + 2):
        now = time.monotonic()
        usable = _chain.usable(now)
        if not usable:
            wait = _chain.soonest(now) - now
            if wait > MAX_QUOTA_WAIT_SECONDS:
                raise AssistantUnavailable(
                    "Every Gemini model on this key is rate limited for the moment "
                    f"(retry in about {math.ceil(wait)} s). Nothing else in the app is affected."
                )
            if on_status is not None:
                on_status(f"Rate limited — waiting {math.ceil(wait)} s…")
            time.sleep(max(0.0, wait) + 0.25)
            continue

        model = usable[0]
        attempt = {**request, "model": model}
        if GEMINI_THINKING and model not in _thinking_refused:
            attempt["generation_config"] = {"thinking_level": GEMINI_THINKING}
        try:
            return client.interactions.create(**attempt, timeout=GEMINI_TIMEOUT_SECONDS), model
        except Exception as exc:  # noqa: BLE001 - the SDK raises a wide variety
            text, last_error = str(exc), exc
            if _is_quota_error(text):
                _chain.cool(model, _retry_delay(text) or 30.0, time.monotonic())
            elif _is_timeout(exc):
                _chain.cool(model, 30.0, time.monotonic())
            elif "generation_config" in attempt and "thinking" in text.lower():
                _thinking_refused.add(model)
            else:
                raise
    raise AssistantUnavailable(f"The assistant could not reach Gemini: {last_error}")


# --- Google Search ---
# Search grounding isn't in the free tier (requests with google_search get a 429).
# We send requests without it until a background probe, started from
# /assistant/status, finds out whether this key can use it.

_search_available: bool | None = {"on": True, "off": False}.get(GEMINI_SEARCH)
_probe_lock = threading.Lock()
_probe_running = False


def search_available() -> bool | None:
    """True, False, or None if we don't know yet."""
    return _search_available


def start_search_probe() -> None:
    global _probe_running
    if _search_available is not None or not GEMINI_AVAILABLE:
        return
    with _probe_lock:
        if _probe_running:
            return
        _probe_running = True
    threading.Thread(target=_probe_search, name="gemini-search-probe", daemon=True).start()


def _probe_search() -> None:
    global _search_available, _probe_running
    try:
        client = _client()
        base = {
            "model": _chain.models[0],
            "store": False,
            "input": "ping",
            "timeout": GEMINI_TIMEOUT_SECONDS,
        }
        if GEMINI_THINKING:
            base["generation_config"] = {"thinking_level": GEMINI_THINKING}
        try:
            client.interactions.create(**base, tools=[{"type": "google_search"}])
            _search_available = True
        except Exception as exc:  # noqa: BLE001
            if not _is_quota_error(str(exc)):
                return
            try:
                client.interactions.create(**base)
                _search_available = False  # plain works, search doesn't
            except Exception:  # noqa: BLE001 - inconclusive: the quota is genuinely out
                pass
    finally:
        with _probe_lock:
            _probe_running = False


# --- Tools ---

_reads = ThreadPoolExecutor(max_workers=8, thread_name_prefix="assistant-read")


def _cache_key(name: str, args: dict[str, Any], context: dict[str, Any]) -> str:
    """Cache key: independent of argument order, includes what's on screen and
    RESULT_VERSION so results from older code aren't reused.
    """
    body = json.dumps({"args": args, "screen": context}, sort_keys=True, default=str)
    return f"v{reads_module.RESULT_VERSION}:{name}:{body}"


def _start_read(name: str, args: dict[str, Any], state: ScreenState, store: Any | None):
    """Return a cached or refused result, or a Future if it's still running."""
    fn = READ_TOOLS.get(name)
    if fn is None:
        return {"ok": False, "error": f"There is no {name!r} tool."}

    # Copy the state, since the read runs on another thread while actions keep updating it.
    snapshot = copy.deepcopy(state)
    key = _cache_key(name, args, cache_context(name, snapshot))
    if store is not None:
        cached = store.cache_get(key)
        if cached is not None:
            return cached

    def run() -> Any:
        try:
            result = fn(snapshot, args)
        except ReadError as exc:
            return {"ok": False, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001 - an upstream failure must not kill the turn
            return {"ok": False, "error": f"That data could not be read: {exc}"}
        # Cache it even if it finished after the budget, so asking again is instant.
        if store is not None and not (isinstance(result, dict) and result.get("ok") is False):
            store.cache_put(key, result, ttl=ASSISTANT_CACHE_TTL_SECONDS)
        return result

    return _reads.submit(run)


def _pending(name: str) -> dict[str, Any]:
    return {
        "ok": False,
        "pending": True,
        "error": (
            f"{name} is still loading from the upstream. It will be ready in a few seconds: "
            "tell the reader to ask again shortly. Do not estimate the value."
        ),
    }


# --- The turn ---

# If the user asked a question, the turn has to end with an answer. Otherwise
# "What is the temperature at 100 m here?" could end at "Showing temperature."
# after a view change.
_QUESTION = re.compile(
    r"^s*(what|what's|whats|where|which|how|why|when|who|whose|is|are|was|were|"
    r"does|do|did|can|could|will|would|should|tell me|explain|describe|summari[sz]e)",
    re.IGNORECASE,
)


def _asks_a_question(history: list[dict[str, Any]]) -> bool:
    """Whether the latest message asks for information rather than a change."""
    for entry in reversed(history):
        if isinstance(entry, dict) and entry.get("type") == "user_input":
            text = " ".join(
                c.get("text", "") for c in entry.get("content") or [] if isinstance(c, dict)
            ).strip()
            return text.endswith("?") or bool(_QUESTION.match(text))
    return False

def run_turn(
    *,
    history: list[dict[str, Any]],
    state: ScreenState,
    catalogue: list[str],
    store: Any | None = None,
    on_status: Callable[[str], None] | None = None,
) -> TurnResult:
    """Run one user message until there's a final answer.

    ``history`` is kept by us (store=False), so nothing is stored on Google's side.
    ``state`` is updated as actions are accepted, so later actions see the result
    of earlier ones.
    """
    client = _client()
    result = TurnResult()
    asks = _asks_a_question(history)

    for _ in range(ASSISTANT_MAX_STEPS):
        tools: list[dict[str, Any]] = list(declarations_for(state.view))
        if _search_available:
            tools = [{"type": "google_search"}, *tools]
        interaction, result.model = _create(
            client,
            on_status=on_status,
            store=False,
            input=history,
            tools=tools,
            system_instruction=build_system_prompt(state=state, catalogue=catalogue),
        )
        result.rounds += 1

        steps = list(getattr(interaction, "steps", None) or [])
        for step in steps:
            history.append(step.model_dump() if hasattr(step, "model_dump") else step)
        for source in _collect_web_sources(interaction):
            if source["url"] not in {s["url"] for s in result.web_sources}:
                result.web_sources.append(source)

        calls = [s for s in steps if getattr(s, "type", None) == "function_call"]
        if not calls:
            result.text = getattr(interaction, "output_text", "") or ""
            return result

        payloads: list[Any] = [None] * len(calls)
        waiting: dict[int, Future] = {}
        round_actions: list[dict[str, Any]] = []
        only_accepted_actions = True
        switched = False

        for index, call in enumerate(calls):
            name = getattr(call, "name", "")
            args = getattr(call, "arguments", None) or {}
            if isinstance(args, str):  # don't string-match serialized arguments
                args = json.loads(args)
            if on_status is not None:
                on_status(status_for(name, args, state))

            if name in ACTION_TOOLS:
                try:
                    action = validate_action(name, args, state, catalogue)
                except ActionError as exc:
                    payloads[index] = {"ok": False, "error": str(exc)}
                    only_accepted_actions = False
                    continue
                payloads[index] = {"ok": True, "applied": action}
                round_actions.append(action)
                switched = advance_state(state, action) or switched
            else:
                only_accepted_actions = False
                started = _start_read(name, args, state, store)
                if isinstance(started, Future):
                    waiting[index] = started
                else:
                    payloads[index] = started

        deadline = time.monotonic() + ASSISTANT_READ_BUDGET_SECONDS
        for index, future in waiting.items():
            try:
                payloads[index] = future.result(timeout=max(0.0, deadline - time.monotonic()))
            except FutureTimeout:
                payloads[index] = _pending(getattr(calls[index], "name", "that read"))

        for call, payload in zip(calls, payloads):
            name = getattr(call, "name", "")
            args = getattr(call, "arguments", None) or {}
            result.tool_calls.append({"name": name, "arguments": args, "result": payload})
            history.append({
                "type": "function_result",
                "name": name,
                "call_id": getattr(call, "id", None),
                "result": [{"type": "text", "text": json.dumps(payload, default=str)}],
            })
        result.actions.extend(round_actions)

        # Command-only turn: nothing to explain or refuse, no view switch, no question.
        if round_actions and only_accepted_actions and not switched and not asks:
            result.text = describe_actions(result.actions)
            return result

    result.text = (
        "I could not finish that in the number of steps allowed. Try asking for one thing at a time."
    )
    return result


def _collect_web_sources(interaction: Any) -> list[dict[str, Any]]:
    """Get the pages Google Search returned from the url_citation annotations.
    They can be on steps or on content blocks, so check both and don't fail the
    answer if the shape is unexpected.
    """
    found: dict[str, dict[str, Any]] = {}

    def absorb(annotations: Any) -> None:
        for ann in annotations or []:
            if getattr(ann, "type", None) != "url_citation":
                continue
            url = getattr(ann, "url", None)
            if url:
                found.setdefault(url, {"url": url, "title": getattr(ann, "title", None) or url})

    for step in getattr(interaction, "steps", None) or []:
        absorb(getattr(step, "annotations", None))
        for block in getattr(step, "content", None) or []:
            absorb(getattr(block, "annotations", None))
    return list(found.values())
