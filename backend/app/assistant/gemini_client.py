"""The only place in the project that talks to Gemini.

Same discipline as `erddap_client.py`: one module owns the upstream, so the
auth, the request shape and the failure modes live together. The API key is read
from `backend/.env` and never leaves the server (context.md §5.5).

The API shape was verified against the installed `google-genai` 2.22 and the
live docs, not recalled: `client.interactions.create(...)` returning an
`Interaction` with `steps` and `output_text`, where a `function_call` step
carries `name`/`arguments`/`id` and is answered with a `function_result` entry.
`generation_config.thinking_level` and `timeout` are real parameters of that
call (checked in `_gaos/types/interactions/createmodelinteraction.py`).

**Speed is designed in, not tuned** (2026-09-10; measured before the change at
8-13 s per round on gemini-3.5-flash, 21 s for a one-line command):

- `gemini-3.5-flash-lite` at minimal thinking, ~1.9 s per round;
- a turn made only of successful actions ends after ONE round, its sentence
  composed from the validated actions instead of asked of the model;
- reads in a round run in parallel, each inside a budget;
- a rate-limited model is swapped for the next in the chain, never slept on,
  because each model has its own free-tier quota;
- Google Search is probed off the request path, not on a reader's first question.

The tool loop is split by necessity. Read tools execute here. Action tools
cannot — they mutate React state in a browser — so they are validated against
the client's screen snapshot and collected for the client to apply, and the
model is told the truth either way.
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
    """No API key, or no model would answer. Carries a reader-facing reason."""


@dataclass
class TurnResult:
    text: str = ""
    actions: list[dict[str, Any]] = field(default_factory=list)
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    web_sources: list[dict[str, Any]] = field(default_factory=list)
    #: The model that produced the final round, and how many rounds it took.
    model: str | None = None
    rounds: int = 0

    @property
    def citations(self) -> list[dict[str, Any]]:
        """Provenance for the answer, built from what actually ran.

        This is the whole grounding mechanism: the panel cites from here, not
        from the prose. `kind="data"` is a measurement from one of this
        project's upstreams; `kind="web"` is a page Google Search returned. A
        reader must never mistake one for the other, so they are kept apart.
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


# --------------------------------------------------------------------------
# The client and the model chain
# --------------------------------------------------------------------------

_client_lock = threading.Lock()
_client_obj: Any = None


def _client():
    """One client for the process: its connection pool outlives a turn."""
    global _client_obj
    if not GEMINI_AVAILABLE:
        raise AssistantUnavailable(
            "The assistant needs a Gemini API key. Add GEMINI_API_KEY to backend/.env "
            "and restart the backend."
        )
    with _client_lock:
        if _client_obj is None:
            from google import genai  # lazily, so a missing key never costs the import

            _client_obj = genai.Client(api_key=GEMINI_API_KEY)
        return _client_obj


class ModelChain:
    """The models to try, in order, and when each may be tried again."""

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
#: Models that rejected `thinking_level`; asked without it from then on.
_thinking_refused: set[str] = set()
#: The longest the loop will wait for a cooled model before saying so.
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
    """The delay Gemini itself asks for on a 429 ("Please retry in 30.6s")."""
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


# --------------------------------------------------------------------------
# Google Search, probed off the request path
# --------------------------------------------------------------------------
#
# Grounding is billed separately and is NOT on the free tier: with
# `google_search` in `tools`, every request 429s while the same request without
# it succeeds. The old code learned that on a reader's first question, paying a
# 6-8 s 429 each restart. Now requests go without search until a background
# probe — started when the dock asks /assistant/status — settles it.

_search_available: bool | None = {"on": True, "off": False}.get(GEMINI_SEARCH)
_probe_lock = threading.Lock()
_probe_running = False


def search_available() -> bool | None:
    """True, False, or None if it has not been settled yet."""
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
                _search_available = False  # plain works, search refused: this key cannot search
            except Exception:  # noqa: BLE001 - inconclusive: the quota is genuinely out
                pass
    finally:
        with _probe_lock:
            _probe_running = False


# --------------------------------------------------------------------------
# Tools
# --------------------------------------------------------------------------

_reads = ThreadPoolExecutor(max_workers=8, thread_name_prefix="assistant-read")


def _cache_key(name: str, args: dict[str, Any], context: dict[str, Any]) -> str:
    """Stable across argument order, specific to what was on screen, and to the
    shape the reads return — so a row written by older code is never served."""
    body = json.dumps({"args": args, "screen": context}, sort_keys=True, default=str)
    return f"v{reads_module.RESULT_VERSION}:{name}:{body}"


def _start_read(name: str, args: dict[str, Any], state: ScreenState, store: Any | None):
    """A cached or refused result now, or a Future for one that is running."""
    fn = READ_TOOLS.get(name)
    if fn is None:
        return {"ok": False, "error": f"There is no {name!r} tool."}

    # The read sees the screen as it was at this call, not as later actions in
    # the same round leave it; it runs on another thread.
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
        # Cached even when it lands after the budget, so asking again is instant.
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


# --------------------------------------------------------------------------
# The turn
# --------------------------------------------------------------------------

# A message that asks for information must end in an answer, even when the
# model's first step only changed the view. Found live on 2026-09-10: "What is
# the temperature at 100 m here?" drew a show_variable first, and the one-round
# shortcut ended the turn at "Showing temperature." without ever reading a value.
_QUESTION = re.compile(
    r"^s*(what|what's|whats|where|which|how|why|when|who|whose|is|are|was|were|"
    r"does|do|did|can|could|will|would|should|tell me|explain|describe|summari[sz]e)",
    re.IGNORECASE,
)


def _asks_a_question(history: list[dict[str, Any]]) -> bool:
    """Whether the reader's latest message asks for information, not a change."""
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
    """One user message through to a finished answer.

    `history` is the transcript in the API's own `input` shape; we hold it rather
    than letting Gemini store it (`store=False`), so nothing about a forecaster's
    session persists on a third-party server. `state` is advanced as actions are
    accepted, so a later round — and a later action in the same round — sees the
    screen the earlier ones produced.
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
            if isinstance(args, str):  # never string-match a serialized argument
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

        # A command turn ends here: nothing to explain, nothing refused, no new
        # view whose controls the model still needs, and no question to answer.
        if round_actions and only_accepted_actions and not switched and not asks:
            result.text = describe_actions(result.actions)
            return result

    result.text = (
        "I could not finish that in the number of steps allowed. Try asking for one thing at a time."
    )
    return result


def _collect_web_sources(interaction: Any) -> list[dict[str, Any]]:
    """Pull the pages Google Search actually returned out of an interaction.

    Read from `url_citation` annotations rather than trusted from the prose, for
    the same reason the ocean citations are built from tool calls. Defensive:
    annotations appear on steps or on their content blocks depending on the
    shape returned, and an unfamiliar variant should cost the sources, not the
    answer.
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
