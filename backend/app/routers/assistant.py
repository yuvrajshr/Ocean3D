"""Assistant endpoint.

Streams Server-Sent Events so the panel can show what it's doing while tools run.

Events, in order:

  status  {"text": "..."}      zero or more, one per tool call
  answer  {"text": "..."}      exactly one, the reply
  done    {"actions": [...], "citations": [...], "message_id": "..."}
  error   {"text": "..."}      instead of answer/done if the turn failed

Actions only come in ``done`` so the view doesn't change mid-sentence.
"""

from __future__ import annotations

import json
import queue
import threading
import time
from typing import Any, Iterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..assistant import gemini_client
from ..assistant.store import SqliteConversationStore
from ..assistant.tools import ScreenState
from ..config import ASSISTANT_DB, ASSISTANT_HISTORY_MESSAGES, GEMINI_MODEL, MAP_DATASETS

router = APIRouter()

_store = SqliteConversationStore(ASSISTANT_DB)


def _catalogue_keys() -> list[str]:
    return sorted({d.variable_key for d in MAP_DATASETS if d.variable_key})


class MessageRequest(BaseModel):
    message: str
    conversation_id: str | None = None
    # State of every view: { view, map, globe, chunk }. Parsed leniently so an older
    # client still works, and so the loop can switch views mid-turn.
    state: dict[str, Any] = Field(default_factory=dict)


class StatusResponse(BaseModel):
    available: bool
    model: str | None = None
    reason: str | None = None


@router.get("/assistant/status", response_model=StatusResponse)
def status() -> StatusResponse:
    """Whether the assistant is available. Without a key the button is disabled with
    a reason.
    """
    if not gemini_client.is_available():
        return StatusResponse(
            available=False,
            reason="No Gemini API key configured. Add GEMINI_API_KEY to backend/.env.",
        )
    # Check whether the key can use Google Search now, before the first question.
    gemini_client.start_search_probe()
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
    """Send a message, streaming progress back."""
    started = time.perf_counter()
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

    # Rebuild the history ourselves (store=False) so nothing persists on Google's side.
    history: list[dict[str, Any]] = [
        {
            "type": "user_input" if m.role == "user" else "model_output",
            "content": [{"type": "text", "text": m.content}],
        }
        # Only recent turns; they're resent every round.
        for m in _store.get_messages(conversation_id)[-ASSISTANT_HISTORY_MESSAGES:]
    ]

    state = ScreenState.from_payload(req.state)
    catalogue = _catalogue_keys()

    def stream() -> Iterator[str]:
        # The turn blocks, so run it on a worker thread and stream status lines from here.
        events: queue.Queue = queue.Queue()
        box: dict[str, Any] = {}

        def work() -> None:
            try:
                box["result"] = gemini_client.run_turn(
                    history=history,
                    state=state,
                    catalogue=catalogue,
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
                # Server-side timing, request to answer.
                "timing": {
                    "total_ms": round((time.perf_counter() - started) * 1000),
                    "rounds": result.rounds,
                    "model": result.model,
                },
            },
        )

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        # Stop proxies from buffering the stream.
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
