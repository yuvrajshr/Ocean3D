"""Action validation: what the assistant is allowed to do to the app.

Every action the model proposes is checked against the state snapshot the
frontend sent, before it is ever handed back to be applied. That matters for
two reasons: the model gets a truthful success/failure result rather than an
optimistic guess, and an invalid action is refused in one place instead of
being half-applied by a reducer.

No network, no Gemini — this is the pure decision layer.
"""

from __future__ import annotations

import pytest

from app.assistant.tools import (
    NAMED_REGIONS,
    VIEWS,
    ScreenState,
    ActionError,
    validate_action,
)

CATALOGUE = ["temperature", "salinity", "currents", "chlorophyll", "mixed_layer_depth"]


def state(**over) -> ScreenState:
    base = dict(
        view="map",
        layers=[{"key": "temperature", "visible": True, "opacity": 1.0}],
        time="2013-10-10T00:00:00Z",
        depth_index=0,
        depth_m=0.5,
    )
    base.update(over)
    return ScreenState(**base)


# --------------------------------------------------------------------------
# Layers — the headline case
# --------------------------------------------------------------------------

def test_adds_a_layer_and_hides_another_in_one_action() -> None:
    """'Add the chlorophyll layer and hide the temperature layer.'"""
    action = validate_action(
        "set_layers",
        {"add": ["chlorophyll"], "hide": ["temperature"]},
        state(),
        CATALOGUE,
    )
    assert action["type"] == "set_layers"
    assert action["add"] == ["chlorophyll"]
    assert action["hide"] == ["temperature"]


def test_refuses_a_variable_the_catalogue_does_not_serve() -> None:
    """A key nothing serves would add a layer that renders nothing at all."""
    with pytest.raises(ActionError) as e:
        validate_action("set_layers", {"add": ["unobtanium"]}, state(), CATALOGUE)
    assert "unobtanium" in str(e.value)


def test_refuses_to_exceed_the_three_layer_cap() -> None:
    """MAX_LAYERS is 3 in map/state.ts; silently dropping one would be a lie."""
    full = state(
        layers=[
            {"key": "temperature", "visible": True, "opacity": 1.0},
            {"key": "salinity", "visible": True, "opacity": 1.0},
            {"key": "currents", "visible": True, "opacity": 1.0},
        ]
    )
    with pytest.raises(ActionError) as e:
        validate_action("set_layers", {"add": ["chlorophyll"]}, full, CATALOGUE)
    assert "3" in str(e.value), "the refusal must say what the limit actually is"


def test_adding_a_layer_already_present_is_not_an_error() -> None:
    """Asking for what is already true should read as satisfied, not failed."""
    action = validate_action("set_layers", {"add": ["temperature"]}, state(), CATALOGUE)
    assert action["add"] == [], "already present, so nothing to add"


def test_refuses_to_hide_a_layer_that_is_not_there() -> None:
    with pytest.raises(ActionError):
        validate_action("set_layers", {"hide": ["chlorophyll"]}, state(), CATALOGUE)


def test_opacity_must_be_a_fraction() -> None:
    with pytest.raises(ActionError):
        validate_action(
            "set_layers", {"opacity": {"temperature": 250}}, state(), CATALOGUE
        )


# --------------------------------------------------------------------------
# Navigation — coordinates the model must never invent
# --------------------------------------------------------------------------

def test_zooms_to_a_named_region_from_the_table() -> None:
    action = validate_action("zoom_to_region", {"region": "Bay of Bengal"}, state(), CATALOGUE)
    assert action["type"] == "zoom_to_region"
    assert action["lat_range"] == list(NAMED_REGIONS["bay of bengal"]["lat_range"])


def test_region_lookup_is_case_insensitive() -> None:
    assert validate_action("zoom_to_region", {"region": "BAY OF BENGAL"}, state(), CATALOGUE)


def test_refuses_an_unknown_region_rather_than_guessing_coordinates() -> None:
    """The whole point of the table: a hallucinated bounding box looks correct."""
    with pytest.raises(ActionError) as e:
        validate_action("zoom_to_region", {"region": "Atlantis"}, state(), CATALOGUE)
    assert "Atlantis" in str(e.value)


def test_switches_between_the_three_real_views() -> None:
    # Derived from VIEWS rather than listed: the rail changed once already, when
    # the water column left it on 2026-09-10, and a hardcoded copy here went
    # stale silently.
    for view in VIEWS:
        assert validate_action("set_view", {"view": view}, state(), CATALOGUE)["view"] == view


def test_refuses_a_view_that_does_not_exist() -> None:
    with pytest.raises(ActionError):
        validate_action("set_view", {"view": "orbital"}, state(), CATALOGUE)
    # The water column is gone from the navigation, so naming it is now wrong.
    with pytest.raises(ActionError):
        validate_action("set_view", {"view": "column"}, state(), CATALOGUE)


def test_open_chunk_resolves_only_named_regions() -> None:
    """The same fence `zoom_to_region` has: a model must never supply a bbox."""
    action = validate_action("open_chunk", {"region": "Bay of Bengal"}, state(), CATALOGUE)
    assert action["type"] == "open_chunk"
    assert 5.0 <= action["lat"] <= 23.0
    assert 78.0 <= action["lon"] <= 95.0
    with pytest.raises(ActionError):
        validate_action("open_chunk", {"region": "Atlantis"}, state(), CATALOGUE)


# --------------------------------------------------------------------------
# Time, depth, selection
# --------------------------------------------------------------------------

def test_sets_a_time() -> None:
    action = validate_action("set_time", {"time": "2013-10-12"}, state(), CATALOGUE)
    assert action["time"].startswith("2013-10-12")


def test_refuses_an_unparseable_time() -> None:
    with pytest.raises(ActionError):
        validate_action("set_time", {"time": "last tuesday"}, state(), CATALOGUE)


def test_sets_a_depth_in_metres() -> None:
    action = validate_action("set_depth", {"depth_m": 100}, state(), CATALOGUE)
    assert action["depth_m"] == 100


def test_refuses_a_depth_below_the_grid() -> None:
    """The analysis stops at 2000 m; deeper is not a slice we have."""
    with pytest.raises(ActionError):
        validate_action("set_depth", {"depth_m": 9000}, state(), CATALOGUE)


def test_pin_coordinates_must_be_on_the_planet() -> None:
    assert validate_action("set_pin", {"lat": 15, "lon": 88}, state(), CATALOGUE)
    with pytest.raises(ActionError):
        validate_action("set_pin", {"lat": 200, "lon": 88}, state(), CATALOGUE)


def test_area_ranges_must_be_ordered() -> None:
    with pytest.raises(ActionError):
        validate_action(
            "set_area",
            {"lat_range": [20, 5], "lon_range": [80, 95]},
            state(),
            CATALOGUE,
        )


# --------------------------------------------------------------------------
# Unknown tools
# --------------------------------------------------------------------------

def test_refuses_a_tool_that_does_not_exist() -> None:
    with pytest.raises(ActionError):
        validate_action("delete_everything", {}, state(), CATALOGUE)
