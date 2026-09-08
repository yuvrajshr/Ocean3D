"""The assistant endpoint.

Streams as Server-Sent Events so the panel can say what is happening while the
tool phase runs — context.md §5.3 asks loading states to name what is loading,
and "Reading the analysis at 15°, 88°…" is a great deal more honest than a
spinner.

Event types, in the order a client sees them:

    status  {"text": "..."}      zero or more, one per tool call
    answer  {"text": "..."}      exactly one, the prose
    done    {"actions": [...], "citations": [...], "message_id": "..."}
    error   {"text": "..."}      instead of answer/done, if the turn failed

Actions arrive only in `done`, so the client applies them after the prose has
landed and the viewport never lurches mid-sentence.
"""

from __future__ import annotations

import json
import queue
import threading
from typing import Any, Iterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..assistant import gemini_client
from ..assistant.store import SqliteConversationStore
from ..assistant.tools import ScreenState
from ..config import ASSISTANT_DB, GEMINI_MODEL, MAP_DATASETS

router = APIRouter()

_store = SqliteConversationStore(ASSISTANT_DB)


def _catalogue_keys() -> list[str]:
    return sorted({d.variable_key for d in MAP_DATASETS if d.variable_key})


class ScreenStatePayload(BaseModel):
    """What the client says is on screen. Actions are validated against this."""

    view: str = "map"
    mode: str = "ops"
    layers: list[dict[str, Any]] = Field(default_factory=list)
    time: str = ""
    depth_index: int = 0
    depth_m: float = 0.0


class MessageRequest(BaseModel):
    message: str
    conversation_id: str | None = None
    state: ScreenStatePayload = Field(default_factory=ScreenStatePayload)


class StatusResponse(BaseModel):
    available: bool
    model: str | None = None
    reason: str | None = None


@router.get("/assistant/status", response_model=StatusResponse)
def status() -> StatusResponse:
    """Whether the assistant can run at all.

    The dock button reads this. With no key it renders disabled with a stated
    reason rather than failing on click — the same degradation the Copernicus
    layers already have.
    """
    if not gemini_client.is_available():
        return StatusResponse(
            available=False,
            reason="No Gemini API key configured. Add GEMINI_API_KEY to backend/.env.",
        )
    return StatusResponse(available=True, model=GEMINI_MODEL)


@router.get("/assistant/conversations")
def list_conversations() -> list[dict[str, Any]]:
    return [
        {"id": c.id, "title": c.title, "created_at": c.created_at}
        for c in _store.list_conversations()
    ]


@router.get("/assistant/conversations/{conversation_id}")
def get_conversation(conversation_id: str) -> dict[str, Any]:
    messages = _store.get_messages(conversation_id)
    if not messages:
        raise HTTPException(404, "No conversation with that id.")
    return {
        "id": conversation_id,
        "messages": [
            {
                "id": m.id,
                "role": m.role,
                "content": m.content,
                "created_at": m.created_at,
                "tool_calls": [
                    {"name": t.name, "arguments": t.arguments, "result": t.result}
                    for t in _store.get_tool_calls(m.id)
                ],
            }
            for m in messages
        ],
    }


def _sse(event: str, payload: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, default=str)}\n\n"


@router.post("/assistant/message")
def message(req: MessageRequest) -> StreamingResponse:
    """Ask the assistant something, streaming progress back as it works."""
    if not gemini_client.is_available():
        raise HTTPException(
            503,
            "The assistant needs a Gemini API key. Add GEMINI_API_KEY to backend/.env "
            "and restart the backend.",
        )

    conversation_id = req.conversation_id or _store.create_conversation(
        title=req.message[:60] or "New conversation"
    )
    _store.append_message(conversation_id, role="user", content=req.message)

    # Rebuild the transcript in the API's own `input` shape. We hold it rather
    # than letting Gemini store it, so nothing about a session persists on a
    # third-party server (store=False in gemini_client).
    history: list[dict[str, Any]] = [
        {
            "type": "user_input" if m.role == "user" else "model_output",
            "content": [{"type": "text", "text": m.content}],
        }
        for m in _store.get_messages(conversation_id)
    ]

    state = ScreenState(**req.state.model_dump())
    catalogue = _catalogue_keys()

    def stream() -> Iterator[str]:
        # The turn is blocking, so it runs on a worker while this generator
        # drains status lines. Without that the panel would sit silent through
        # the slowest part of the request, which is exactly the part worth
        # narrating.
        events: queue.Queue = queue.Queue()
        box: dict[str, Any] = {}

        def work() -> None:
            try:
                box["result"] = gemini_client.run_turn(
                    history=history,
                    state=state,
                    catalogue=catalogue,
                    mode=req.state.mode,
                    store=_store,
                    on_status=lambda text: events.put(("status", {"text": text})),
                )
            except gemini_client.AssistantUnavailable as exc:
                box["error"] = str(exc)
            except Exception as exc:
                box["error"] = f"The assistant could not complete that: {exc}"
            finally:
                events.put((None, None))

        worker = threading.Thread(target=work, daemon=True)
        worker.start()

        while True:
            kind, payload = events.get()
            if kind is None:
                break
            yield _sse(kind, payload)

        worker.join()

        if "error" in box:
            yield _sse("error", {"text": box["error"]})
            return

        result = box["result"]
        yield _sse("answer", {"text": result.text})

        message_id = _store.append_message(
            conversation_id,
            role="assistant",
            content=result.text,
            tool_calls=result.tool_calls,
        )
        yield _sse(
            "done",
            {
                "conversation_id": conversation_id,
                "message_id": message_id,
                "actions": result.actions,
                "citations": result.citations,
            },
        )

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        # Without this an intermediate proxy may buffer the whole response and
        # the status lines all arrive at once, after they stopped being useful.
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
