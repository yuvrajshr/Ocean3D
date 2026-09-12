"""The tool loop: fast by construction, and honest about which view it acts on.

A scripted stand-in replaces Gemini, so these run without a key or a network,
and `time.sleep` fails the test if the loop ever waits blindly. What they pin:

- a pure command costs one request, its sentence composed from the action;
- a view switch hands the next round that view's tools, in the same message;
- a rate-limited model is swapped for the next, not slept on;
- reads run in parallel under a budget and report when still loading.
"""

from __future__ import annotations

import threading
import time
from types import SimpleNamespace

import pytest

from app.assistant import gemini_client
from app.assistant.gemini_client import AssistantUnavailable, ModelChain, run_turn
from app.assistant.tools import ChunkState, MapState, ScreenState

CATALOGUE = ["chlorophyll", "salinity", "temperature"]


class Step:
    def __init__(self, type_: str, **fields) -> None:
        self.type = type_
        self.__dict__.update(fields)

    def model_dump(self) -> dict:
        return dict(self.__dict__)


def call(name: str, **arguments) -> Step:
    return Step("function_call", name=name, arguments=arguments, id=f"call-{name}")


def calls(*steps: Step):
    return SimpleNamespace(steps=list(steps), output_text="")


def reply(text: str):
    return SimpleNamespace(steps=[Step("model_output")], output_text=text)


class FakeClient:
    def __init__(self, script) -> None:
        self.script = list(script)
        self.requests: list[dict] = []

    @property
    def interactions(self):
        return self

    def create(self, **request):
        self.requests.append(request)
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def user(text: str) -> list[dict]:
    return [{"type": "user_input", "content": [{"type": "text", "text": text}]}]


def on_map() -> ScreenState:
    return ScreenState(view="map", map=MapState(
        layers=[{"key": "temperature", "visible": True}], time="2013-10-12T00:00:00Z",
    ))


def declared(request: dict) -> set[str]:
    return {t["name"] for t in request["tools"] if t.get("type") == "function"}


@pytest.fixture
def loop(monkeypatch):
    monkeypatch.setattr(gemini_client, "_chain", ModelChain(["lite", "lite-2", "flash"]))
    monkeypatch.setattr(gemini_client, "_search_available", False)
    monkeypatch.setattr(gemini_client, "_thinking_refused", set())
    monkeypatch.setattr(gemini_client.time, "sleep", lambda s: pytest.fail(f"the loop slept {s} s"))

    def install(script) -> FakeClient:
        fake = FakeClient(script)
        monkeypatch.setattr(gemini_client, "_client", lambda: fake)
        return fake

    return install


def test_a_pure_command_costs_one_request(loop):
    fake = loop([calls(call("set_layers", add=["salinity"]))])
    result = run_turn(history=user("add salinity"), state=on_map(), catalogue=CATALOGUE)
    assert len(fake.requests) == 1
    assert result.text == "Added salinity."
    assert result.actions[0]["scope"] == "map"


def in_chunk() -> ScreenState:
    return ScreenState(view="chunk", chunk=ChunkState(
        mounted=True, bbox=[85.0, 10.0, 90.0, 15.0], variable="temperature",
        time="2013-10-07", window=["2013-09-25", "2013-10-24"],
    ))


def test_a_question_is_not_cut_short_by_an_action_in_its_first_round(loop):
    # Found live, 2026-09-10: "What is the temperature at 100 m here?" drew a
    # show_variable first, and the one-round shortcut ended the turn with
    # "Showing temperature." — the question was never answered.
    fake = loop([calls(call("set_display", mode="slices")), reply("23.95 °C at 100 m on 7 Oct 2013.")])
    result = run_turn(history=user("What is the temperature at 100 m here?"), state=in_chunk(), catalogue=CATALOGUE)
    assert len(fake.requests) == 2
    assert result.text == "23.95 °C at 100 m on 7 Oct 2013."


@pytest.mark.parametrize("command", ["Show salinity", "switch to the isosurface", "Top-down view please"])
def test_a_command_still_ends_after_one_round(loop, command):
    fake = loop([calls(call("set_camera", preset="top"))])
    run_turn(history=user(command), state=in_chunk(), catalogue=CATALOGUE)
    assert len(fake.requests) == 1


def test_switching_view_hands_the_next_round_that_views_tools(loop):
    fake = loop([
        calls(call("open_chunk", region="Bay of Bengal")),
        calls(call("show_variable", variable="salinity")),
    ])
    result = run_turn(
        history=user("open the chunk over the Bay of Bengal and show salinity"),
        state=on_map(), catalogue=CATALOGUE,
    )
    assert len(fake.requests) == 2
    assert "set_layers" in declared(fake.requests[0])
    assert "show_variable" in declared(fake.requests[1]) and "set_layers" not in declared(fake.requests[1])
    assert [a["scope"] for a in result.actions] == ["map", "chunk"]
    assert result.text == "Opened the chunk over Bay of Bengal. Showing salinity."


def test_a_control_from_another_view_is_refused_and_explained(loop):
    fake = loop([calls(call("show_variable", variable="salinity")), reply("That is a chunk control.")])
    result = run_turn(history=user("show salinity"), state=on_map(), catalogue=CATALOGUE)
    assert len(fake.requests) == 2, "a refusal needs the model to explain it"
    assert result.actions == []
    assert result.tool_calls[0]["result"]["ok"] is False
    assert result.text == "That is a chunk control."


def test_a_rate_limited_model_is_swapped_not_slept_on(loop, monkeypatch):
    fake = loop([RuntimeError("429 RESOURCE_EXHAUSTED. Please retry in 30s."), reply("Hello.")])
    result = run_turn(history=user("hi"), state=on_map(), catalogue=CATALOGUE)
    assert [r["model"] for r in fake.requests] == ["lite", "lite-2"]
    assert result.text == "Hello." and result.model == "lite-2"

    # The next turn does not ask the cooled model again.
    again = FakeClient([reply("Again.")])
    monkeypatch.setattr(gemini_client, "_client", lambda: again)
    run_turn(history=user("hi"), state=on_map(), catalogue=CATALOGUE)
    assert again.requests[0]["model"] == "lite-2"


def test_when_every_model_is_out_it_says_so_instead_of_waiting(loop):
    loop([RuntimeError("429 retry in 50s")] * 3)
    with pytest.raises(AssistantUnavailable) as e:
        run_turn(history=user("hi"), state=on_map(), catalogue=CATALOGUE)
    assert "rate limited" in str(e.value)


def test_a_model_that_refuses_the_thinking_level_is_asked_without_it(loop):
    fake = loop([RuntimeError("400 INVALID_ARGUMENT: thinking_level is not supported"), reply("ok")])
    run_turn(history=user("hi"), state=on_map(), catalogue=CATALOGUE)
    assert "generation_config" in fake.requests[0]
    assert fake.requests[1]["model"] == "lite" and "generation_config" not in fake.requests[1]


def test_every_request_carries_the_thinking_level_and_a_timeout(loop):
    fake = loop([reply("ok")])
    run_turn(history=user("hi"), state=on_map(), catalogue=CATALOGUE)
    request = fake.requests[0]
    assert request["generation_config"] == {"thinking_level": gemini_client.GEMINI_THINKING}
    assert request["timeout"] == gemini_client.GEMINI_TIMEOUT_SECONDS


def test_reads_in_one_round_run_in_parallel(loop, monkeypatch):
    def slowish(_state, args):
        threading.Event().wait(0.3)
        return {"value": args["lat"], "provenance": {"dataset": "x"}}

    monkeypatch.setitem(gemini_client.READ_TOOLS, "query_point", slowish)
    fake = loop([calls(call("query_point", lat=1, lon=1), call("query_point", lat=2, lon=2)), reply("ok")])
    started = time.perf_counter()
    result = run_turn(history=user("two points"), state=on_map(), catalogue=CATALOGUE)
    assert time.perf_counter() - started < 0.55, "two 0.3 s reads must overlap"
    assert [c["result"]["value"] for c in result.tool_calls] == [1, 2]
    assert len(fake.requests) == 2


def test_a_read_past_its_budget_reports_still_loading(loop, monkeypatch):
    def slow(_state, _args):
        threading.Event().wait(0.5)
        return {"value": 1}

    monkeypatch.setattr(gemini_client, "ASSISTANT_READ_BUDGET_SECONDS", 0.05)
    monkeypatch.setitem(gemini_client.READ_TOOLS, "query_point", slow)
    loop([calls(call("query_point", lat=15, lon=88)), reply("Still loading — ask again.")])
    result = run_turn(history=user("sst"), state=on_map(), catalogue=CATALOGUE)
    assert result.tool_calls[0]["result"]["pending"] is True
    assert result.text == "Still loading — ask again."


# --------------------------------------------------------------------------
# The router's view of the screen
# --------------------------------------------------------------------------

def test_the_payload_tolerates_missing_blocks_and_unknown_keys():
    state = ScreenState.from_payload({"view": "chunk", "chunk": {"variable": "salinity", "bogus": 1}})
    assert state.view == "chunk" and state.chunk.variable == "salinity" and state.map.layers == []
    assert ScreenState.from_payload({"view": "column"}).view == "map"
    assert ScreenState.from_payload(None).view == "map"


def test_a_read_cached_under_an_older_result_shape_is_not_served(loop, monkeypatch):
    # Found live, 2026-09-12: after compare_float gained its provenance block,
    # the server kept answering from rows cached by the old code — for up to a
    # day — so the citation fix was invisible. The key must carry the shape.
    from app.assistant import reads

    class Store:
        def __init__(self):
            self.rows: dict[str, object] = {}

        def cache_get(self, key):
            return self.rows.get(key)

        def cache_put(self, key, value, ttl):
            self.rows[key] = value

    store = Store()
    fresh = {"value": 2, "provenance": {"dataset": "new"}}
    monkeypatch.setitem(gemini_client.READ_TOOLS, "query_point", lambda _s, _a: fresh)

    # A row written under the previous shape version, for exactly this call.
    monkeypatch.setattr(reads, "RESULT_VERSION", reads.RESULT_VERSION - 1)
    old_key = gemini_client._cache_key("query_point", {"lat": 1, "lon": 1}, reads.cache_context("query_point", on_map()))
    store.rows[old_key] = {"value": 1}  # stale: no provenance
    monkeypatch.setattr(reads, "RESULT_VERSION", reads.RESULT_VERSION + 1)

    loop([calls(call("query_point", lat=1, lon=1)), reply("2.")])
    result = run_turn(history=user("value?"), state=on_map(), catalogue=CATALOGUE, store=store)
    assert result.tool_calls[0]["result"] == fresh
    assert result.citations and result.citations[0]["dataset"] == "new"
