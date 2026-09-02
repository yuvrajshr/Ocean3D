"""Gridded field endpoints.

Metadata and values are split on purpose. The metadata is small JSON matching
context.md §6.1 and carries a ``data_url``; the values travel as a raw
Float32Array (~259 KB for a full volume) rather than JSON (~8 MB). The browser
uploads that buffer straight into a 3D texture with no parsing step.
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter, HTTPException, Query, Response

from ..config import HAZARD_VARIABLES, VARIABLES, VariableSpec
from ..erddap_client import UpstreamUnavailable
from ..ingestion import erddap_grid
from ..models.schemas import GridAxes, ModelFieldMeta

router = APIRouter()

_ALL: dict[str, VariableSpec] = {s.key: s for s in (*VARIABLES, *HAZARD_VARIABLES)}


def _spec(key: str) -> VariableSpec:
    spec = _ALL.get(key)
    if spec is None:
        raise HTTPException(404, f"Unknown variable '{key}'.")
    return spec


def _load(spec: VariableSpec, time: str, lat: tuple[float, float] | None, lon: tuple[float, float] | None):
    try:
        if spec.kind == "volume":
            return erddap_grid.fetch_volume(
                variable=spec.erddap_name, time=time, dataset_id=spec.dataset_id,
                lat_range=lat, lon_range=lon,
            )
        if spec.kind == "vector":
            u, v = spec.erddap_name.split(",")
            return erddap_grid.fetch_vector_magnitude(
                components=(u, v), dataset_id=spec.dataset_id, time=time,
                lat_range=lat, lon_range=lon,
            )
        return erddap_grid.fetch_surface(
            variable=spec.erddap_name, dataset_id=spec.dataset_id, time=time,
            lat_range=lat, lon_range=lon,
        )
    except UpstreamUnavailable as exc:
        raise HTTPException(
            503,
            "INCOIS ERDDAP is unreachable and this field has not been cached. "
            "Connect to the network once to fetch it.",
        ) from exc
    except (KeyError, ValueError) as exc:
        raise HTTPException(502, f"INCOIS returned an unexpected field shape: {exc}") from exc


def _bounds(
    lat_min: float | None, lat_max: float | None, lon_min: float | None, lon_max: float | None
) -> tuple[tuple[float, float] | None, tuple[float, float] | None]:
    lat = (lat_min, lat_max) if lat_min is not None and lat_max is not None else None
    lon = (lon_min, lon_max) if lon_min is not None and lon_max is not None else None
    return lat, lon


@router.get("/field/meta", response_model=ModelFieldMeta)
def field_meta(
    variable: str = Query(...),
    time: str = Query(...),
    lat_min: float | None = None,
    lat_max: float | None = None,
    lon_min: float | None = None,
    lon_max: float | None = None,
) -> ModelFieldMeta:
    spec = _spec(variable)
    lat, lon = _bounds(lat_min, lat_max, lon_min, lon_max)
    result = _load(spec, time, lat, lon)

    finite = result.values[np.isfinite(result.values)]
    if finite.size == 0:
        raise HTTPException(
            404,
            f"No {spec.label.lower()} data in this window. The analysis has no "
            "coverage here — try a wider area or another date.",
        )

    # Stretch the colour scale over the 2nd-98th percentile rather than the true
    # extremes. Some of these fields carry genuine outliers — geostrophic
    # currents diverge as 1/f toward the equator, and chlorophyll is strongly
    # skewed with most values below 1 mg/m3 — and a min/max scale lets a single
    # extreme cell wash out all the structure everyone actually needs to see.
    # The true range is still reported, and the UI says when clipping applied.
    low, high = (float(v) for v in np.percentile(finite, [2, 98]))
    true_low, true_high = float(np.nanmin(finite)), float(np.nanmax(finite))
    if not np.isfinite(low) or not np.isfinite(high) or high <= low:
        low, high = true_low, true_high
    clipped = low > true_low or high < true_high

    query = f"variable={variable}&time={time}"
    if lat and lon:
        query += f"&lat_min={lat[0]}&lat_max={lat[1]}&lon_min={lon[0]}&lon_max={lon[1]}"

    return ModelFieldMeta(
        variable=spec.key,
        label=spec.label,
        time=result.time,
        depth_levels=[float(d) for d in result.depths],
        grid=GridAxes(
            lat=[float(v) for v in result.lats],
            lon=[float(v) for v in result.lons],
        ),
        data_url=f"/api/field/data?{query}",
        units=spec.units,
        units_declared_by_us=spec.units_declared_by_us,
        value_range=(low, high),
        full_range=(true_low, true_high),
        clipped=clipped,
        colormap=spec.colormap,
        kind=spec.kind,
        shape=list(result.values.shape),
        source=result.source,
    )


@router.get("/field/data")
def field_data(
    variable: str = Query(...),
    time: str = Query(...),
    lat_min: float | None = None,
    lat_max: float | None = None,
    lon_min: float | None = None,
    lon_max: float | None = None,
) -> Response:
    """Raw little-endian Float32, C order (depth, lat, lon). NaN = no data."""
    spec = _spec(variable)
    lat, lon = _bounds(lat_min, lat_max, lon_min, lon_max)
    result = _load(spec, time, lat, lon)
    payload = np.ascontiguousarray(result.values, dtype="<f4").tobytes()
    return Response(
        content=payload,
        media_type="application/octet-stream",
        headers={
            "X-Field-Shape": ",".join(str(n) for n in result.values.shape),
            "X-Field-Provenance": result.source.provenance,
            "Cache-Control": "public, max-age=3600",
        },
    )
