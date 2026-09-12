"""Read tools: the only way the assistant gets numbers.

They call the same functions as the HTTP API, so the assistant and the UI always
agree. Each result has a provenance block (dataset, time, depth, units) that the
citation line is built from.

On the map and globe a variable resolves to the preferred source that covers the
date (same as the map) and we read one native cell at one level. In the chunk
view we sample the HYCOM volume that's already loaded.

Results are kept small so we don't waste tokens.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any, Callable

import numpy as np
from fastapi import HTTPException

from .. import config
from ..erddap_client import UpstreamRefused, UpstreamUnavailable
from .tools import CHUNK_MAX_DEPTH, CHUNK_VARIABLES, ScreenState, choose, fmt_date, fmt_point


# Version of the read output format. It's part of the cache key, so bump it
# whenever a read's output changes or old cached rows keep getting served.
RESULT_VERSION = 2


class ReadError(Exception):
    """A read that failed, with a reason that can be shown to the user."""


def _catalogue_keys() -> list[str]:
    return sorted({d.variable_key for d in config.MAP_DATASETS if d.variable_key})


def _provenance(ds: Any, *, time: str | None, depth: float | None, units: str | None) -> dict[str, Any]:
    """The citation block. Always included."""
    return {
        "dataset": ds.id,
        "label": ds.label,
        "provider": ds.provider,
        "time": time,
        "depth_m": None if depth is None else round(float(depth), 1),
        "units": units or getattr(ds, "units", None),
    }


def _offset_km(lat: float, lon: float, cell_lat: float, cell_lon: float) -> float:
    dlat = cell_lat - lat
    dlon = (cell_lon - lon) * math.cos(math.radians(lat))
    return round(math.hypot(dlat, dlon) * 111.32, 2)


def _lat_lon(args: dict[str, Any]) -> tuple[float, float]:
    try:
        lat, lon = float(args["lat"]), float(args["lon"])
    except (KeyError, TypeError, ValueError):
        raise ReadError("A point needs a latitude and a longitude.") from None
    if not -90 <= lat <= 90 or not -180 <= lon <= 180:
        raise ReadError(f"{lat}, {lon} is not a place on the planet.")
    return lat, lon


def _depth_arg(args: dict[str, Any]) -> float | None:
    raw = args.get("depth_m")
    if raw is None:
        return None
    try:
        depth = float(raw)
    except (TypeError, ValueError):
        raise ReadError(f"{raw!r} is not a depth in metres.") from None
    if depth < 0:
        raise ReadError("Depth is measured down from the surface, in positive metres.")
    return depth


def _read_point_value(ds: Any, **kw: Any):
    """One native cell from whichever upstream serves ``ds``, with clear error messages."""
    from ..ingestion import cmems, erddap_map

    source = cmems if ds.protocol == "cmems" else erddap_map
    try:
        return source.fetch_point_value(ds=ds, **kw)
    except UpstreamRefused as exc:
        raise ReadError(f"{ds.provider} refused this request (HTTP {exc.status}).") from None
    except UpstreamUnavailable as exc:
        raise ReadError(f"{ds.provider} did not answer, and this value is not cached. {exc}") from None


def _point_result(ds: Any, pv: Any, lat: float, lon: float, day: str) -> dict[str, Any]:
    if pv.value is None:
        raise ReadError(
            f"No {ds.label.lower()} at {fmt_point(lat, lon)} on {fmt_date(day)}: the nearest "
            "cell is land or has no data."
        )
    out: dict[str, Any] = {
        "value": round(pv.value, 4),
        "units": ds.units,
        "requested": {"lat": lat, "lon": lon},
        "grid_cell": {"lat": round(pv.lat, 4), "lon": round(pv.lon, 4)},
        "offset_km": _offset_km(lat, lon, pv.lat, pv.lon),
        "provenance": _provenance(ds, time=day, depth=pv.depth, units=ds.units),
    }
    if pv.direction_deg is not None:
        out["quantity"] = "current speed"
        out["direction_towards_deg"] = round(pv.direction_deg, 1)
    return out


# --- query_point ---

def query_point(state: ScreenState, args: dict[str, Any]) -> dict[str, Any]:
    """A value at one place, from the dataset the current view shows."""
    lat, lon = _lat_lon(args)
    if state.view == "chunk":
        return _chunk_point(state, args, lat, lon)
    return _map_point(state, args, lat, lon)


def _default_map_variable(state: ScreenState) -> str:
    if state.view == "map":
        for layer in state.map.layers:
            if layer.get("visible", True) and layer.get("key"):
                return str(layer["key"])
    return "temperature"


def _map_point(state: ScreenState, args: dict[str, Any], lat: float, lon: float) -> dict[str, Any]:
    variable = str(args.get("variable") or _default_map_variable(state))
    day = str(args.get("time") or state.view_date())[:10]
    if not day:
        raise ReadError("No date to read — say which date you mean.")

    ds = config.map_dataset_for(variable, day)
    if ds is None:
        known = _catalogue_keys()
        if variable not in known:
            raise ReadError(f"No dataset serves {variable!r}. Available: {', '.join(known)}.")
        spans = "; ".join(f"{p} {a} to {b}" for p, a, b in config.coverage_for(variable))
        raise ReadError(f"No source has {variable} on {day}. Coverage: {spans}.")

    depth = None
    if ds.depth_dim is not None:
        depth = _depth_arg(args)
        if depth is None:
            active = state.map.active or {}
            same = state.view == "map" and active.get("key") == variable
            depth = float(active["depth_m"]) if same and active.get("depth_m") is not None else 0.0

    pv = _read_point_value(ds, lat=lat, lon=lon, time=day, depth=depth)
    return _point_result(ds, pv, lat, lon, day)


def _chunk_source(variable: str):
    from ..routers import chunk as chunk_router

    try:
        return chunk_router._dataset(variable)
    except HTTPException as exc:
        raise ReadError(str(exc.detail)) from None


def _chunk_volume(ds: Any, variable: str, day: str, bbox: list[float]):
    """Chunk data as the view loaded it (same function, same cache)."""
    from ..routers import chunk as chunk_router

    tile = chunk_router._tile(bbox[0], bbox[1])
    try:
        return chunk_router._volume(ds, variable, day, tile)
    except HTTPException as exc:
        raise ReadError(str(exc.detail)) from None


def _chunk_variable(state: ScreenState, args: dict[str, Any]) -> str:
    raw = args.get("variable") or state.chunk.variable
    variable = choose("variable", raw, CHUNK_VARIABLES)
    if variable is None:
        raise ReadError(f"The chunk serves {', '.join(CHUNK_VARIABLES)}; {raw!r} is not one of them.")
    return variable


def _chunk_point(state: ScreenState, args: dict[str, Any], lat: float, lon: float) -> dict[str, Any]:
    variable = _chunk_variable(state, args)
    day = str(args.get("time") or state.chunk.time)[:10]
    if not day:
        raise ReadError("No date to read — say which date you mean.")
    depth = _depth_arg(args) or 0.0
    if depth > CHUNK_MAX_DEPTH:
        raise ReadError(f"The chunk runs from the surface to {CHUNK_MAX_DEPTH:.0f} m.")
    ds = _chunk_source(variable)

    lon0, lat0, lon1, lat1 = state.chunk.bbox
    if not (lon0 <= lon <= lon1 and lat0 <= lat <= lat1):
        # Outside the open tile: read one level instead of fetching a whole neighbouring chunk.
        pv = _read_point_value(
            ds, lat=lat, lon=lon, time=day, depth=depth if ds.depth_dim is not None else None
        )
        return _point_result(ds, pv, lat, lon, day)

    values, depths, lats, lons, *_ = _chunk_volume(ds, variable, day, state.chunk.bbox)
    k = int(np.argmin(np.abs(np.asarray(depths, dtype=float) - depth)))
    i = int(np.argmin(np.abs(np.asarray(lats, dtype=float) - lat)))
    j = int(np.argmin(np.abs(np.asarray(lons, dtype=float) - lon)))
    value = float(values[k, i, j])
    cell = {"lat": round(float(lats[i]), 4), "lon": round(float(lons[j]), 4), "depth_m": round(float(depths[k]), 1)}
    if not math.isfinite(value):
        raise ReadError(
            f"No {variable} at {fmt_point(lat, lon)}, {cell['depth_m']:g} m: that cell is land "
            "or below the seabed."
        )
    return {
        "value": round(value, 4),
        "units": ds.units,
        "requested": {"lat": lat, "lon": lon, "depth_m": depth},
        "grid_cell": cell,
        "offset_km": _offset_km(lat, lon, cell["lat"], cell["lon"]),
        "provenance": _provenance(ds, time=day, depth=cell["depth_m"], units=ds.units),
    }


# --- describe_chunk ---

def describe_chunk(state: ScreenState, args: dict[str, Any]) -> dict[str, Any]:
    """Summary of the chunk per depth level, enough to find the thermocline."""
    variable = _chunk_variable(state, args)
    day = str(state.chunk.time)[:10]
    ds = _chunk_source(variable)
    values, depths, lats, lons, *_ = _chunk_volume(ds, variable, day, state.chunk.bbox)

    levels: list[dict[str, Any]] = []
    indices: list[int] = []
    for k, d in enumerate(depths):
        finite = values[k][np.isfinite(values[k])]
        if finite.size == 0:
            continue
        indices.append(k)
        levels.append({
            "depth_m": round(float(d), 1),
            "mean": round(float(finite.mean()), 3),
            "min": round(float(finite.min()), 3),
            "max": round(float(finite.max()), 3),
        })
    if not levels:
        raise ReadError(f"This chunk has no {variable} on {fmt_date(day)}.")

    out: dict[str, Any] = {
        "variable": variable,
        "units": ds.units,
        "bbox": list(state.chunk.bbox),
        "time": day,
        "provenance": _provenance(ds, time=day, depth=None, units=ds.units),
    }

    target = _depth_arg(args)
    if target is not None:
        n = min(range(len(levels)), key=lambda n: abs(levels[n]["depth_m"] - target))
        layer = values[indices[n]]
        lo = np.unravel_index(np.nanargmin(layer), layer.shape)
        hi = np.unravel_index(np.nanargmax(layer), layer.shape)
        out["level"] = {
            **levels[n],
            "min_at": {"lat": round(float(lats[lo[0]]), 4), "lon": round(float(lons[lo[1]]), 4)},
            "max_at": {"lat": round(float(lats[hi[0]]), 4), "lon": round(float(lons[hi[1]]), 4)},
        }
        return out

    out["levels"] = levels
    if len(levels) >= 3:
        def rate(n: int) -> float:
            a, b = levels[n], levels[n + 1]
            return abs(b["mean"] - a["mean"]) / max(b["depth_m"] - a["depth_m"], 1e-6)

        n = max(range(len(levels) - 1), key=rate)
        a, b = levels[n], levels[n + 1]
        out["strongest_vertical_gradient"] = {
            "from_m": a["depth_m"],
            "to_m": b["depth_m"],
            "change_per_100m": round((b["mean"] - a["mean"]) / (b["depth_m"] - a["depth_m"]) * 100, 3),
        }
    return out


# --- Floats and the model comparison ---

def _float_defaults(state: ScreenState) -> dict[str, Any]:
    """Default time window and box for "which floats are reporting", per view."""
    if state.view == "chunk":
        lon0, lat0, lon1, lat1 = state.chunk.bbox
        out: dict[str, Any] = {"lat_min": lat0, "lat_max": lat1, "lon_min": lon0, "lon_max": lon1}
        if len(state.chunk.window) == 2:
            out.update(time_start=state.chunk.window[0][:10], time_end=state.chunk.window[1][:10])
        return out
    if state.view == "globe" and len(state.globe.window) == 2:
        return {"time_start": state.globe.window[0][:10], "time_end": state.globe.window[1][:10]}
    day = state.map.time[:10] if state.view == "map" else ""
    if not day:
        return {}
    try:
        centre = datetime.fromisoformat(day)
    except ValueError:
        return {}
    return {
        "time_start": (centre - timedelta(days=15)).date().isoformat(),
        "time_end": (centre + timedelta(days=15)).date().isoformat(),
    }


def list_floats(state: ScreenState, args: dict[str, Any]) -> dict[str, Any]:
    """Which floats are reporting."""
    from ..routers.instruments import list_instruments

    defaults = _float_defaults(state)
    keys = ("time_start", "time_end", "lat_min", "lat_max", "lon_min", "lon_max")
    query = {k: args.get(k) if args.get(k) is not None else defaults.get(k) for k in keys}
    try:
        result = list_instruments(**query)
    except HTTPException as exc:
        raise ReadError(str(exc.detail)) from None

    platforms = getattr(result, "platforms", []) or []
    seen: dict[str, Any] = {}
    for p in platforms:
        seen.setdefault(getattr(p, "platform_id", None), p)
    unique = list(seen.values())
    return {
        "count": len(unique),
        "window": {"start": query["time_start"], "end": query["time_end"]},
        "platforms": [
            {
                "platform_id": getattr(p, "platform_id", None),
                "platform_type": getattr(p, "platform_type", None),
                "lat": getattr(p, "lat", None),
                "lon": getattr(p, "lon", None),
            }
            for p in unique[:25]
        ],
        "truncated": len(unique) > 25,
        "provenance": {"dataset": "Indian_ARGO_Floats", "provider": "INCOIS ERDDAP"},
    }


# Standard depths we send to the model instead of all ~150 measured levels.
_STANDARD_DEPTHS = (0, 10, 20, 50, 75, 100, 150, 200, 300, 500, 1000, 2000)


def _at_standard_depths(levels: list[dict[str, float]]) -> list[dict[str, float]]:
    out: list[dict[str, float]] = []
    used: set[int] = set()
    for target in _STANDARD_DEPTHS:
        best = min(range(len(levels)), key=lambda i: abs(levels[i]["depth"] - target), default=None)
        if best is None or best in used:
            continue
        level = levels[best]
        if abs(level["depth"] - target) > max(10.0, target * 0.25):
            continue
        used.add(best)
        out.append({"depth_m": round(float(level["depth"]), 1), "value": round(float(level["value"]), 3)})
    return out


def compare_float(_state: ScreenState, args: dict[str, Any]) -> dict[str, Any]:
    """Float vs model at the same place and time, with a citation, kept compact."""
    from ..routers.instruments import compare

    platform_id = str(args.get("platform_id", "")).strip()
    if not platform_id:
        raise ReadError("Which float? Give a platform id, or ask which are reporting.")
    try:
        result = compare(
            platform_id=platform_id,
            variable=str(args.get("variable") or "temperature"),
            cycle=args.get("cycle"),
        )
    except HTTPException as exc:
        raise ReadError(str(exc.detail)) from None

    residual = result.get("residual") or []
    summary = None
    if residual:
        largest = max(residual, key=lambda r: abs(r["value"]))
        summary = {
            "mean": round(sum(r["value"] for r in residual) / len(residual), 3),
            "largest": {"depth_m": round(float(largest["depth"]), 1), "value": round(float(largest["value"]), 3)},
            "levels_compared": len(residual),
        }
    model_time = str(result.get("model_time") or "")[:10]
    return {
        "variable": result.get("variable"),
        "units": result.get("units"),
        "platform_id": result.get("platform_id"),
        "cycle_number": result.get("cycle_number"),
        "observed_time": result.get("observed_time"),
        "model_time": model_time,
        "float_position": {"lat": result.get("lat"), "lon": result.get("lon")},
        "model_cell": result.get("grid_point"),
        "observed": _at_standard_depths(result.get("observed") or []),
        "model": _at_standard_depths(result.get("model") or []),
        "residual_summary": summary,
        "note": "Residual is observation minus analysis, on the float's own levels.",
        "provenance": {
            "dataset": config.GRID_DATASET,
            "label": f"INCOIS analysis against Argo {result.get('platform_id')}",
            "provider": "INCOIS ERDDAP",
            "time": model_time,
            "depth_m": None,
            "units": result.get("units"),
        },
    }


READ_TOOLS: dict[str, Callable[[ScreenState, dict[str, Any]], Any]] = {
    "query_point": query_point,
    "list_floats": list_floats,
    "compare_float": compare_float,
    "describe_chunk": describe_chunk,
}


def cache_context(name: str, state: ScreenState) -> dict[str, Any]:
    """Screen facts a read depends on besides its arguments (e.g. the date). Part of
    the cache key so changing the date doesn't return an old answer.
    """
    if name == "compare_float":
        return {}
    context: dict[str, Any] = {"view": state.view, "date": state.view_date()}
    if state.view == "chunk":
        context.update(bbox=list(state.chunk.bbox), variable=state.chunk.variable)
    elif state.view == "map":
        context.update(
            active=state.map.active,
            layers=[l.get("key") for l in state.map.layers if l.get("visible", True)],
        )
    return context


def status_for(name: str, args: dict[str, Any], state: ScreenState) -> str:
    """Status text shown in the panel while a tool runs."""
    if name == "query_point":
        try:
            where = fmt_point(float(args.get("lat")), float(args.get("lon")))
        except (TypeError, ValueError):
            where = "that point"
        if state.view == "chunk":
            return f"Reading the chunk at {where}…"
        day = str(args.get("time") or state.view_date())[:10]
        ds = config.map_dataset_for(str(args.get("variable") or _default_map_variable(state)), day or None)
        if ds is None:
            return f"Checking coverage at {where}…"
        if ds.protocol == "cmems":
            return f"Reading {ds.provider} at {where} (a first read of a date takes a few seconds)…"
        return f"Reading {ds.provider} at {where}…"
    if name == "describe_chunk":
        return "Summarising this chunk…"
    if name == "list_floats":
        return "Finding floats reporting in this window…"
    if name == "compare_float":
        return f"Comparing float {args.get('platform_id')} against the model…"
    return "Updating the view…"
