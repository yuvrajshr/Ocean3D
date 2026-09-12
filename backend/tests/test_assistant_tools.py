"""Action validation: what the assistant may do, and on which view.

Every action the model proposes is checked against the screen snapshot the
frontend sent, for the view that is on screen, before it is handed back to be
applied. The model therefore gets a truthful success/failure — including "that
is a chunk-view control and the map is on screen" — rather than an optimistic
guess, and an invalid action is refused in one place instead of half-applied.

No network, no Gemini — this is the pure decision layer.
"""

from __future__ import annotations

import pytest

from app.assistant.tools import (
    CHUNK_LAYERS,
    NAMED_REGIONS,
    VIEWS,
    ActionError,
    ChunkState,
    GlobeState,
    MapState,
    ScreenState,
    advance_state,
    declarations_for,
    describe_actions,
    tools_for,
    validate_action,
)

CATALOGUE = ["temperature", "salinity", "currents", "chlorophyll", "mixed_layer_depth"]

TEMPERATURE = {
    "key": "temperature",
    "visible": True,
    "opacity": 1.0,
    "provider": "Copernicus Marine GLORYS12V1",
    "time_start": "1993-01-01",
    "time_end": "2026-06-23",
}
LEVELS = [0.5, 10.0, 50.0, 100.0, 200.0, 500.0, 1000.0, 2000.0]


def map_state(**over) -> ScreenState:
    m = dict(
        layers=[dict(TEMPERATURE)],
        time="2013-10-10T00:00:00Z",
        active={"key": "temperature", "depth_m": 0.5, "depth_levels": LEVELS},
    )
    m.update(over)
    return ScreenState(view="map", map=MapState(**m))


def globe_state(**over) -> ScreenState:
    g = dict(
        time="2013-10-10T00:00:00Z",
        window=["2013-10-01", "2013-10-25"],
        floats=["2901335", "2901327"],
    )
    g.update(over)
    return ScreenState(view="globe", globe=GlobeState(**g))


def chunk_state(**over) -> ScreenState:
    c = dict(
        mounted=True,
        bbox=[85.0, 10.0, 90.0, 15.0],
        variable="temperature",
        time="2013-10-07",
        window=["2013-09-25", "2013-10-24"],
    )
    c.update(over)
    return ScreenState(view="chunk", chunk=ChunkState(**c))


def act(name, args, state):
    return validate_action(name, args, state, CATALOGUE)


# --------------------------------------------------------------------------
# Scope — the reason this file was rewritten
# --------------------------------------------------------------------------

def test_every_action_is_tagged_with_the_view_it_was_validated_for():
    assert act("set_layers", {"add": ["salinity"]}, map_state())["scope"] == "map"
    assert act("show_variable", {"variable": "salinity"}, chunk_state())["scope"] == "chunk"
    assert act("clear_selection", {}, globe_state())["scope"] == "globe"


def test_a_chunk_control_is_refused_while_the_map_is_on_screen():
    with pytest.raises(ActionError) as e:
        act("show_variable", {"variable": "salinity"}, map_state())
    assert "chunk" in str(e.value) and "map" in str(e.value)


def test_a_map_control_is_refused_inside_the_chunk():
    with pytest.raises(ActionError) as e:
        act("set_layers", {"add": ["salinity"]}, chunk_state())
    assert "map" in str(e.value)


def test_each_view_declares_only_its_own_controls():
    chunk = set(tools_for("chunk"))
    assert {"show_variable", "set_display", "describe_chunk", "set_view"} <= chunk
    assert "set_layers" not in chunk and "select_float" not in chunk
    assert "show_variable" not in tools_for("map")
    assert "select_float" in tools_for("globe")
    for view in VIEWS:
        declared = {d["name"] for d in declarations_for(view)}
        assert declared == set(tools_for(view)), view


# --------------------------------------------------------------------------
# Map — layers
# --------------------------------------------------------------------------

def test_adds_a_layer_and_hides_another_in_one_action():
    action = act("set_layers", {"add": ["chlorophyll"], "hide": ["temperature"]}, map_state())
    assert action["type"] == "set_layers"
    assert action["add"] == ["chlorophyll"] and action["hide"] == ["temperature"]


def test_refuses_a_variable_the_catalogue_does_not_serve():
    with pytest.raises(ActionError) as e:
        act("set_layers", {"add": ["unobtanium"]}, map_state())
    assert "unobtanium" in str(e.value)


def test_refuses_to_exceed_the_three_layer_cap():
    full = map_state(layers=[
        dict(TEMPERATURE),
        {"key": "salinity", "visible": True},
        {"key": "currents", "visible": True},
    ])
    with pytest.raises(ActionError) as e:
        act("set_layers", {"add": ["chlorophyll"]}, full)
    assert "3" in str(e.value)


def test_adding_a_layer_already_present_is_not_an_error():
    assert act("set_layers", {"add": ["temperature"]}, map_state())["add"] == []


def test_refuses_to_hide_a_layer_that_is_not_there():
    with pytest.raises(ActionError):
        act("set_layers", {"hide": ["chlorophyll"]}, map_state())


def test_opacity_must_be_a_fraction():
    with pytest.raises(ActionError):
        act("set_layers", {"opacity": {"temperature": 250}}, map_state())


# --------------------------------------------------------------------------
# Map — time and depth
# --------------------------------------------------------------------------

def test_map_time_inside_a_visible_layer_is_accepted():
    assert act("set_time", {"time": "2013-10-12"}, map_state())["time"].startswith("2013-10-12")


def test_map_time_no_layer_covers_is_refused_with_the_coverage():
    with pytest.raises(ActionError) as e:
        act("set_time", {"time": "2027-01-01"}, map_state())
    assert "2026-06-23" in str(e.value)


def test_map_time_with_no_layers_is_accepted():
    assert act("set_time", {"time": "2013-10-12"}, map_state(layers=[]))


def test_refuses_an_unparseable_time():
    with pytest.raises(ActionError):
        act("set_time", {"time": "last tuesday"}, map_state())


def test_map_depth_snaps_to_the_active_layers_nearest_real_level():
    action = act("set_depth", {"depth_m": 90}, map_state())
    assert action["depth_m"] == 100.0 and action["depth_index"] == LEVELS.index(100.0)


def test_map_depth_is_refused_for_a_surface_layer():
    state = map_state(active={"key": "chlorophyll", "depth_m": None, "depth_levels": None})
    with pytest.raises(ActionError) as e:
        act("set_depth", {"depth_m": 50}, state)
    assert "surface" in str(e.value)


def test_map_depth_below_the_grid_is_refused():
    with pytest.raises(ActionError):
        act("set_depth", {"depth_m": 9000}, map_state())


# --------------------------------------------------------------------------
# Map — navigation: coordinates the model must never invent
# --------------------------------------------------------------------------

def test_zooms_to_a_named_region_from_the_table():
    action = act("zoom_to_region", {"region": "BAY OF BENGAL"}, map_state())
    assert action["lat_range"] == list(NAMED_REGIONS["bay of bengal"]["lat_range"])


def test_refuses_an_unknown_region_rather_than_guessing_coordinates():
    with pytest.raises(ActionError) as e:
        act("zoom_to_region", {"region": "Atlantis"}, map_state())
    assert "Atlantis" in str(e.value)


def test_pin_coordinates_must_be_on_the_planet():
    assert act("set_pin", {"lat": 15, "lon": 88}, map_state())
    with pytest.raises(ActionError):
        act("set_pin", {"lat": 200, "lon": 88}, map_state())


def test_area_ranges_must_be_ordered():
    with pytest.raises(ActionError):
        act("set_area", {"lat_range": [20, 5], "lon_range": [80, 95]}, map_state())


# --------------------------------------------------------------------------
# Common — views and chunks
# --------------------------------------------------------------------------

def test_switches_between_the_three_real_views():
    for view in VIEWS:
        assert act("set_view", {"view": view}, map_state())["view"] == view


def test_refuses_a_view_that_does_not_exist():
    for bad in ("orbital", "column"):
        with pytest.raises(ActionError):
            act("set_view", {"view": bad}, map_state())


def test_open_chunk_by_named_region_or_stated_coordinates():
    action = act("open_chunk", {"region": "Bay of Bengal"}, map_state())
    assert 5.0 <= action["lat"] <= 23.0 and 78.0 <= action["lon"] <= 95.0
    by_point = act("open_chunk", {"lat": 12.5, "lon": 87.5}, globe_state())
    assert (by_point["lat"], by_point["lon"]) == (12.5, 87.5)
    with pytest.raises(ActionError):
        act("open_chunk", {"region": "Atlantis"}, map_state())


# --------------------------------------------------------------------------
# Globe
# --------------------------------------------------------------------------

def test_globe_time_outside_the_scenario_window_is_refused():
    assert act("set_time", {"time": "2013-10-12"}, globe_state())
    with pytest.raises(ActionError) as e:
        act("set_time", {"time": "2014-01-01"}, globe_state())
    assert "2013-10-25" in str(e.value)


def test_select_float_only_for_one_that_is_reporting():
    assert act("select_float", {"platform_id": "2901335"}, globe_state())["platform_id"] == "2901335"
    with pytest.raises(ActionError) as e:
        act("select_float", {"platform_id": "9999999"}, globe_state())
    assert "2901335" in str(e.value), "the refusal names the floats that are reporting"
    with pytest.raises(ActionError):
        act("select_float", {"platform_id": "2901335"}, globe_state(floats=[]))


# --------------------------------------------------------------------------
# Chunk
# --------------------------------------------------------------------------

def test_show_variable_accepts_the_names_a_reader_uses():
    assert act("show_variable", {"variable": "current speed"}, chunk_state())["variable"] == "speed"
    assert act("show_variable", {"variable": "Salinity"}, chunk_state())["variable"] == "salinity"
    with pytest.raises(ActionError):
        act("show_variable", {"variable": "oxygen"}, chunk_state())


def test_chunk_time_must_lie_in_the_window():
    assert act("set_time", {"time": "2013-10-11"}, chunk_state())["time"] == "2013-10-11"
    with pytest.raises(ActionError) as e:
        act("set_time", {"time": "2013-11-30"}, chunk_state())
    assert "24 Oct 2013" in str(e.value)


def test_display_modes_need_a_depth_axis():
    assert act("set_display", {"mode": "iso"}, chunk_state())["mode"] == "isosurface"
    with pytest.raises(ActionError) as e:
        act("set_display", {"mode": "volume"}, chunk_state(variable="chlorophyll"))
    assert "surface" in str(e.value)


def test_a_cut_must_lie_inside_the_tile():
    assert act("set_cut", {"axis": "lon", "value": 87.5}, chunk_state())["axis"] == "lon"
    with pytest.raises(ActionError):
        act("set_cut", {"axis": "lon", "value": 95}, chunk_state())
    with pytest.raises(ActionError):
        act("set_cut", {"axis": "depth", "value": 5000}, chunk_state())


def test_isovalue_must_be_physically_plausible():
    assert act("set_iso_value", {"value": 20}, chunk_state())["value"] == 20.0
    with pytest.raises(ActionError):
        act("set_iso_value", {"value": 80}, chunk_state())


def test_exaggeration_follows_the_chunks_own_slider():
    assert act("set_exaggeration", {"value": 100}, chunk_state())["value"] == 100.0
    with pytest.raises(ActionError):
        act("set_exaggeration", {"value": 500}, chunk_state())


def test_camera_presets_accept_their_labels():
    assert act("set_camera", {"preset": "top-down"}, chunk_state())["preset"] == "top"


def test_layers_are_the_three_the_chunk_still_has():
    assert set(CHUNK_LAYERS) == {"scalar", "currents", "bathy"}
    assert act("set_layer", {"layer": "bathymetry", "visible": False}, chunk_state())["layer"] == "bathy"
    with pytest.raises(ActionError):
        act("set_layer", {"layer": "instruments", "visible": False}, chunk_state())
    with pytest.raises(ActionError):
        act("set_layer", {"layer": "currents"}, chunk_state())


def test_colour_scale_needs_a_real_change():
    assert act("set_colour_scale", {"auto": True}, chunk_state())["auto"] is True
    assert act("set_colour_scale", {"min": 20, "max": 30}, chunk_state())["max"] == 30.0
    with pytest.raises(ActionError):
        act("set_colour_scale", {}, chunk_state())
    with pytest.raises(ActionError):
        act("set_colour_scale", {"min": 30, "max": 20}, chunk_state())


def test_move_chunk_steps_one_tile():
    action = act("move_chunk", {"direction": "north"}, chunk_state())
    assert action["lat"] == 17.5 and action["lon"] == 87.5


# --------------------------------------------------------------------------
# State carried through a turn
# --------------------------------------------------------------------------

def test_opening_a_chunk_switches_the_view_and_snaps_the_tile():
    state = map_state()
    action = act("open_chunk", {"lat": 16.2, "lon": 88.9}, state)
    assert advance_state(state, action) is True
    assert state.view == "chunk" and state.chunk.bbox == [85.0, 15.0, 90.0, 20.0]


def test_a_later_action_in_the_same_turn_sees_the_earlier_one():
    state = chunk_state()
    advance_state(state, act("show_variable", {"variable": "chlorophyll"}, state))
    with pytest.raises(ActionError):
        act("set_display", {"mode": "volume"}, state)


def test_staying_in_a_view_is_not_a_switch():
    state = chunk_state()
    assert advance_state(state, act("set_camera", {"preset": "top"}, state)) is False


# --------------------------------------------------------------------------
# The sentence a command turn ends with
# --------------------------------------------------------------------------

def test_describes_actions_in_the_voice_the_prompt_asks_for():
    state = map_state()
    layers = act("set_layers", {"add": ["chlorophyll"], "hide": ["temperature"]}, state)
    assert describe_actions([layers]) == "Added chlorophyll. Hid temperature."
    assert describe_actions([act("show_variable", {"variable": "salinity"}, chunk_state())]) == (
        "Showing salinity."
    )
    assert describe_actions([act("set_time", {"time": "2013-10-12"}, state)]) == (
        "Date set to 12 Oct 2013."
    )


def test_refuses_a_tool_that_does_not_exist():
    with pytest.raises(ActionError):
        act("delete_everything", {}, map_state())
