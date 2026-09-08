"""Conversation persistence and the analysis cache.

SQLite, not a hosted database. context.md §1 requires the app be deployable on
INCOIS infrastructure, and a cloud database is an outbound dependency a
government network may refuse; §4 already sanctions "SQLite for demo". This
adds no infrastructure, no credentials and no new failure mode.

The `ConversationStore` protocol is the seam that keeps that decision cheap to
reverse: swapping in Postgres or Supabase later means writing one more class,
not rewriting the router. Same shape as the `DataSource` protocol in
`ingestion/base.py`, and for the same reason.

Connections are opened per operation rather than held. The workload is one
analyst asking questions, so the simplicity is worth more than the handful of
microseconds a pooled connection would save, and it sidesteps SQLite's
thread-affinity rules under an async server entirely.
"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

_SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    created_at      REAL NOT NULL,
    seq             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, seq);

-- The audit trail behind every stated number. Without this the grounding rule
-- is only a claim; with it, any answer can be checked against what was fetched.
CREATE TABLE IF NOT EXISTS tool_calls (
    id             TEXT PRIMARY KEY,
    message_id     TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    arguments_json TEXT NOT NULL,
    result_json    TEXT NOT NULL,
    created_at     REAL NOT NULL,
    seq            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_message ON tool_calls(message_id, seq);

CREATE TABLE IF NOT EXISTS analysis_cache (
    key_hash    TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    created_at  REAL NOT NULL,
    expires_at  REAL NOT NULL
);
"""


@dataclass(frozen=True)
class Conversation:
    id: str
    title: str
    created_at: float


@dataclass(frozen=True)
class Message:
    id: str
    conversation_id: str
    role: str
    content: str
    created_at: float


@dataclass(frozen=True)
class ToolCall:
    name: str
    arguments: dict[str, Any]
    result: Any
    created_at: float = field(default=0.0, compare=False)


@runtime_checkable
class ConversationStore(Protocol):
    """Everything the assistant router needs from persistence.

    Implement this to move the assistant onto Postgres, Supabase or anything
    else; nothing above this line knows which one it is talking to.
    """

    def create_conversation(self, *, title: str) -> str: ...

    def list_conversations(self, *, limit: int = 50) -> list[Conversation]: ...

    def get_messages(self, conversation_id: str) -> list[Message]: ...

    def append_message(
        self,
        conversation_id: str,
        *,
        role: str,
        content: str,
        tool_calls: list[dict[str, Any]] | None = None,
    ) -> str: ...

    def get_tool_calls(self, message_id: str) -> list[ToolCall]: ...

    def cache_get(self, key: str) -> Any | None: ...

    def cache_put(self, key: str, value: Any, *, ttl: float) -> None: ...


class SqliteConversationStore:
    """The default `ConversationStore`, backed by a file on disk."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(_SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        # Off by default in SQLite, and the schema above depends on it to clean
        # up messages and tool calls when a conversation goes.
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    # ---------------------------------------------------------------- writes

    def create_conversation(self, *, title: str) -> str:
        cid = uuid.uuid4().hex
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO conversations (id, title, created_at) VALUES (?, ?, ?)",
                (cid, title, time.time()),
            )
        return cid

    def append_message(
        self,
        conversation_id: str,
        *,
        role: str,
        content: str,
        tool_calls: list[dict[str, Any]] | None = None,
    ) -> str:
        mid = uuid.uuid4().hex
        now = time.time()
        with self._connect() as conn:
            # `seq` rather than `created_at` for ordering: two messages written
            # in the same turn can share a timestamp at this clock resolution,
            # and history order is what the model reads as context.
            row = conn.execute(
                "SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM messages WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
            conn.execute(
                "INSERT INTO messages (id, conversation_id, role, content, created_at, seq)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (mid, conversation_id, role, content, now, row["next"]),
            )
            for i, call in enumerate(tool_calls or []):
                conn.execute(
                    "INSERT INTO tool_calls"
                    " (id, message_id, name, arguments_json, result_json, created_at, seq)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        uuid.uuid4().hex,
                        mid,
                        call["name"],
                        json.dumps(call.get("arguments", {})),
                        json.dumps(call.get("result")),
                        now,
                        i,
                    ),
                )
        return mid

    # ----------------------------------------------------------------- reads

    def list_conversations(self, *, limit: int = 50) -> list[Conversation]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, title, created_at FROM conversations"
                " ORDER BY created_at DESC, rowid DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [Conversation(r["id"], r["title"], r["created_at"]) for r in rows]

    def get_messages(self, conversation_id: str) -> list[Message]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, conversation_id, role, content, created_at FROM messages"
                " WHERE conversation_id = ? ORDER BY seq",
                (conversation_id,),
            ).fetchall()
        return [
            Message(r["id"], r["conversation_id"], r["role"], r["content"], r["created_at"])
            for r in rows
        ]

    def get_tool_calls(self, message_id: str) -> list[ToolCall]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT name, arguments_json, result_json, created_at FROM tool_calls"
                " WHERE message_id = ? ORDER BY seq",
                (message_id,),
            ).fetchall()
        return [
            ToolCall(
                name=r["name"],
                arguments=json.loads(r["arguments_json"]),
                result=json.loads(r["result_json"]),
                created_at=r["created_at"],
            )
            for r in rows
        ]

    # ----------------------------------------------------------- cache

    def cache_get(self, key: str) -> Any | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT result_json FROM analysis_cache WHERE key_hash = ? AND expires_at > ?",
                (key, time.time()),
            ).fetchone()
        return json.loads(row["result_json"]) if row else None

    def cache_put(self, key: str, value: Any, *, ttl: float) -> None:
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO analysis_cache (key_hash, result_json, created_at, expires_at)"
                " VALUES (?, ?, ?, ?)"
                " ON CONFLICT(key_hash) DO UPDATE SET"
                "   result_json = excluded.result_json,"
                "   created_at  = excluded.created_at,"
                "   expires_at  = excluded.expires_at",
                (key, json.dumps(value), now, now + ttl),
            )
