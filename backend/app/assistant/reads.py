"""Read tools: the only way the assistant is allowed to learn a number.

Each one calls the same handler the HTTP API calls — not over HTTP, just the
function — so the assistant and the UI can never disagree about what a dataset
says. Every result carries a `provenance` block naming the dataset, the time,
the depth and the units, because the panel builds its citation line from these
and not from the prose. That is the mechanism behind context.md §5.1's rule
that a stated measurement must have been fetched: an answer with no tool call
has no provenance to render, and is marked as general knowledge instead.

Results are deliberately small. The model does not need 40 depth levels x 60
days to answer "is the water warm here" — it needs the surface value, the
range, and where they came from. Sending the whole block would spend the
free-tier token budget on numbers nobody reads.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from ..config import MAP_DATASETS, MAP_DATASETS_BY_ID


class ReadError(Exception):
    """A read that could not be served, with a reason fit to show a reader."""


def _dataset_for(variable_key: str) -> Any:
    """Resolve a variable to the map dataset that serves it best.

    Mirrors `map_dataset_for()` (context.md §10, 2026-09-05): a layer is a
    VARIABLE, and each view resolves it to whichever upstream serves it. The
    assistant asks for "chlorophyll", not for a dataset id it has no way to know.
    """
    matches = [d for d in MAP_DATASETS if d.variable_key == variable_key]
    if not matches:
        known = sorted({d.variable_key for d in MAP_DATASETS if d.variable_key})
        raise ReadError(
            f"No dataset serves {variable_key!r}. Available: {', '.join(known)}."
        )
    # MAP_DATASETS is ordered by preference, so the first match is the best one.
    return matches[0]


def _provenance(ds: Any, *, time: str | None = None, depth: float | None = None,
                units: str | None = None) -> dict[str, Any]:
    """The citation block. Never omitted — it is what makes an answer checkable."""
    return {
        "dataset": ds.id,
        "label": ds.label,
        "provider": ds.provider,
        "time": time,
        "depth_m": depth,
        "units": units or getattr(ds, "units", None),
    }


# --------------------------------------------------------------------------
# Tools
# --------------------------------------------------------------------------

def search_variables(_state: Any, args: dict[str, Any]) -> dict[str, Any]:
    """What can be drawn at all. Grounds every later request in real keys."""
    query = str(args.get("query", "")).strip().lower()
    out = []
    for ds in MAP_DATASETS:
        if not ds.variable_key:
            continue
        if query and query not in ds.variable_key.lower() and query not in ds.label.lower():
            continue
        out.append(
            {
                "variable_key": ds.variable_key,
                "label": ds.label,
                "provider": ds.provider,
                "units": getattr(ds, "units", None),
            }
        )
    return {"variables": out}


def get_screen_state(state: Any, _args: dict[str, Any]) -> dict[str, Any]:
    """What the reader is currently looking at.

    Not a fetch — it is the snapshot the frontend sent with this message. It is
    a tool rather than part of the prompt so the model asks for it only when the
    question is actually about the screen, which keeps the cached prefix stable.
    """
    return {
        "view": state.view,
        "layers": state.layers,
        "time": state.time,
        "depth_m": state.depth_m,
    }


def query_point(state: Any, args: dict[str, Any]) -> dict[str, Any]:
    """A real measured value at one grid cell, with the cell it actually came from."""
    from ..routers.map import point as point_handler

    variable = str(args.get("variable") or "temperature")
    ds = _dataset_for(variable)
    lat, lon = float(args["lat"]), float(args["lon"])
    time = str(args.get("time") or state.time or "")[:10]
    if not time:
        raise ReadError("No date to query — set one, or say which date you mean.")

    try:
        block = point_handler(
            dataset=ds.id, lat=lat, lon=lon,
            time_start=time, time_end=time, surface_only=True,
        )
    except HTTPException as exc:  # the handler already writes reader-facing detail
        raise ReadError(str(exc.detail)) from None

    values = getattr(block, "values", None) or []
    surface = values[0] if values else None
    first = surface[0] if isinstance(surface, list) and surface else surface

    return {
        "value": first,
        "requested": {"lat": lat, "lon": lon},
        # Stated, not implied: a readout is a cell, not an interpolation.
        "grid_cell": {"lat": getattr(block, "lat", None), "lon": getattr(block, "lon", None)},
        "offset_km": getattr(block, "offset_km", None),
        "provenance": _provenance(ds, time=time, depth=0.0, units=getattr(block, "units", None)),
    }


def list_floats(state: Any, args: dict[str, Any]) -> dict[str, Any]:
    """Which in-situ platforms are reporting — the observation half of the brief."""
    from ..routers.instruments import list_instruments

    try:
        result = list_instruments(
            time_start=args.get("time_start"), time_end=args.get("time_end"),
            lat_min=args.get("lat_min"), lat_max=args.get("lat_max"),
            lon_min=args.get("lon_min"), lon_max=args.get("lon_max"),
        )
    except HTTPException as exc:
        raise ReadError(str(exc.detail)) from None

    platforms = getattr(result, "platforms", []) or []
    return {
        "count": len(platforms),
        "platforms": [
            {
                "platform_id": getattr(p, "platform_id", None),
                "platform_type": getattr(p, "platform_type", None),
                "lat": getattr(p, "lat", None),
                "lon": getattr(p, "lon", None),
            }
            for p in platforms[:25]
        ],
        "truncated": len(platforms) > 25,
        "provenance": {"dataset": "Indian_ARGO_Floats", "provider": "INCOIS ERDDAP"},
    }


def compare_float(_state: Any, args: dict[str, Any]) -> dict[str, Any]:
    """Model against measurement at the same place and time — the whole point of the tool."""
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
    return result


READ_TOOLS = {
    "get_screen_state": get_screen_state,
    "search_variables": search_variables,
    "query_point": query_point,
    "list_floats": list_floats,
    "compare_float": compare_float,
}
