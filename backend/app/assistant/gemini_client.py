"""The only place in the project that talks to Gemini.

Same discipline as `erddap_client.py`: one module owns the upstream, so the
auth, the request shape and the failure modes live together and nothing else
has to know them. The API key is read from `backend/.env` and never leaves the
server (context.md §5.5).

The API shape here was verified against the installed `google-genai` 2.22.0 and
the live docs, not recalled: it is `client.interactions.create(...)` returning
an `Interaction` with `steps` and `output_text`, where a `function_call` step
carries `name`/`arguments`/`id` and is answered with a `function_result` entry.
This replaced the older `generate_content` surface, so do not "fix" it back.

The tool loop is split by necessity. Read tools execute here. Action tools
cannot — they mutate React state in a browser — so they are validated against
the client's state snapshot and collected for the client to apply. The model is
told the truth either way, which is what lets it say "added chlorophyll" only
when chlorophyll was actually addable.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from ..config import (
    ASSISTANT_CACHE_TTL_SECONDS,
    ASSISTANT_MAX_STEPS,
    GEMINI_API_KEY,
    GEMINI_AVAILABLE,
    GEMINI_MODEL,
    GEMINI_SEARCH,
)
from .prompt import build_system_prompt
from .reads import READ_TOOLS, ReadError
from .tools import ACTION_TOOLS, DECLARATIONS, ActionError, ScreenState, validate_action


class AssistantUnavailable(Exception):
    """No API key, or the upstream refused. Carries a reader-facing reason."""


@dataclass
class TurnResult:
    text: str = ""
    actions: list[dict[str, Any]] = field(default_factory=list)
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    web_sources: list[dict[str, Any]] = field(default_factory=list)

    @property
    def citations(self) -> list[dict[str, Any]]:
        """Provenance for the answer, built from what actually ran.

        This is the whole grounding mechanism: the panel cites from here, not
        from the prose, so a claim the model produced without fetching anything
        has nothing to show and is marked as general knowledge instead.

        Two kinds, and the distinction is the point. `kind="data"` is a
        measurement from one of this project's own upstreams. `kind="web"` is a
        page Google Search returned. Both are sourced, neither is a guess — but
        a reader must never mistake a web page for the ocean analysis, so they
        are labelled differently and rendered differently.
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


def _client():
    if not GEMINI_AVAILABLE:
        raise AssistantUnavailable(
            "The assistant needs a Gemini API key. Add GEMINI_API_KEY to backend/.env "
            "and restart the backend."
        )
    from google import genai  # imported lazily so a missing key never costs an import

    return genai.Client(api_key=GEMINI_API_KEY)


def _retry_delay(message: str) -> float | None:
    """The delay Gemini itself asks for on a 429, if it named one.

    It says "Please retry in 30.6s" in the error body, which is better
    information than any backoff curve we could invent.
    """
    match = re.search(r"retry in ([\d.]+)s", message)
    return float(match.group(1)) if match else None


# Whether Google Search grounding works on this key. Grounding is billed
# separately from generation and is NOT part of the free tier — measured: with
# `google_search` in `tools` every request 429s ("check your plan and billing
# details") while the identical request without it succeeds. So we try it once,
# and if it is refused we stop asking for the life of the process.
#
# Auto-detection matters more than the config flag: the failure is invisible
# from the outside, and without the strip-and-retry a missing grounding quota
# would take down *every* question, ocean ones included, for want of a feature
# only some of them need. `GEMINI_SEARCH=off` just skips the one probe per
# process on a key already known not to have it. Enable billing on the Google
# Cloud project and live answers start working with no code change.
_search_available: bool | None = {"on": True, "off": False}.get(GEMINI_SEARCH)


def _is_quota_error(text: str) -> bool:
    return "429" in text or "RESOURCE_EXHAUSTED" in text.upper()


def _create_with_retry(client: Any, *, on_status: Callable[[str], None] | None, **kwargs: Any):
    """One request, degrading rather than failing where it can.

    Two distinct quota problems are handled here and they are not the same:

    * **Search grounding is not on the free tier.** Detected by retrying without
      it; if that works, the key simply cannot search and we remember it.
    * **Generation is rate limited per minute, per model.** Retried once when
      Gemini names a delay short enough to be worth waiting for.
    """
    global _search_available

    tools = kwargs.get("tools") or []
    wants_search = any(
        isinstance(t, dict) and t.get("type") == "google_search" for t in tools
    )
    if wants_search and _search_available is False:
        kwargs["tools"] = [t for t in tools if not (isinstance(t, dict) and t.get("type") == "google_search")]
        wants_search = False

    for attempt in range(2):
        try:
            response = client.interactions.create(**kwargs)
            if wants_search:
                _search_available = True
            return response
        except Exception as exc:
            text = str(exc)
            if not _is_quota_error(text):
                raise

            # Try without search before blaming the quota: on a free key this is
            # the difference between "cannot answer anything" and "cannot search".
            if wants_search:
                stripped = [
                    t for t in kwargs.get("tools") or []
                    if not (isinstance(t, dict) and t.get("type") == "google_search")
                ]
                try:
                    response = client.interactions.create(**{**kwargs, "tools": stripped})
                except Exception as inner:
                    _search_available = None  # inconclusive; the quota is genuinely out
                    # Read the delay from THIS failure, not the search one. The
                    # search refusal carries no "retry in" hint, so using its text
                    # threw away a perfectly good 35 s wait and told the reader to
                    # "try again shortly" when the code could simply have waited.
                    text = str(inner)
                    wants_search = False
                else:
                    _search_available = False
                    return response

            delay = _retry_delay(text)
            if attempt == 1 or delay is None or delay > 45:
                raise AssistantUnavailable(
                    "The free Gemini quota is used up for the moment "
                    f"({'retry in about ' + str(int(delay)) + ' s' if delay else 'try again shortly'}). "
                    "Nothing else in the app is affected."
                ) from None
            if on_status is not None:
                on_status(f"Rate limited — waiting {int(delay)} s before retrying…")
            time.sleep(delay + 1)
    raise AssistantUnavailable("The assistant could not reach Gemini.")


def search_available() -> bool | None:
    """True, False, or None if it has not been tried yet this process."""
    return _search_available


def _cache_key(name: str, args: dict[str, Any]) -> str:
    """Stable across argument order, so the same question hits the same row."""
    return f"{name}:{json.dumps(args, sort_keys=True, default=str)}"


def _execute(
    name: str,
    args: dict[str, Any],
    state: ScreenState,
    catalogue: list[str],
    store: Any | None,
) -> tuple[Any, dict[str, Any] | None]:
    """Run one tool call. Returns (result_for_model, action_or_None).

    Errors are returned as results rather than raised: the model needs to read
    what went wrong so it can say so or try something else, and a refused
    action is a normal outcome, not an exception.
    """
    if name in ACTION_TOOLS:
        try:
            action = validate_action(name, args, state, catalogue)
        except ActionError as exc:
            return {"ok": False, "error": str(exc)}, None
        return {"ok": True, "applied": action}, action

    fn: Callable | None = READ_TOOLS.get(name)
    if fn is None:
        return {"ok": False, "error": f"There is no {name!r} tool."}, None

    key = _cache_key(name, args)
    if store is not None and name != "get_screen_state":
        cached = store.cache_get(key)
        if cached is not None:
            return cached, None

    try:
        result = fn(state, args)
    except ReadError as exc:
        return {"ok": False, "error": str(exc)}, None
    except Exception as exc:  # an upstream failure must not kill the turn
        return {"ok": False, "error": f"That data could not be read: {exc}"}, None

    if store is not None and name != "get_screen_state":
        store.cache_put(key, result, ttl=ASSISTANT_CACHE_TTL_SECONDS)
    return result, None


def run_turn(
    *,
    history: list[dict[str, Any]],
    state: ScreenState,
    catalogue: list[str],
    mode: str = "ops",
    store: Any | None = None,
    on_status: Callable[[str], None] | None = None,
) -> TurnResult:
    """One user message through to a finished answer.

    `history` is the full transcript in the API's own `input` shape; we hold it
    rather than letting Gemini store it (`store=False`), so nothing about a
    forecaster's session persists on a third-party server.
    """
    client = _client()
    result = TurnResult()
    system = build_system_prompt(mode=mode, state=state, catalogue=catalogue)

    for _ in range(ASSISTANT_MAX_STEPS):
        interaction = _create_with_retry(
            client,
            model=GEMINI_MODEL,
            store=False,
            input=history,
            # Google Search sits alongside the ocean tools rather than replacing
            # them. It is what lets the assistant answer a question this project
            # has no data for — a shipping price, a news event — with a real
            # source instead of a refusal or, worse, a confident guess. Gemini 3
            # allows built-in and custom tools in the same request.
            tools=[{"type": "google_search"}, *DECLARATIONS],
            system_instruction=system,
            on_status=on_status,
        )

        steps = list(getattr(interaction, "steps", None) or [])
        for step in steps:
            history.append(step.model_dump() if hasattr(step, "model_dump") else step)

        for source in _collect_web_sources(interaction):
            if source["url"] not in {s["url"] for s in result.web_sources}:
                result.web_sources.append(source)

        if any(getattr(s, "type", None) == "google_search_call" for s in steps) and on_status:
            on_status("Searching the web…")

        calls = [s for s in steps if getattr(s, "type", None) == "function_call"]
        if not calls:
            result.text = getattr(interaction, "output_text", "") or ""
            return result

        for call in calls:
            name = getattr(call, "name", "")
            args = getattr(call, "arguments", None) or {}
            if isinstance(args, str):  # never string-match a serialized argument
                args = json.loads(args)

            if on_status is not None:
                on_status(_status_line(name, args))

            payload, action = _execute(name, args, state, catalogue, store)
            result.tool_calls.append({"name": name, "arguments": args, "result": payload})
            if action is not None:
                result.actions.append(action)

            history.append(
                {
                    "type": "function_result",
                    "name": name,
                    "call_id": getattr(call, "id", None),
                    "result": [{"type": "text", "text": json.dumps(payload, default=str)}],
                }
            )

    # Ran out of rounds. Say so rather than presenting a half-finished answer.
    result.text = (
        "I could not finish that in the number of steps allowed. "
        "Try asking for one thing at a time."
    )
    return result


def _collect_web_sources(interaction: Any) -> list[dict[str, Any]]:
    """Pull the pages Google Search actually returned out of an interaction.

    The API attaches `url_citation` annotations to the text it grounded. We read
    them rather than trusting the prose, for the same reason the ocean citations
    are built from tool calls: a source the reader can click is a claim they can
    check, and anything else is just more text.

    Written defensively — annotations appear on steps or on their content blocks
    depending on the shape returned, and an unfamiliar variant should cost the
    sources, not the answer.
    """
    found: dict[str, dict[str, Any]] = {}

    def absorb(annotations: Any) -> None:
        for ann in annotations or []:
            if getattr(ann, "type", None) != "url_citation":
                continue
            url = getattr(ann, "url", None)
            if not url:
                continue
            found.setdefault(url, {"url": url, "title": getattr(ann, "title", None) or url})

    for step in getattr(interaction, "steps", None) or []:
        absorb(getattr(step, "annotations", None))
        for block in getattr(step, "content", None) or []:
            absorb(getattr(block, "annotations", None))
    return list(found.values())


def _status_line(name: str, args: dict[str, Any]) -> str:
    """What the panel shows while a tool runs. §5.3: name what is loading."""
    if name == "query_point":
        return f"Reading the analysis at {args.get('lat')}°, {args.get('lon')}°…"
    if name == "compare_float":
        return f"Comparing float {args.get('platform_id')} against the model…"
    if name == "list_floats":
        return "Finding floats reporting in this window…"
    if name == "get_screen_state":
        return "Reading layer state…"
    if name == "search_variables":
        return "Checking the variable catalogue…"
    return "Updating the view…"
