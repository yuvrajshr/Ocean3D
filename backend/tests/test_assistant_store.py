"""Conversation store and analysis cache, against a temp database. No network or
Gemini. The stored tool calls are the record of where each number came from.
"""

from __future__ import annotations

import pytest

from app.assistant.store import SqliteConversationStore


@pytest.fixture()
def store(tmp_path):
    return SqliteConversationStore(tmp_path / "assistant.db")


# --- Conversations and messages ---

def test_creates_a_conversation_and_reads_it_back(store) -> None:
    cid = store.create_conversation(title="Cold wake check")
    convos = store.list_conversations()
    assert [c.id for c in convos] == [cid]
    assert convos[0].title == "Cold wake check"


def test_messages_come_back_in_the_order_they_were_written(store) -> None:
    cid = store.create_conversation(title="t")
    store.append_message(cid, role="user", content="add chlorophyll")
    store.append_message(cid, role="assistant", content="Added chlorophyll.")
    store.append_message(cid, role="user", content="now hide temperature")

    roles = [m.role for m in store.get_messages(cid)]
    assert roles == ["user", "assistant", "user"], "history order drives the model's context"


def test_conversations_are_isolated_from_each_other(store) -> None:
    a = store.create_conversation(title="a")
    b = store.create_conversation(title="b")
    store.append_message(a, role="user", content="only in a")

    assert len(store.get_messages(a)) == 1
    assert store.get_messages(b) == []


def test_listing_puts_the_most_recent_conversation_first(store) -> None:
    first = store.create_conversation(title="older")
    second = store.create_conversation(title="newer")
    assert [c.id for c in store.list_conversations()] == [second, first]


# --- Tool calls ---

def test_tool_calls_are_persisted_against_their_message(store) -> None:
    cid = store.create_conversation(title="t")
    mid = store.append_message(
        cid,
        role="assistant",
        content="29.1 degC at the surface.",
        tool_calls=[
            {
                "name": "query_point",
                "arguments": {"lat": 15.0, "lon": 88.0, "depth": 0},
                "result": {"value": 29.1, "units": "degC", "dataset": "GLORYS12V1"},
            }
        ],
    )

    calls = store.get_tool_calls(mid)
    assert len(calls) == 1
    assert calls[0].name == "query_point"
    assert calls[0].arguments["lat"] == 15.0
    assert calls[0].result["dataset"] == "GLORYS12V1", "provenance must survive the round trip"


def test_an_answer_with_no_tool_calls_records_none(store) -> None:
    """A general-knowledge answer has no tool calls to cite."""
    cid = store.create_conversation(title="t")
    mid = store.append_message(cid, role="assistant", content="The D26 isotherm is ...")
    assert store.get_tool_calls(mid) == []


# --- Analysis cache ---

def test_cache_returns_what_was_put_in(store) -> None:
    store.cache_put("query_point:15,88,0", {"value": 29.1}, ttl=60)
    assert store.cache_get("query_point:15,88,0") == {"value": 29.1}


def test_cache_misses_on_an_unknown_key(store) -> None:
    assert store.cache_get("never-written") is None


def test_cache_entry_expires(store) -> None:
    store.cache_put("k", {"value": 1}, ttl=-1)  # already expired
    assert store.cache_get("k") is None, "an expired entry must not be served"


def test_cache_put_overwrites_rather_than_duplicating(store) -> None:
    store.cache_put("k", {"value": 1}, ttl=60)
    store.cache_put("k", {"value": 2}, ttl=60)
    assert store.cache_get("k") == {"value": 2}


# --- Durability ---

def test_data_survives_reopening_the_database(tmp_path) -> None:
    path = tmp_path / "assistant.db"
    first = SqliteConversationStore(path)
    cid = first.create_conversation(title="persisted")
    first.append_message(cid, role="user", content="hello")

    second = SqliteConversationStore(path)
    assert [c.title for c in second.list_conversations()] == ["persisted"]
    assert [m.content for m in second.get_messages(cid)] == ["hello"]
