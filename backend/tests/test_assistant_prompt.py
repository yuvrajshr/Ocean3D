"""The system prompt describes the view on screen, and only that view.

The model is told what it is looking at — for the chunk, the tile, variable,
date and window; for the map, each layer's source and coverage; for the globe,
the window and the floats reporting — and never about a control this turn does
not declare. A prompt that names a tool the model cannot call invites a call
that will be refused, which costs a round.
"""
import pytest

from app.assistant.prompt import build_system_prompt
from app.assistant.tools import (
    ACTION_TOOLS, ChunkState, GlobeState, MapState, ScreenState, tools_for,
)

CATALOGUE = ["chlorophyll", "salinity", "temperature"]


def chunk():
    return ScreenState(view="chunk", chunk=ChunkState(
        mounted=True, bbox=[85.0, 10.0, 90.0, 15.0], variable="temperature",
        time="2013-10-07", window=["2013-09-25", "2013-10-24"],
    ))


def map_():
    return ScreenState(view="map", map=MapState(
        layers=[{"key": "temperature", "visible": True, "provider": "Copernicus Marine GLORYS12V1",
                 "time_start": "1993-01-01", "time_end": "2026-06-23"}],
        time="2013-10-12T00:00:00Z",
        active={"key": "temperature", "depth_m": 0.5, "depth_levels": [0.5, 100.0]},
    ))


def globe():
    return ScreenState(view="globe", globe=GlobeState(
        time="2013-10-11T00:00:00Z", window=["2013-10-01", "2013-10-25"], floats=["2901335", "2901327"],
    ))


def test_the_chunk_prompt_names_the_block_on_screen():
    text = build_system_prompt(state=chunk(), catalogue=CATALOGUE)
    for fact in ("10–15°N", "85–90°E", "temperature", "7 Oct 2013", "24 Oct 2013", "HYCOM"):
        assert fact in text, fact


def test_the_map_prompt_states_each_layers_source_and_coverage():
    text = build_system_prompt(state=map_(), catalogue=CATALOGUE)
    for fact in ("temperature", "Copernicus Marine GLORYS12V1", "1993-01-01", "2026-06-23", "12 Oct 2013"):
        assert fact in text, fact


def test_the_globe_prompt_states_the_window_and_the_floats():
    text = build_system_prompt(state=globe(), catalogue=CATALOGUE)
    for fact in ("1 Oct 2013", "25 Oct 2013", "2901335", "select_float", "compare_float"):
        assert fact in text, fact


@pytest.mark.parametrize("make", [chunk, map_, globe])
def test_no_prompt_names_a_control_its_view_does_not_offer(make):
    state = make()
    text = build_system_prompt(state=state, catalogue=CATALOGUE)
    for name in ACTION_TOOLS - set(tools_for(state.view)):
        assert name not in text, f"{state.view} prompt mentions {name}"
