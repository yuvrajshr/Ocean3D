"""The assistant's tools: what it may read, and what it may do.

Tools split into two families that cannot execute in the same place.

**Read tools** run here, on the backend, against the upstreams the app already
uses. Every one returns its value *with* provenance attached — dataset, date,
depth, units — because the panel builds its citation line from the calls that
actually ran. That is what makes context.md §5.1's grounding rule structural: a
number stated without a tool call has nothing to cite, and shows as general
knowledge rather than passing quietly as data.

**Action tools** cannot run here at all. They mutate React state that lives in
the browser. So they are *validated* here against the state snapshot the
frontend sent, then handed back as a typed action for the client to apply. The
validation is not ceremony: it means the model is told the truth about whether
its action succeeded, and an invalid action is refused in one place rather than
being half-applied by a reducer.

`zoom_to_region` resolves against the fixed table below and nothing else. A
model-invented bounding box is the most dangerous kind of wrong here, because
it looks entirely plausible on screen.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

# Mirrors MAX_LAYERS in frontend/src/map/state.ts. If that moves, this moves.
MAX_LAYERS = 3

# The analysis grid runs 5-2000 m (context.md §8, GRID_DEPTH_RANGE).
MAX_DEPTH_M = 2000.0

# The water column left the navigation on 2026-09-10; the chunk view answers
# the same question at a real model resolution. Mirrors AppView in App.tsx.
VIEWS = ("map", "globe", "chunk")

# Coordinates the model is never allowed to supply for a place name. Keys are
# lowercased for lookup; the label is what gets echoed back to the reader.
NAMED_REGIONS: dict[str, dict[str, Any]] = {
    "bay of bengal": {
        "label": "Bay of Bengal",
        "lat_range": (5.0, 23.0),
        "lon_range": (78.0, 95.0),
    },
    "arabian sea": {
        "label": "Arabian Sea",
        "lat_range": (5.0, 25.0),
        "lon_range": (55.0, 78.0),
    },
    "indian ocean": {
        "label": "Indian Ocean",
        "lat_range": (-30.0, 25.0),
        "lon_range": (35.0, 115.0),
    },
    "andaman sea": {
        "label": "Andaman Sea",
        "lat_range": (6.0, 17.0),
        "lon_range": (92.0, 99.0),
    },
    "equatorial indian ocean": {
        "label": "equatorial Indian Ocean",
        "lat_range": (-10.0, 10.0),
        "lon_range": (50.0, 100.0),
    },
    "world": {"label": "the world", "lat_range": (-90.0, 90.0), "lon_range": (-180.0, 180.0)},
}


class ActionError(Exception):
    """An action the assistant may not take, with a reason fit to show a reader.

    The message goes back to the model as the tool result *and* is shown in the
    panel, so it follows §5.3: state what happened and what to do, no apology.
    """


@dataclass
class ScreenState:
    """What the frontend says is currently true. Actions are checked against it."""

    view: str
    layers: list[dict[str, Any]] = field(default_factory=list)
    time: str = ""
    depth_index: int = 0
    depth_m: float = 0.0
    #: (lon_min, lat_min, lon_max, lat_max) when the chunk view is open.
    chunk_bbox: list[float] | None = None

    @property
    def layer_keys(self) -> list[str]:
        return [str(l.get("key")) for l in self.layers]


# --------------------------------------------------------------------------
# Action validation
# --------------------------------------------------------------------------

def _validate_set_layers(
    args: dict[str, Any], state: ScreenState, catalogue: list[str]
) -> dict[str, Any]:
    add = [k for k in args.get("add", []) or []]
    remove = [k for k in args.get("remove", []) or []]
    show = [k for k in args.get("show", []) or []]
    hide = [k for k in args.get("hide", []) or []]
    opacity = dict(args.get("opacity", {}) or {})

    for key in [*add, *remove, *show, *hide, *opacity]:
        if key not in catalogue:
            raise ActionError(
                f"There is no {key!r} variable in the catalogue. "
                f"Available: {', '.join(sorted(catalogue))}."
            )

    present = set(state.layer_keys)

    # Asking for what is already true is satisfied, not failed — the reader
    # asked for an end state, not a transition.
    add = [k for k in add if k not in present]

    for key in [*remove, *show, *hide]:
        if key not in present:
            raise ActionError(
                f"{key} is not in the layer stack, so it cannot be changed. "
                f"Currently showing: {', '.join(state.layer_keys) or 'nothing'}."
            )

    if len(present - set(remove)) + len(add) > MAX_LAYERS:
        raise ActionError(
            f"That would need more than {MAX_LAYERS} layers, which is the limit. "
            f"Remove one first — currently showing: {', '.join(state.layer_keys)}."
        )

    for key, value in opacity.items():
        if not isinstance(value, (int, float)) or not 0.0 <= float(value) <= 1.0:
            raise ActionError(f"Opacity for {key} must be between 0 and 1, not {value!r}.")

    return {
        "type": "set_layers",
        "add": add,
        "remove": remove,
        "show": show,
        "hide": hide,
        "opacity": {k: float(v) for k, v in opacity.items()},
    }


def _validate_zoom_to_region(args: dict[str, Any]) -> dict[str, Any]:
    name = str(args.get("region", "")).strip()
    region = NAMED_REGIONS.get(name.lower())
    if region is None:
        raise ActionError(
            f"I do not have coordinates for {name!r}, and I will not guess them. "
            f"Known regions: {', '.join(r['label'] for r in NAMED_REGIONS.values())}."
        )
    return {
        "type": "zoom_to_region",
        "label": region["label"],
        "lat_range": list(region["lat_range"]),
        "lon_range": list(region["lon_range"]),
    }


def _validate_open_chunk(args: dict[str, Any]) -> dict[str, Any]:
    """Open the chunk over a named region's centre.

    Resolves through NAMED_REGIONS and nothing else, for the same reason
    `zoom_to_region` does (context.md §10, 2026-09-06): a model supplying its
    own coordinates for a place name is the most dangerous kind of wrong here,
    because the answer looks exactly as confident when it is 500 km out.

    The tile itself is chosen client-side by the same snap the globe uses, so
    the assistant cannot open a chunk a click could not.
    """
    name = str(args.get("region", "")).strip()
    region = NAMED_REGIONS.get(name.lower())
    if region is None:
        raise ActionError(
            f"I do not have coordinates for {name!r}, and I will not guess them. "
            f"Known regions: {', '.join(r['label'] for r in NAMED_REGIONS.values())}."
        )
    lat_range = region["lat_range"]
    lon_range = region["lon_range"]
    return {
        "type": "open_chunk",
        "label": region["label"],
        "lat": (lat_range[0] + lat_range[1]) / 2,
        "lon": (lon_range[0] + lon_range[1]) / 2,
    }


def _validate_set_time(args: dict[str, Any]) -> dict[str, Any]:
    raw = str(args.get("time", "")).strip()
    text = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        raise ActionError(
            f"I could not read {raw!r} as a date. Use an ISO date like 2013-10-12."
        ) from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return {"type": "set_time", "time": parsed.isoformat().replace("+00:00", "Z")}


def _validate_set_depth(args: dict[str, Any]) -> dict[str, Any]:
    depth = args.get("depth_m")
    if not isinstance(depth, (int, float)):
        raise ActionError("Depth must be a number of metres.")
    if not 0.0 <= float(depth) <= MAX_DEPTH_M:
        raise ActionError(
            f"The analysis runs from the surface to {MAX_DEPTH_M:.0f} m; "
            f"{depth} m is outside it."
        )
    return {"type": "set_depth", "depth_m": float(depth)}


def _validate_set_pin(args: dict[str, Any]) -> dict[str, Any]:
    lat, lon = args.get("lat"), args.get("lon")
    if not isinstance(lat, (int, float)) or not -90 <= float(lat) <= 90:
        raise ActionError(f"Latitude must be between -90 and 90, not {lat!r}.")
    if not isinstance(lon, (int, float)) or not -180 <= float(lon) <= 180:
        raise ActionError(f"Longitude must be between -180 and 180, not {lon!r}.")
    return {"type": "set_pin", "lat": float(lat), "lon": float(lon)}


def _validate_set_area(args: dict[str, Any]) -> dict[str, Any]:
    lat_range = args.get("lat_range") or []
    lon_range = args.get("lon_range") or []
    if len(lat_range) != 2 or len(lon_range) != 2:
        raise ActionError("An area needs a lat_range and a lon_range, each of two numbers.")
    if lat_range[0] >= lat_range[1] or lon_range[0] >= lon_range[1]:
        raise ActionError("Ranges must run south to north and west to east.")
    if not (-90 <= lat_range[0] < lat_range[1] <= 90):
        raise ActionError("Latitudes must lie between -90 and 90.")
    return {
        "type": "set_area",
        "lat_range": [float(v) for v in lat_range],
        "lon_range": [float(v) for v in lon_range],
    }


def validate_action(
    name: str, args: dict[str, Any], state: ScreenState, catalogue: list[str]
) -> dict[str, Any]:
    """Check one proposed action against real state; return it, or raise.

    Raises `ActionError` with a reader-facing reason. Callers hand that reason
    straight back to the model as the tool result, so it learns what actually
    happened rather than assuming success.
    """
    if name == "set_layers":
        return _validate_set_layers(args, state, catalogue)
    if name == "zoom_to_region":
        return _validate_zoom_to_region(args)
    if name == "set_time":
        return _validate_set_time(args)
    if name == "set_depth":
        return _validate_set_depth(args)
    if name == "set_pin":
        return _validate_set_pin(args)
    if name == "set_area":
        return _validate_set_area(args)
    if name == "set_view":
        view = str(args.get("view", ""))
        if view not in VIEWS:
            raise ActionError(f"There is no {view!r} view. Choose one of: {', '.join(VIEWS)}.")
        return {"type": "set_view", "view": view}
    if name == "open_chunk":
        return _validate_open_chunk(args)
    raise ActionError(f"There is no {name!r} action.")


ACTION_TOOLS = frozenset(
    {
        "set_layers",
        "set_view",
        "set_time",
        "set_depth",
        "zoom_to_region",
        "set_pin",
        "set_area",
        "open_chunk",
    }
)


# --------------------------------------------------------------------------
# Declarations handed to Gemini
# --------------------------------------------------------------------------
#
# Descriptions are written for the model, not for a human reader, and they earn
# their length: the difference between "gets a value" and a sentence saying the
# value is a real measurement from a named grid cell is the difference between
# the model fetching and the model recalling.

def _fn(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {
        "type": "function",
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": required,
        },
    }


_STR = {"type": "string"}
_NUM = {"type": "number"}
_KEYS = {"type": "array", "items": {"type": "string"}}

# `get_screen_state` and `search_variables` are deliberately NOT declared here.
# Both are inlined into the system prompt instead (see prompt.py). The free tier
# allows 5 requests per minute and this loop spends one per round; advertising
# those two cost a measured three rounds for "add chlorophyll and hide
# temperature" where one will do. The functions still exist in reads.py, so
# re-declaring them is a one-line change if that ever stops being the right trade.
DECLARATIONS: list[dict] = [
    _fn(
        "query_point",
        "Fetch a real measured value at one location from the ocean analysis. Returns "
        "the value, the grid cell it came from, and its provenance. You MUST call this "
        "before stating any measurement at a location — never state one from memory.",
        {
            "lat": {**_NUM, "description": "Latitude, -90 to 90."},
            "lon": {**_NUM, "description": "Longitude, -180 to 180."},
            "variable": {**_STR, "description": "Variable key, e.g. temperature."},
            "time": {**_STR, "description": "ISO date. Defaults to the displayed date."},
        },
        ["lat", "lon"],
    ),
    _fn(
        "list_floats",
        "List the in-situ Argo floats reporting in a time window and area, with their "
        "positions and platform ids.",
        {
            "time_start": _STR, "time_end": _STR,
            "lat_min": _NUM, "lat_max": _NUM, "lon_min": _NUM, "lon_max": _NUM,
        },
        [],
    ),
    _fn(
        "compare_float",
        "Compare the model analysis against one Argo float's real cast at the same "
        "place and time. This is the model-vs-observation comparison the platform "
        "exists to make.",
        {
            "platform_id": {**_STR, "description": "Float id, e.g. 2901335."},
            "variable": _STR,
            "cycle": {"type": "integer"},
        },
        ["platform_id"],
    ),
    _fn(
        "set_layers",
        "Change which ocean layers are displayed. Add, remove, show or hide layers by "
        "variable key, or set opacity. At most three layers may be in the stack.",
        {
            "add": {**_KEYS, "description": "Variable keys to add."},
            "remove": {**_KEYS, "description": "Variable keys to remove entirely."},
            "show": {**_KEYS, "description": "Existing layers to make visible."},
            "hide": {**_KEYS, "description": "Existing layers to hide (kept in the stack)."},
            "opacity": {"type": "object", "description": "Variable key to 0-1 opacity."},
        },
        [],
    ),
    _fn(
        "set_view",
        "Switch between the 2D map, the 3D globe, and the chunk view.",
        {"view": {**_STR, "enum": list(VIEWS)}},
        ["view"],
    ),
    _fn(
        "set_time",
        "Set the date shown. Every layer resolves this one clock to its own cadence.",
        {"time": {**_STR, "description": "ISO date, e.g. 2013-10-12."}},
        ["time"],
    ),
    _fn(
        "set_depth",
        f"Set the displayed depth in metres, between the surface and {MAX_DEPTH_M:.0f} m.",
        {"depth_m": _NUM},
        ["depth_m"],
    ),
    _fn(
        "zoom_to_region",
        "Move the map to a named ocean region. Only the listed regions are available — "
        "if the user names somewhere else, say so rather than guessing coordinates.",
        {"region": {**_STR, "enum": [r["label"] for r in NAMED_REGIONS.values()]}},
        ["region"],
    ),
    _fn(
        "open_chunk",
        "Open the 3D chunk view over a named region — one 5-degree block of "
        "ocean from the surface to 2000 m. Only the listed regions are "
        "available; never supply coordinates of your own.",
        {"region": {**_STR, "enum": [r["label"] for r in NAMED_REGIONS.values()]}},
        ["region"],
    ),
    _fn(
        "set_pin",
        "Drop the inspection pin at a coordinate, opening the point readout there.",
        {"lat": _NUM, "lon": _NUM},
        ["lat", "lon"],
    ),
    _fn(
        "set_area",
        "Select a rectangular area for regional statistics.",
        {
            "lat_range": {"type": "array", "items": _NUM},
            "lon_range": {"type": "array", "items": _NUM},
        },
        ["lat_range", "lon_range"],
    ),
]
