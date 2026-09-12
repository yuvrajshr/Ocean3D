"""The assistant's tools: what it may read, and what it may do — per view.

Tools split into two families that cannot execute in the same place.

**Read tools** run on the backend (`reads.py`) and return their value *with*
provenance attached, because the panel builds its citation line from the calls
that actually ran (context.md §5.1 Principle 13).

**Action tools** mutate React state in the browser, so they cannot run here.
They are *validated* here against the screen snapshot the frontend sent, then
handed back as a typed action for the client to apply. The model is therefore
told the truth about whether its action succeeded.

**Every action belongs to a view** (decided 2026-09-10). The map, the globe and
the chunk each declare their own controls, and a turn is only offered the
controls of the view on screen, plus the two that move between views. That is
what "changes apply to the view you are on" means structurally: "show salinity"
in the chunk changes the chunk's variable, and cannot reach the map's layer
stack, because no map tool is declared there. Each validated action carries the
view it was validated against as `scope`, which is how the client routes it.

`zoom_to_region` and `open_chunk` resolve place names against a fixed table and
nothing else. A model-invented bounding box is the most dangerous kind of wrong
here, because it looks entirely plausible on screen.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, fields
from datetime import datetime, timezone
from typing import Any, Callable

from ..config import CHUNK_MAX_DEPTH, CHUNK_TILE_DEGREES

# Mirrors MAX_LAYERS in frontend/src/map/state.ts. If that moves, this moves.
MAX_LAYERS = 3

# The water column left the navigation on 2026-09-10. Mirrors AppView in App.tsx.
VIEWS = ("map", "globe", "chunk")

# Coordinates the model is never allowed to supply for a place name. Keys are
# lowercased for lookup; the label is what gets echoed back to the reader.
NAMED_REGIONS: dict[str, dict[str, Any]] = {
    "bay of bengal": {"label": "Bay of Bengal", "lat_range": (5.0, 23.0), "lon_range": (78.0, 95.0)},
    "arabian sea": {"label": "Arabian Sea", "lat_range": (5.0, 25.0), "lon_range": (55.0, 78.0)},
    "indian ocean": {"label": "Indian Ocean", "lat_range": (-30.0, 25.0), "lon_range": (35.0, 115.0)},
    "andaman sea": {"label": "Andaman Sea", "lat_range": (6.0, 17.0), "lon_range": (92.0, 99.0)},
    "equatorial indian ocean": {
        "label": "equatorial Indian Ocean",
        "lat_range": (-10.0, 10.0),
        "lon_range": (50.0, 100.0),
    },
    "world": {"label": "the world", "lat_range": (-90.0, 90.0), "lon_range": (-180.0, 180.0)},
}

# ---- The chunk view's vocabulary. Mirrors frontend/src/viz/chunk/{model,spec}.ts.

CHUNK_VARIABLES = ("temperature", "salinity", "speed", "chlorophyll")
#: No upstream serves chlorophyll in 3D, so the chunk shows it as a slice or not
#: at all — the same rule the chunk's own panel enforces by disabling buttons.
SURFACE_ONLY_CHUNK_VARIABLES = frozenset({"chlorophyll"})
CHUNK_MODES = ("slices", "volume", "isosurface")
CHUNK_CUT_AXES = ("depth", "lon", "lat")
CHUNK_CAMERAS = ("corner", "top", "section")
#: The chunk's layers, as its spec declares them. The sea surface was removed
#: upstream (6718bc1); the instrument traces were removed (38db870) and restored
#: (77f5583). This table follows the view — when a layer comes or goes there,
#: it comes or goes here, or the assistant offers a control the reader cannot see.
CHUNK_LAYERS = {
    "scalar": "the scalar field",
    "currents": "the currents",
    "bathy": "the bathymetry",
    "instruments": "the instrument traces",
}
#: The chunk's own exaggeration slider.
EXAGGERATION_RANGE = (10.0, 200.0)
CHUNK_UNITS = {"temperature": "°C", "salinity": "PSU", "speed": "m/s", "chlorophyll": "mg/m³"}
#: A physically plausible bracket for an isovalue — not the chunk's own range,
#: which the model cannot see, but wide enough never to refuse a real one.
ISO_RANGE = {
    "temperature": (-2.0, 40.0),
    "salinity": (0.0, 42.0),
    "speed": (0.0, 5.0),
    "chlorophyll": (0.0, 100.0),
}

_ALIASES: dict[str, dict[str, str]] = {
    "variable": {
        "temp": "temperature", "sst": "temperature", "sea surface temperature": "temperature",
        "sal": "salinity", "salt": "salinity", "sss": "salinity",
        "current speed": "speed", "currents": "speed", "current": "speed", "velocity": "speed",
        "chl": "chlorophyll", "chlorophyll-a": "chlorophyll", "chla": "chlorophyll",
    },
    "mode": {
        "slice": "slices", "cut": "slices", "volume rendering": "volume",
        "iso": "isosurface", "isosurfaces": "isosurface", "contour": "isosurface",
    },
    "axis": {"longitude": "lon", "latitude": "lat", "horizontal": "depth", "z": "depth"},
    "camera": {
        "top-down": "top", "top down": "top", "plan": "top", "overhead": "top",
        "side": "section", "cross-section": "section", "oblique": "corner", "default": "corner",
    },
    "layer": {
        "scalar field": "scalar", "field": "scalar", "current": "currents", "flow": "currents",
        "bathymetry": "bathy", "seabed": "bathy", "seafloor": "bathy", "relief": "bathy",
        "instrument traces": "instruments", "traces": "instruments", "instrument": "instruments",
        "floats": "instruments", "argo": "instruments", "tracks": "instruments",
    },
}


def choose(kind: str, raw: Any, allowed) -> str | None:
    """Normalise a reader's word to one the view knows, or None."""
    key = str(raw or "").strip().lower()
    key = _ALIASES.get(kind, {}).get(key, key)
    return key if key in allowed else None


class ActionError(Exception):
    """An action the assistant may not take, with a reason fit to show a reader.

    The message goes back to the model as the tool result *and* may be shown in
    the panel, so it follows §5.3: state what happened and what to do, no apology.
    """


# --------------------------------------------------------------------------
# Screen state: every view, every turn
# --------------------------------------------------------------------------

def _only_known(cls, data: Any) -> dict[str, Any]:
    names = {f.name for f in fields(cls)}
    return {k: v for k, v in (data or {}).items() if k in names}


@dataclass
class MapState:
    #: Topmost first: {key, visible, opacity, provider, time_start, time_end}.
    layers: list[dict[str, Any]] = field(default_factory=list)
    time: str = ""
    #: The layer the depth ruler drives: {key, depth_m, depth_levels | None}.
    active: dict[str, Any] | None = None
    pin: dict[str, float] | None = None

    @property
    def layer_keys(self) -> list[str]:
        return [str(layer.get("key")) for layer in self.layers]


@dataclass
class GlobeState:
    time: str = ""
    #: The scenario window the globe's timeline covers: [start, end].
    window: list[str] = field(default_factory=list)
    selected: str | None = None
    #: Platform ids of the floats reporting at this date.
    floats: list[str] = field(default_factory=list)


@dataclass
class ChunkState:
    #: False when the chunk view is not open: the block then describes the
    #: chunk as it would open, so a switch mid-turn is validated truthfully.
    mounted: bool = False
    #: (lon_min, lat_min, lon_max, lat_max), the spec's own order.
    bbox: list[float] = field(default_factory=lambda: [85.0, 10.0, 90.0, 15.0])
    variable: str = "temperature"
    time: str = ""
    window: list[str] = field(default_factory=list)
    mode: str = "slices"
    cut: dict[str, Any] = field(default_factory=lambda: {"axis": "depth", "value": 80.0})
    iso_value: float | None = None
    exaggeration: float = 150.0
    camera: str = "corner"
    layers: dict[str, dict[str, Any]] = field(default_factory=dict)
    colour: dict[str, Any] = field(default_factory=dict)
    #: Platform ids of the floats with a track in this chunk and window.
    platforms: list[str] = field(default_factory=list)
    #: The float whose cast is open against the model, if any.
    open_float: str | None = None


@dataclass
class ScreenState:
    """What the frontend says is currently true, for all three views."""

    view: str = "map"
    map: MapState = field(default_factory=MapState)
    globe: GlobeState = field(default_factory=GlobeState)
    chunk: ChunkState = field(default_factory=ChunkState)

    @classmethod
    def from_payload(cls, payload: dict[str, Any] | None) -> "ScreenState":
        """Tolerant by design: a missing block or an unknown key is not an error."""
        data = payload or {}
        view = str(data.get("view") or "map")
        return cls(
            view=view if view in VIEWS else "map",
            map=MapState(**_only_known(MapState, data.get("map"))),
            globe=GlobeState(**_only_known(GlobeState, data.get("globe"))),
            chunk=ChunkState(**_only_known(ChunkState, data.get("chunk"))),
        )

    def view_date(self) -> str:
        """The date the view on screen is showing, as YYYY-MM-DD, or ""."""
        raw = {"map": self.map.time, "globe": self.globe.time, "chunk": self.chunk.time}.get(
            self.view, ""
        )
        return (raw or "")[:10]


# --------------------------------------------------------------------------
# Formatting shared with reads and the prompt
# --------------------------------------------------------------------------

def fmt_date(iso: str) -> str:
    """A date as the app writes dates: "12 Oct 2013"."""
    try:
        d = datetime.fromisoformat(str(iso)[:10])
    except ValueError:
        return str(iso)[:10]
    return f"{d.day} {d.strftime('%b %Y')}"


def fmt_point(lat: float, lon: float) -> str:
    return (
        f"{abs(lat):.2f}°{'N' if lat >= 0 else 'S'} "
        f"{abs(lon):.2f}°{'E' if lon >= 0 else 'W'}"
    )


def snap_tile(lon: float, lat: float) -> list[float]:
    """The chunk tile containing a point — the same floor `snapTile` uses client-side."""
    step = CHUNK_TILE_DEGREES
    lon0 = math.floor(lon / step) * step
    lat0 = math.floor(lat / step) * step
    return [lon0, lat0, lon0 + step, lat0 + step]


def _parse_time(raw: Any) -> str:
    text = str(raw or "").strip()
    parseable = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        parsed = datetime.fromisoformat(parseable)
    except ValueError:
        raise ActionError(
            f"I could not read {text!r} as a date. Use an ISO date like 2013-10-12."
        ) from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.isoformat().replace("+00:00", "Z")


def _number(raw: Any) -> float | None:
    return float(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else None


def _check_lat_lon(lat: Any, lon: Any) -> tuple[float, float]:
    la, lo = _number(lat), _number(lon)
    if la is None or not -90 <= la <= 90:
        raise ActionError(f"Latitude must be between -90 and 90, not {lat!r}.")
    if lo is None or not -180 <= lo <= 180:
        raise ActionError(f"Longitude must be between -180 and 180, not {lon!r}.")
    return la, lo


def _region(args: dict[str, Any]) -> dict[str, Any]:
    name = str(args.get("region", "")).strip()
    region = NAMED_REGIONS.get(name.lower())
    if region is None:
        raise ActionError(
            f"I do not have coordinates for {name!r}, and I will not guess them. "
            f"Known regions: {', '.join(r['label'] for r in NAMED_REGIONS.values())}."
        )
    return region


# --------------------------------------------------------------------------
# Validators — (view, name) → fn(args, state, catalogue) -> action
# --------------------------------------------------------------------------

Validator = Callable[[dict[str, Any], ScreenState, list[str]], dict[str, Any]]


def _v_set_view(args, _state, _cat):
    view = str(args.get("view", ""))
    if view not in VIEWS:
        raise ActionError(f"There is no {view!r} view. Choose one of: {', '.join(VIEWS)}.")
    return {"type": "set_view", "view": view}


def _v_open_chunk(args, _state, _cat):
    if str(args.get("region") or "").strip():
        region = _region(args)
        (la, lb), (oa, ob) = region["lat_range"], region["lon_range"]
        return {"type": "open_chunk", "label": region["label"], "lat": (la + lb) / 2, "lon": (oa + ob) / 2}
    if args.get("lat") is not None and args.get("lon") is not None:
        lat, lon = _check_lat_lon(args.get("lat"), args.get("lon"))
        return {"type": "open_chunk", "label": fmt_point(lat, lon), "lat": lat, "lon": lon}
    raise ActionError("Say which region to open, or give the coordinates the reader stated.")


# ---- map

def _v_set_layers(args, state, catalogue):
    add = list(args.get("add") or [])
    remove = list(args.get("remove") or [])
    show = list(args.get("show") or [])
    hide = list(args.get("hide") or [])
    opacity = dict(args.get("opacity") or {})

    for key in [*add, *remove, *show, *hide, *opacity]:
        if key not in catalogue:
            raise ActionError(
                f"There is no {key!r} variable in the catalogue. "
                f"Available: {', '.join(sorted(catalogue))}."
            )

    present = set(state.map.layer_keys)
    # Asking for what is already true is satisfied, not failed — the reader
    # asked for an end state, not a transition.
    add = [k for k in add if k not in present]
    for key in [*remove, *show, *hide]:
        if key not in present:
            raise ActionError(
                f"{key} is not in the layer stack, so it cannot be changed. "
                f"Currently showing: {', '.join(state.map.layer_keys) or 'nothing'}."
            )
    if len(present - set(remove)) + len(add) > MAX_LAYERS:
        raise ActionError(
            f"That would need more than {MAX_LAYERS} layers, which is the limit. "
            f"Remove one first — currently showing: {', '.join(state.map.layer_keys)}."
        )
    for key, value in opacity.items():
        if _number(value) is None or not 0.0 <= float(value) <= 1.0:
            raise ActionError(f"Opacity for {key} must be between 0 and 1, not {value!r}.")
    return {
        "type": "set_layers", "add": add, "remove": remove, "show": show, "hide": hide,
        "opacity": {k: float(v) for k, v in opacity.items()},
    }


def _v_map_set_time(args, state, _cat):
    iso = _parse_time(args.get("time"))
    day = iso[:10]
    covered = [
        layer for layer in state.map.layers
        if layer.get("visible", True) and layer.get("time_start") and layer.get("time_end")
    ]
    if covered and not any(l["time_start"][:10] <= day <= l["time_end"][:10] for l in covered):
        spans = "; ".join(
            f"{l.get('key')} ({l.get('provider') or 'source'}) {l['time_start'][:10]} to {l['time_end'][:10]}"
            for l in covered
        )
        raise ActionError(f"No layer on the map has data on {day}. Coverage: {spans}.")
    return {"type": "set_time", "time": iso}


def _v_map_set_depth(args, state, _cat):
    depth = _number(args.get("depth_m"))
    if depth is None or depth < 0:
        raise ActionError("Depth must be a positive number of metres.")
    active = state.map.active or {}
    if not active.get("key"):
        raise ActionError("No layer is active on the map, so there is no depth to set. Add a layer first.")
    levels = sorted(float(d) for d in (active.get("depth_levels") or []))
    if not levels:
        raise ActionError(f"{active['key']} is a surface field, so it has no depth to set.")
    if depth > levels[-1] * 1.05 + 1:
        raise ActionError(
            f"The {active['key']} layer's grid stops at {levels[-1]:.0f} m; {depth:g} m is below it."
        )
    index = min(range(len(levels)), key=lambda i: abs(levels[i] - depth))
    return {"type": "set_depth", "depth_m": levels[index], "depth_index": index, "requested_m": depth}


def _v_zoom_to_region(args, _state, _cat):
    region = _region(args)
    return {
        "type": "zoom_to_region", "label": region["label"],
        "lat_range": list(region["lat_range"]), "lon_range": list(region["lon_range"]),
    }


def _v_set_pin(args, _state, _cat):
    lat, lon = _check_lat_lon(args.get("lat"), args.get("lon"))
    return {"type": "set_pin", "lat": lat, "lon": lon}


def _v_set_area(args, _state, _cat):
    lat_range = list(args.get("lat_range") or [])
    lon_range = list(args.get("lon_range") or [])
    if len(lat_range) != 2 or len(lon_range) != 2:
        raise ActionError("An area needs a lat_range and a lon_range, each of two numbers.")
    if lat_range[0] >= lat_range[1] or lon_range[0] >= lon_range[1]:
        raise ActionError("Ranges must run south to north and west to east.")
    if not -90 <= lat_range[0] < lat_range[1] <= 90:
        raise ActionError("Latitudes must lie between -90 and 90.")
    return {
        "type": "set_area",
        "lat_range": [float(v) for v in lat_range],
        "lon_range": [float(v) for v in lon_range],
    }


# ---- globe

def _v_globe_set_time(args, state, _cat):
    iso = _parse_time(args.get("time"))
    day = iso[:10]
    window = state.globe.window
    if len(window) == 2 and not window[0][:10] <= day <= window[1][:10]:
        raise ActionError(
            f"The globe shows {window[0][:10]} to {window[1][:10]}; {day} is outside it."
        )
    return {"type": "set_time", "time": iso}


def _v_select_float(args, state, _cat):
    pid = str(args.get("platform_id") or "").strip()
    if not pid:
        raise ActionError("Which float? Give its platform id.")
    floats = state.globe.floats
    if not floats:
        raise ActionError("No floats are reporting on the globe at this date. Try another date.")
    if pid not in floats:
        shown = ", ".join(floats[:12]) + ("…" if len(floats) > 12 else "")
        raise ActionError(
            f"Float {pid} is not reporting on the globe at this date. Reporting now: {shown}."
        )
    return {"type": "select_float", "platform_id": pid}


def _v_clear_selection(_args, _state, _cat):
    return {"type": "clear_selection"}


# ---- chunk

def _surface_only(state: ScreenState) -> bool:
    return state.chunk.variable in SURFACE_ONLY_CHUNK_VARIABLES


def _v_show_variable(args, _state, _cat):
    variable = choose("variable", args.get("variable"), CHUNK_VARIABLES)
    if variable is None:
        raise ActionError(
            f"The chunk can show {', '.join(CHUNK_VARIABLES)}; "
            f"{args.get('variable')!r} is not one of them."
        )
    return {"type": "show_variable", "variable": variable}


def _v_chunk_set_time(args, state, _cat):
    day = _parse_time(args.get("time"))[:10]
    window = state.chunk.window
    if len(window) == 2 and not window[0][:10] <= day <= window[1][:10]:
        raise ActionError(
            f"The chunk holds daily steps from {fmt_date(window[0])} to {fmt_date(window[1])}; "
            f"{fmt_date(day)} is outside it."
        )
    return {"type": "set_time", "time": day}


def _v_set_display(args, state, _cat):
    mode = choose("mode", args.get("mode"), CHUNK_MODES)
    if mode is None:
        raise ActionError("The display modes are slices, volume and isosurface.")
    if mode != "slices" and _surface_only(state):
        raise ActionError(
            f"{state.chunk.variable.capitalize()} is surface-only (no upstream serves it in "
            "3D), so only slices can show it."
        )
    return {"type": "set_display", "mode": mode}


def _v_set_cut(args, state, _cat):
    axis = choose("axis", args.get("axis"), CHUNK_CUT_AXES)
    value = _number(args.get("value"))
    if axis is None:
        raise ActionError("A cut runs along depth, lon or lat.")
    if value is None:
        raise ActionError("Give the cut's position: metres for depth, degrees for lon or lat.")
    if axis != "depth" and _surface_only(state):
        raise ActionError(
            f"{state.chunk.variable.capitalize()} is surface-only, so only the depth cut applies."
        )
    lon0, lat0, lon1, lat1 = state.chunk.bbox
    if axis == "depth" and not 0 <= value <= CHUNK_MAX_DEPTH:
        raise ActionError(f"The chunk runs from the surface to {CHUNK_MAX_DEPTH:.0f} m.")
    if axis == "lon" and not lon0 <= value <= lon1:
        raise ActionError(f"This chunk spans {lon0:g}–{lon1:g}°E; {value:g}° is outside it.")
    if axis == "lat" and not lat0 <= value <= lat1:
        raise ActionError(f"This chunk spans {lat0:g}–{lat1:g}°N; {value:g}° is outside it.")
    return {"type": "set_cut", "axis": axis, "value": value}


def _v_set_iso_value(args, state, _cat):
    variable = state.chunk.variable
    if variable in SURFACE_ONLY_CHUNK_VARIABLES:
        raise ActionError(f"{variable.capitalize()} is surface-only, so it has no isosurface.")
    value = _number(args.get("value"))
    lo, hi = ISO_RANGE.get(variable, (-math.inf, math.inf))
    if value is None or not lo <= value <= hi:
        raise ActionError(
            f"An isovalue for {variable} must lie between {lo:g} and {hi:g} {CHUNK_UNITS[variable]}."
        )
    return {"type": "set_iso_value", "value": value}


def _v_set_exaggeration(args, _state, _cat):
    value = _number(args.get("value"))
    lo, hi = EXAGGERATION_RANGE
    if value is None or not lo <= value <= hi:
        raise ActionError(f"Vertical exaggeration runs from {lo:g}× to {hi:g}×.")
    return {"type": "set_exaggeration", "value": float(round(value))}


def _v_set_camera(args, _state, _cat):
    preset = choose("camera", args.get("preset"), CHUNK_CAMERAS)
    if preset is None:
        raise ActionError("The camera presets are corner, top-down and section.")
    return {"type": "set_camera", "preset": preset}


def _v_set_layer(args, _state, _cat):
    layer = choose("layer", args.get("layer"), tuple(CHUNK_LAYERS))
    if layer is None:
        raise ActionError("The chunk's layers are the scalar field, the currents and the bathymetry.")
    visible, opacity = args.get("visible"), args.get("opacity")
    if visible is None and opacity is None:
        raise ActionError("Say whether to show or hide it, or give an opacity.")
    if visible is not None and not isinstance(visible, bool):
        raise ActionError("visible must be true or false.")
    if opacity is not None and (_number(opacity) is None or not 0 <= opacity <= 1):
        raise ActionError("Opacity runs from 0 to 1.")
    action: dict[str, Any] = {"type": "set_layer", "layer": layer}
    if visible is not None:
        action["visible"] = visible
    if opacity is not None:
        action["opacity"] = float(opacity)
    return action


def _v_set_colour_scale(args, _state, _cat):
    action: dict[str, Any] = {"type": "set_colour_scale"}
    if args.get("auto"):
        action["auto"] = True
    lo, hi = args.get("min"), args.get("max")
    if lo is not None or hi is not None:
        lo_n, hi_n = _number(lo), _number(hi)
        if lo_n is None or hi_n is None or lo_n >= hi_n:
            raise ActionError("Give both ends of the colour range, with the minimum below the maximum.")
        action["min"], action["max"] = lo_n, hi_n
    scale = args.get("scale")
    if scale is not None:
        if scale not in ("linear", "log"):
            raise ActionError("The colour scale is linear or log.")
        action["scale"] = scale
    if len(action) == 1:
        raise ActionError("Say what to change: auto, a minimum and maximum, or linear or log.")
    return action


def _v_open_float(args, state, _cat):
    pid = str(args.get("platform_id") or "").strip()
    if not pid:
        raise ActionError("Which float? Give its platform id.")
    here = state.chunk.platforms
    if not here:
        raise ActionError("No Argo float has a track in this chunk and window. Try a neighbouring chunk.")
    if pid not in here:
        raise ActionError(f"Float {pid} has no track in this chunk. Floats here: {', '.join(here[:12])}.")
    return {"type": "open_float", "platform_id": pid}


_STEPS = {"north": (1, 0), "south": (-1, 0), "east": (0, 1), "west": (0, -1)}


def _v_move_chunk(args, state, _cat):
    direction = str(args.get("direction") or "").strip().lower()
    step = _STEPS.get(direction)
    if step is None:
        raise ActionError("Move the chunk north, south, east or west.")
    lon0, lat0, lon1, lat1 = state.chunk.bbox
    lat = (lat0 + lat1) / 2 + step[0] * CHUNK_TILE_DEGREES
    lon = (lon0 + lon1) / 2 + step[1] * CHUNK_TILE_DEGREES
    if not -80 <= lat <= 85:
        raise ActionError(f"There is no chunk further {direction}.")
    lon = ((lon + 180) % 360) - 180
    return {"type": "move_chunk", "direction": direction, "lat": lat, "lon": lon}


# ---- the registry

COMMON_ACTIONS = ("set_view", "open_chunk")
VIEW_ACTIONS: dict[str, tuple[str, ...]] = {
    "map": ("set_layers", "set_time", "set_depth", "zoom_to_region", "set_pin", "set_area"),
    "globe": ("set_time", "select_float", "clear_selection"),
    "chunk": (
        "show_variable", "set_time", "set_display", "set_cut", "set_iso_value",
        "set_exaggeration", "set_camera", "set_layer", "set_colour_scale", "open_float",
        "move_chunk",
    ),
}
COMMON_READS = ("query_point", "list_floats", "compare_float")
VIEW_READS: dict[str, tuple[str, ...]] = {"map": (), "globe": (), "chunk": ("describe_chunk",)}

ACTION_TOOLS = frozenset(COMMON_ACTIONS).union(*VIEW_ACTIONS.values())
#: Actions after which the next round must be planned against another view.
VIEW_SWITCHING = frozenset({"set_view", "open_chunk"})

_VALIDATORS: dict[tuple[str, str], Validator] = {
    ("*", "set_view"): _v_set_view,
    ("*", "open_chunk"): _v_open_chunk,
    ("map", "set_layers"): _v_set_layers,
    ("map", "set_time"): _v_map_set_time,
    ("map", "set_depth"): _v_map_set_depth,
    ("map", "zoom_to_region"): _v_zoom_to_region,
    ("map", "set_pin"): _v_set_pin,
    ("map", "set_area"): _v_set_area,
    ("globe", "set_time"): _v_globe_set_time,
    ("globe", "select_float"): _v_select_float,
    ("globe", "clear_selection"): _v_clear_selection,
    ("chunk", "show_variable"): _v_show_variable,
    ("chunk", "set_time"): _v_chunk_set_time,
    ("chunk", "set_display"): _v_set_display,
    ("chunk", "set_cut"): _v_set_cut,
    ("chunk", "set_iso_value"): _v_set_iso_value,
    ("chunk", "set_exaggeration"): _v_set_exaggeration,
    ("chunk", "set_camera"): _v_set_camera,
    ("chunk", "set_layer"): _v_set_layer,
    ("chunk", "set_colour_scale"): _v_set_colour_scale,
    ("chunk", "open_float"): _v_open_float,
    ("chunk", "move_chunk"): _v_move_chunk,
}


def tools_for(view: str) -> tuple[str, ...]:
    """Every tool a turn on this view is offered, actions first."""
    return COMMON_ACTIONS + VIEW_ACTIONS.get(view, ()) + COMMON_READS + VIEW_READS.get(view, ())


def validate_action(
    name: str, args: dict[str, Any], state: ScreenState, catalogue: list[str]
) -> dict[str, Any]:
    """Check one proposed action against the view on screen; return it, or raise.

    Raises `ActionError` with a reader-facing reason, which callers hand straight
    back to the model so it learns what actually happened.
    """
    view = state.view
    if name not in ACTION_TOOLS:
        raise ActionError(f"There is no {name!r} action.")
    if name not in tools_for(view):
        owners = [v for v in VIEWS if name in VIEW_ACTIONS[v]]
        raise ActionError(
            f"{name.replace('_', ' ').capitalize()} is a {' or '.join(owners)}-view control, "
            f"and the {view} view is on screen. Switch views first, or ask for something "
            "this view can do."
        )
    validator = _VALIDATORS.get((view, name)) or _VALIDATORS[("*", name)]
    action = validator(args or {}, state, catalogue)
    action["scope"] = view
    return action


def advance_state(state: ScreenState, action: dict[str, Any]) -> bool:
    """Carry one applied action into the server's copy of the screen.

    Later actions in the same turn are validated against the result, so "show
    chlorophyll, then the volume" is refused at the second step, as the chunk's
    own panel would. Returns True when the view changed, which is the loop's cue
    to plan the next round against that view's tools.
    """
    kind, scope, before = action["type"], action.get("scope"), state.view
    chunk = state.chunk

    if kind == "set_view":
        state.view = action["view"]
    elif kind in ("open_chunk", "move_chunk"):
        state.view = "chunk"
        chunk.bbox = snap_tile(action["lon"], action["lat"])
    elif kind == "set_layers":
        layers = [l for l in state.map.layers if l.get("key") not in action["remove"]]
        for key in action["add"]:
            layers.insert(0, {"key": key, "visible": True, "opacity": 1.0})
        for layer in layers:
            if layer.get("key") in action["show"]:
                layer["visible"] = True
            if layer.get("key") in action["hide"]:
                layer["visible"] = False
        state.map.layers = layers
    elif kind == "set_time":
        if scope == "map":
            state.map.time = action["time"]
        elif scope == "globe":
            state.globe.time = action["time"]
        else:
            chunk.time = action["time"]
    elif kind == "set_depth" and state.map.active:
        state.map.active = {**state.map.active, "depth_m": action["depth_m"]}
    elif kind == "set_pin":
        state.map.pin = {"lat": action["lat"], "lon": action["lon"]}
    elif kind == "select_float":
        state.globe.selected = action["platform_id"]
    elif kind == "clear_selection":
        state.globe.selected = None
    elif kind == "show_variable":
        chunk.variable = action["variable"]
        if chunk.variable in SURFACE_ONLY_CHUNK_VARIABLES:
            chunk.mode = "slices"
            chunk.cut = {**chunk.cut, "axis": "depth"}
    elif kind == "set_display":
        chunk.mode = action["mode"]
    elif kind == "set_cut":
        chunk.cut = {"axis": action["axis"], "value": action["value"]}
    elif kind == "set_iso_value":
        chunk.iso_value = action["value"]
        chunk.mode = "isosurface"
    elif kind == "set_exaggeration":
        chunk.exaggeration = action["value"]
    elif kind == "set_camera":
        chunk.camera = action["preset"]
    elif kind == "set_layer":
        current = dict(chunk.layers.get(action["layer"], {}))
        current.update({k: action[k] for k in ("visible", "opacity") if k in action})
        chunk.layers = {**chunk.layers, action["layer"]: current}
    elif kind == "open_float":
        chunk.open_float = action["platform_id"]
    elif kind == "set_colour_scale":
        chunk.colour = {**chunk.colour, **{k: action[k] for k in ("min", "max", "scale", "auto") if k in action}}
    return state.view != before


# --------------------------------------------------------------------------
# The confirmation a command turn ends with
# --------------------------------------------------------------------------
#
# A turn made only of successful actions does not spend a second model round on
# a sentence (decided 2026-09-10): the sentence is composed here, from what was
# validated, in the §5.3 voice the prompt asks the model for.

_MODE_WORDS = {"slices": "Showing slices.", "volume": "Showing the volume.", "isosurface": "Switched to the isosurface."}
_CAMERA_WORDS = {"corner": "corner", "top": "top-down", "section": "section"}
_VIEW_WORDS = {"map": "the map", "globe": "the globe", "chunk": "the chunk view"}


def _describe(action: dict[str, Any]) -> str:
    kind = action["type"]
    if kind == "set_layers":
        parts = [f"Added {k}." for k in action["add"]]
        parts += [f"Removed {k}." for k in action["remove"]]
        parts += [f"Showing {k}." for k in action["show"]]
        parts += [f"Hid {k}." for k in action["hide"]]
        parts += [f"Set {k} to {round(v * 100)}% opacity." for k, v in action["opacity"].items()]
        return " ".join(parts) or "The layers were already as asked."
    if kind == "set_time":
        return f"Date set to {fmt_date(action['time'])}."
    if kind == "set_depth":
        note = "" if abs(action["depth_m"] - action["requested_m"]) < 0.5 else (
            f" (the nearest level to {action['requested_m']:g} m)"
        )
        return f"Showing {action['depth_m']:g} m{note}."
    if kind == "zoom_to_region":
        return f"Moved the map to {action['label']}."
    if kind == "set_pin":
        return f"Dropped the pin at {fmt_point(action['lat'], action['lon'])}."
    if kind == "set_area":
        (la, lb), (oa, ob) = action["lat_range"], action["lon_range"]
        return f"Selected {la:g}–{lb:g}°N, {oa:g}–{ob:g}°E."
    if kind == "set_view":
        return f"Switched to {_VIEW_WORDS[action['view']]}."
    if kind == "open_chunk":
        return f"Opened the chunk over {action['label']}."
    if kind == "select_float":
        return f"Opened the model comparison for float {action['platform_id']}."
    if kind == "clear_selection":
        return "Closed the float comparison."
    if kind == "show_variable":
        return f"Showing {'current speed' if action['variable'] == 'speed' else action['variable']}."
    if kind == "set_display":
        return _MODE_WORDS[action["mode"]]
    if kind == "set_cut":
        unit = "m" if action["axis"] == "depth" else ("°E" if action["axis"] == "lon" else "°N")
        return f"Cut plane moved to {action['value']:g} {unit}.".replace(" °", "°")
    if kind == "set_iso_value":
        return f"Isosurface at {action['value']:g}."
    if kind == "set_exaggeration":
        return f"Vertical exaggeration {action['value']:g}×."
    if kind == "set_camera":
        return f"Camera set to {_CAMERA_WORDS[action['preset']]}."
    if kind == "set_layer":
        name = CHUNK_LAYERS[action["layer"]]
        parts = []
        if "visible" in action:
            parts.append(f"{'Showing' if action['visible'] else 'Hid'} {name}.")
        if "opacity" in action:
            parts.append(f"Set {name} to {round(action['opacity'] * 100)}% opacity.")
        return " ".join(parts)
    if kind == "set_colour_scale":
        parts = []
        if action.get("auto"):
            parts.append("Colour range set to this chunk's own range.")
        if "min" in action:
            parts.append(f"Colour range {action['min']:g} to {action['max']:g}.")
        if "scale" in action:
            parts.append(f"{action['scale'].capitalize()} colour scale.")
        return " ".join(parts)
    if kind == "open_float":
        return f"Opened float {action['platform_id']}'s cast against the model."
    if kind == "move_chunk":
        return f"Moved one chunk {action['direction']}."
    return ""


def describe_actions(actions: list[dict[str, Any]]) -> str:
    return " ".join(p for p in (_describe(a) for a in actions) if p) or "Done."


# --------------------------------------------------------------------------
# Declarations handed to Gemini
# --------------------------------------------------------------------------
#
# Written for the model, and they earn their length: the difference between
# "gets a value" and a sentence saying the value is a real measurement from a
# named grid cell is the difference between the model fetching and recalling.

def _fn(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {
        "type": "function",
        "name": name,
        "description": description,
        "parameters": {"type": "object", "properties": properties, "required": required},
    }


_STR = {"type": "string"}
_NUM = {"type": "number"}
_KEYS = {"type": "array", "items": {"type": "string"}}
_REGIONS = [r["label"] for r in NAMED_REGIONS.values()]

_COMMON_DECLS: dict[str, dict] = {
    "set_view": _fn(
        "set_view",
        "Switch to the 2D map, the 3D globe, or the chunk view. After switching, the "
        "next step offers that view's own controls.",
        {"view": {**_STR, "enum": list(VIEWS)}},
        ["view"],
    ),
    "open_chunk": _fn(
        "open_chunk",
        "Open the 3D chunk view on one 5-degree block of ocean, surface to 2000 m. "
        "Give a listed region, or lat and lon ONLY when the reader stated coordinates. "
        "Never supply coordinates of your own for a place name.",
        {
            "region": {**_STR, "enum": _REGIONS},
            "lat": {**_NUM, "description": "Only a latitude the reader gave."},
            "lon": {**_NUM, "description": "Only a longitude the reader gave."},
        },
        [],
    ),
    "query_point": _fn(
        "query_point",
        "Read a real value at one location from the dataset this view draws, at its "
        "native grid cell. Returns the value, the cell it came from and its provenance. "
        "You MUST call this before stating any measurement at a location — never state "
        "one from memory. Date, variable and depth default to what is on screen.",
        {
            "lat": {**_NUM, "description": "Latitude, -90 to 90."},
            "lon": {**_NUM, "description": "Longitude, -180 to 180."},
            "variable": {**_STR, "description": "Variable key, e.g. temperature."},
            "depth_m": {**_NUM, "description": "Depth in metres. Omit for the view's depth."},
            "time": {**_STR, "description": "ISO date. Omit for the date on screen."},
        },
        ["lat", "lon"],
    ),
    "list_floats": _fn(
        "list_floats",
        "List the Argo floats reporting in a window and area, with positions and ids. "
        "Window and area default to what this view shows.",
        {
            "time_start": _STR, "time_end": _STR,
            "lat_min": _NUM, "lat_max": _NUM, "lon_min": _NUM, "lon_max": _NUM,
        },
        [],
    ),
    "compare_float": _fn(
        "compare_float",
        "Compare the INCOIS model analysis against one Argo float's real cast at the same "
        "place and time — the model-vs-observation comparison the platform exists for.",
        {"platform_id": {**_STR, "description": "Float id, e.g. 2901335."}, "variable": _STR, "cycle": {"type": "integer"}},
        ["platform_id"],
    ),
}

_VIEW_DECLS: dict[str, dict[str, dict]] = {
    "map": {
        "set_layers": _fn(
            "set_layers",
            "Change the map's layers: add, remove, show or hide by variable key, or set "
            "opacity. At most three layers.",
            {
                "add": {**_KEYS, "description": "Variable keys to add."},
                "remove": {**_KEYS, "description": "Variable keys to remove entirely."},
                "show": {**_KEYS, "description": "Existing layers to make visible."},
                "hide": {**_KEYS, "description": "Existing layers to hide (kept in the stack)."},
                "opacity": {"type": "object", "description": "Variable key to 0-1 opacity."},
            },
            [],
        ),
        "set_time": _fn(
            "set_time",
            "Set the map's date. Each layer resolves it to its own nearest step.",
            {"time": {**_STR, "description": "ISO date, e.g. 2013-10-12."}},
            ["time"],
        ),
        "set_depth": _fn(
            "set_depth",
            "Set the depth the map's active layer shows, in metres. It snaps to the "
            "nearest level that layer's grid really has.",
            {"depth_m": _NUM},
            ["depth_m"],
        ),
        "zoom_to_region": _fn(
            "zoom_to_region",
            "Move the map to a listed region. If the reader names somewhere else, say so "
            "rather than guessing coordinates.",
            {"region": {**_STR, "enum": _REGIONS}},
            ["region"],
        ),
        "set_pin": _fn(
            "set_pin",
            "Drop the map's inspection pin at a coordinate, opening its point readout. Only "
            "when the reader asks for the pin or the readout — a value question needs "
            "query_point, not a pin.",
            {"lat": _NUM, "lon": _NUM},
            ["lat", "lon"],
        ),
        "set_area": _fn(
            "set_area",
            "Select a rectangular area on the map.",
            {"lat_range": {"type": "array", "items": _NUM}, "lon_range": {"type": "array", "items": _NUM}},
            ["lat_range", "lon_range"],
        ),
    },
    "globe": {
        "set_time": _fn(
            "set_time",
            "Set the globe's date, inside the scenario window. The floats shown follow it.",
            {"time": {**_STR, "description": "ISO date, e.g. 2013-10-11."}},
            ["time"],
        ),
        "select_float": _fn(
            "select_float",
            "Open the model-vs-observation panel for one float reporting on the globe.",
            {"platform_id": _STR},
            ["platform_id"],
        ),
        "clear_selection": _fn("clear_selection", "Close the float comparison panel.", {}, []),
    },
    "chunk": {
        "show_variable": _fn(
            "show_variable",
            "Show a different variable in the chunk: temperature, salinity, speed (current "
            "speed) or chlorophyll (surface only).",
            {"variable": {**_STR, "enum": list(CHUNK_VARIABLES)}},
            ["variable"],
        ),
        "set_time": _fn(
            "set_time",
            "Step the chunk to a date inside its 30-day window.",
            {"time": {**_STR, "description": "ISO date, e.g. 2013-10-11."}},
            ["time"],
        ),
        "set_display": _fn(
            "set_display",
            "Choose how the chunk draws its field: slices, volume or isosurface.",
            {"mode": {**_STR, "enum": list(CHUNK_MODES)}},
            ["mode"],
        ),
        "set_cut": _fn(
            "set_cut",
            "Move the cut plane: along depth (metres), lon or lat (degrees, inside the tile).",
            {"axis": {**_STR, "enum": list(CHUNK_CUT_AXES)}, "value": _NUM},
            ["axis", "value"],
        ),
        "set_iso_value": _fn(
            "set_iso_value",
            "Draw the isosurface at a value, in the variable's units, and switch to it.",
            {"value": _NUM},
            ["value"],
        ),
        "set_exaggeration": _fn(
            "set_exaggeration", "Set the vertical exaggeration, 10 to 200 times.", {"value": _NUM}, ["value"]
        ),
        "set_camera": _fn(
            "set_camera",
            "Move the camera to a preset: corner, top (top-down) or section.",
            {"preset": {**_STR, "enum": list(CHUNK_CAMERAS)}},
            ["preset"],
        ),
        "set_layer": _fn(
            "set_layer",
            "Show, hide or fade one of the chunk's layers: scalar (the field), currents, "
            "bathy (the seabed) or instruments (the Argo float tracks).",
            {
                "layer": {**_STR, "enum": list(CHUNK_LAYERS)},
                "visible": {"type": "boolean"},
                "opacity": {**_NUM, "description": "0 to 1."},
            },
            ["layer"],
        ),
        "set_colour_scale": _fn(
            "set_colour_scale",
            "Change the chunk's colour scale: auto (this chunk's own range), a min and max, "
            "or linear/log.",
            {"auto": {"type": "boolean"}, "min": _NUM, "max": _NUM, "scale": {**_STR, "enum": ["linear", "log"]}},
            [],
        ),
        "open_float": _fn(
            "open_float",
            "Open one float's measured cast against the model column in this chunk, as "
            "clicking its track does. Only floats with a track in this chunk.",
            {"platform_id": _STR},
            ["platform_id"],
        ),
        "move_chunk": _fn(
            "move_chunk",
            "Open the neighbouring chunk to the north, south, east or west.",
            {"direction": {**_STR, "enum": list(_STEPS)}},
            ["direction"],
        ),
        "describe_chunk": _fn(
            "describe_chunk",
            "Summarise the chunk on screen: per-depth mean, minimum and maximum, and where "
            "the strongest vertical change is (the thermocline for temperature). Give "
            "depth_m for one level, with where its extremes sit.",
            {"variable": _STR, "depth_m": _NUM},
            [],
        ),
    },
}


def declarations_for(view: str) -> list[dict]:
    """The function declarations one turn on this view is offered."""
    own = _VIEW_DECLS.get(view, {})
    return [own.get(name) or _COMMON_DECLS[name] for name in tools_for(view)]
