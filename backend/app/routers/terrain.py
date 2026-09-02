"""Terrain relief endpoints.

Same split as the field endpoints: small JSON metadata, and the heightfield
itself as raw Float32 so the browser can push it straight into a geometry
buffer without parsing.
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter, HTTPException, Response

from ..config import TERRAIN_LAT_RANGE, TERRAIN_LON_RANGE, TERRAIN_STRIDE
from ..erddap_client import UpstreamUnavailable
from ..ingestion import etopo_terrain

router = APIRouter()


def _load() -> etopo_terrain.TerrainResult:
    try:
        return etopo_terrain.fetch_relief()
    except UpstreamUnavailable as exc:
        raise HTTPException(
            503,
            "The relief data is unavailable and has not been cached. Connect to "
            "the network once to fetch it; the water column still renders without it.",
        ) from exc


@router.get("/terrain/meta")
def terrain_meta() -> dict[str, object]:
    result = _load()
    stats = etopo_terrain.summarize(result)
    return {
        "lat_range": list(TERRAIN_LAT_RANGE),
        "lon_range": list(TERRAIN_LON_RANGE),
        "lat": [float(v) for v in result.lats],
        "lon": [float(v) for v in result.lons],
        "shape": [int(result.elevation.shape[0]), int(result.elevation.shape[1])],
        "stride_arcmin": TERRAIN_STRIDE,
        "units": "m",
        "data_url": "/api/terrain/data",
        "attribution": "ETOPO relief via NOAA CoastWatch ERDDAP",
        **stats,
        "source": result.source.model_dump(),
    }


@router.get("/terrain/data")
def terrain_data() -> Response:
    """Raw little-endian Float32 elevation in metres, C order (lat, lon).

    Positive is land, negative is seafloor; zero is sea level.
    """
    result = _load()
    payload = np.ascontiguousarray(result.elevation, dtype="<f4").tobytes()
    return Response(
        content=payload,
        media_type="application/octet-stream",
        headers={
            "X-Terrain-Shape": f"{result.elevation.shape[0]},{result.elevation.shape[1]}",
            "Cache-Control": "public, max-age=86400",
        },
    )
