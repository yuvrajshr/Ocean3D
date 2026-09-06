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
from dataclasses import dataclass, field
from typing import Any, Callable

from ..config import (
    ASSISTANT_CACHE_TTL_SECONDS,
    ASSISTANT_MAX_STEPS,
    GEMINI_API_KEY,
    GEMINI_AVAILABLE,
    GEMINI_MODEL,
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

    @property
    def citations(self) -> list[dict[str, Any]]:
        """Provenance for the answer, built from the reads that actually ran.

        This is the whole grounding mechanism: the panel cites from here, not
        from the prose, so a number the model produced without fetching has
        nothing to show and is marked as general knowledge instead.
        """
        out = []
        for call in self.tool_calls:
            prov = (call.get("result") or {}).get("provenance") if isinstance(call.get("result"), dict) else None
            if prov:
                out.append({"tool": call["name"], **prov})
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

    for _ in range(ASSISTANT_MAX_STEPS):
        interaction = client.interactions.create(
            model=GEMINI_MODEL,
            store=False,
            input=history,
            tools=DECLARATIONS,
            system_instruction=build_system_prompt(mode=mode),
        )

        steps = list(getattr(interaction, "steps", None) or [])
        for step in steps:
            history.append(step.model_dump() if hasattr(step, "model_dump") else step)

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
