"""Terrain endpoints. Small JSON metadata, plus the heightfield as raw Float32.

Bounds are optional; the default is the Bay of Bengal box. The default is in the
signature so the data_url always names the box you'll get.
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter, HTTPException, Query, Response

from ..config import TERRAIN_LAT_RANGE, TERRAIN_LON_RANGE, TERRAIN_STRIDE
from ..erddap_client import UpstreamUnavailable
from ..ingestion import etopo_terrain

router = APIRouter()


def _bounds(
    lat_min: float | None,
    lat_max: float | None,
    lon_min: float | None,
    lon_max: float | None,
) -> tuple[tuple[float, float], tuple[float, float]]:
    """All four bounds or none."""
    given = [v for v in (lat_min, lat_max, lon_min, lon_max) if v is not None]
    if not given:
        return TERRAIN_LAT_RANGE, TERRAIN_LON_RANGE
    if len(given) != 4:
        raise HTTPException(
            400,
            "Give all four of lat_min, lat_max, lon_min and lon_max, or none of "
            "them for the default Bay of Bengal box.",
        )
    lat = (float(lat_min), float(lat_max))  # type: ignore[arg-type]
    lon = (float(lon_min), float(lon_max))  # type: ignore[arg-type]
    if lat[0] >= lat[1] or lon[0] >= lon[1]:
        raise HTTPException(400, "The relief box must have a positive extent.")
    return lat, lon


def _load(lat_range, lon_range, stride: int) -> etopo_terrain.TerrainResult:
    try:
        return etopo_terrain.fetch_relief(
            lat_range=lat_range, lon_range=lon_range, stride=stride
        )
    except UpstreamUnavailable as exc:
        raise HTTPException(
            503,
            "The relief data is unavailable and has not been cached. Connect to "
            "the network once to fetch it; the water column still renders without it.",
        ) from exc


def _query(lat_range, lon_range, stride: int) -> str:
    return (
        f"lat_min={lat_range[0]}&lat_max={lat_range[1]}"
        f"&lon_min={lon_range[0]}&lon_max={lon_range[1]}&stride={stride}"
    )


@router.get("/terrain/meta")
def terrain_meta(
    lat_min: float | None = None,
    lat_max: float | None = None,
    lon_min: float | None = None,
    lon_max: float | None = None,
    stride: int = Query(TERRAIN_STRIDE, ge=1, le=60),
) -> dict[str, object]:
    lat_range, lon_range = _bounds(lat_min, lat_max, lon_min, lon_max)
    result = _load(lat_range, lon_range, stride)
    stats = etopo_terrain.summarize(result)
    return {
        "lat_range": list(lat_range),
        "lon_range": list(lon_range),
        "lat": [float(v) for v in result.lats],
        "lon": [float(v) for v in result.lons],
        "shape": [int(result.elevation.shape[0]), int(result.elevation.shape[1])],
        "stride_arcmin": stride,
        "units": "m",
        "data_url": "/api/terrain/data?" + _query(lat_range, lon_range, stride),
        "attribution": "ETOPO1 bedrock relief via NOAA NCEI",
        **stats,
        "source": result.source.model_dump(),
    }


@router.get("/terrain/data")
def terrain_data(
    lat_min: float | None = None,
    lat_max: float | None = None,
    lon_min: float | None = None,
    lon_max: float | None = None,
    stride: int = Query(TERRAIN_STRIDE, ge=1, le=60),
) -> Response:
    """Raw little-endian Float32 elevation in metres, (lat, lon).
    Positive is land, negative is seafloor.
    """
    lat_range, lon_range = _bounds(lat_min, lat_max, lon_min, lon_max)
    result = _load(lat_range, lon_range, stride)
    payload = np.ascontiguousarray(result.elevation, dtype="<f4").tobytes()
    return Response(
        content=payload,
        media_type="application/octet-stream",
        headers={
            "X-Terrain-Shape": f"{result.elevation.shape[0]},{result.elevation.shape[1]}",
            "Cache-Control": "public, max-age=86400",
        },
    )
