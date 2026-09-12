"""Endpoints for the chunk view: one 5 degree block of ocean in 3D.

field.py serves INCOIS volumes, map.py serves single levels; this serves a
sub-volume of a global dataset. All three use scaling.py for the colour range.
Tiles are snapped to a fixed grid so repeat visits hit the disk cache.
"""

from __future__ import annotations

from urllib.parse import urlencode

import numpy as np
from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel

from ..config import (
    CHUNK_DATASETS,
    CHUNK_MAX_DEPTH,
    CHUNK_TILE_DEGREES,
    MAP_DATASETS_BY_ID,
    MapDataset,
)
from ..erddap_client import UpstreamRefused, UpstreamUnavailable
from ..ingestion import erddap_map
from ..models.schemas import SourceStatus
from ..scaling import percentile_range

router = APIRouter()




class ChunkGrid(BaseModel):
    """The chunk's axes as returned by the upstream."""

    lat: list[float]
    lon: list[float]


class ChunkMeta(BaseModel):
    variable: str
    dataset: str
    label: str
    time: str
    # (lon_min, lat_min, lon_max, lat_max), same order as the scene spec.
    bbox: tuple[float, float, float, float]
    depth_levels: list[float]
    grid: ChunkGrid
    # Always 3D. Surface fields get a depth axis of 1 so the frontend has one code path.
    shape: list[int]
    stride: int
    kind: str
    data_url: str
    vector_url: str | None = None
    units: str
    units_declared_by_us: bool
    colormap: str
    value_range: tuple[float, float]
    full_range: tuple[float, float]
    clipped: bool
    provider: str
    attribution: str
    source: SourceStatus




def _dataset(variable: str) -> MapDataset:
    dataset_id = CHUNK_DATASETS.get(variable)
    if dataset_id is None:
        known = ", ".join(sorted(CHUNK_DATASETS))
        raise HTTPException(404, f"Unknown chunk variable '{variable}'. Available: {known}.")
    ds = MAP_DATASETS_BY_ID.get(dataset_id)
    if ds is None:
        raise HTTPException(
            503,
            f"The {variable} layer is configured to use '{dataset_id}', which is not "
            "registered on this server.",
        )
    return ds


def _guard(ds: MapDataset, call):
    try:
        return call()
    except UpstreamRefused as exc:
        raise HTTPException(
            502,
            f"{ds.provider} refused this request (HTTP {exc.status}). The date or "
            "area may be outside what it serves — try another.",
        ) from exc
    except UpstreamUnavailable as exc:
        raise HTTPException(
            503,
            f"{ds.provider} is unreachable and this chunk has not been cached. "
            "Connect to the network once to fetch it.",
        ) from exc
    except (KeyError, ValueError) as exc:
        raise HTTPException(502, f"{ds.provider} returned an unexpected shape: {exc}") from exc


def _tile(lon_min: float, lat_min: float) -> tuple[float, float, float, float]:
    """Snap a corner to the tile grid. Done on the server too so all clients agree on
    tile boundaries and share cache entries.
    """
    step = CHUNK_TILE_DEGREES
    lon0 = float(np.floor(lon_min / step) * step)
    lat0 = float(np.floor(lat_min / step) * step)
    return lon0, lat0, lon0 + step, lat0 + step


def _query(variable: str, time: str, bbox) -> str:
    lon0, lat0, lon1, lat1 = bbox
    return urlencode(
        {
            "variable": variable,
            "time": time,
            "lon_min": lon0,
            "lat_min": lat0,
            "lon_max": lon1,
            "lat_max": lat1,
        }
    )


def _bbox(lon_min: float, lat_min: float, lon_max: float | None, lat_max: float | None):
    """Resolve the requested area to a tile. Bounds are in the URL so the cache key is
    explicit, but they get snapped anyway.
    """
    del lon_max, lat_max  # snapped; kept so the URL round-trips
    return _tile(lon_min, lat_min)


def _volume(ds: MapDataset, variable: str, time: str, bbox):
    """Fetch the chunk as (depth, lat, lon). Surface products get a depth axis of 1."""
    lon0, lat0, lon1, lat1 = bbox
    lat_range, lon_range = (lat0, lat1), (lon0, lon1)

    if ds.depth_dim is None:
        slice_ = _guard(ds, lambda: erddap_map.fetch_slice(
            ds=ds, time=time, lat_range=lat_range, lon_range=lon_range, stride=1))
        return (
            slice_.values[np.newaxis, :, :],
            np.asarray([0.0], dtype=np.float32),
            slice_.lats, slice_.lons, slice_.time, slice_.stride, slice_.source,
        )

    if variable == "speed":
        vec = _guard(ds, lambda: erddap_map.fetch_vector_volume(
            ds=ds, time=time, lat_range=lat_range, lon_range=lon_range,
            depth_range=(0.0, CHUNK_MAX_DEPTH)))
        # Speed via hypot so every variable uses the same path. u/v are available at
        # /api/chunk/vector.
        return (
            np.hypot(vec.u, vec.v).astype(np.float32),
            vec.depths, vec.lats, vec.lons, vec.time, vec.stride, vec.source,
        )

    vol = _guard(ds, lambda: erddap_map.fetch_volume(
        ds=ds, time=time, lat_range=lat_range, lon_range=lon_range,
        depth_range=(0.0, CHUNK_MAX_DEPTH)))
    return vol.values, vol.depths, vol.lats, vol.lons, vol.time, vol.stride, vol.source




@router.get("/chunk/meta", response_model=ChunkMeta)
def chunk_meta(
    variable: str = Query(...),
    time: str = Query(...),
    lon_min: float = Query(...),
    lat_min: float = Query(...),
    lon_max: float | None = None,
    lat_max: float | None = None,
) -> ChunkMeta:
    ds = _dataset(variable)
    bbox = _bbox(lon_min, lat_min, lon_max, lat_max)
    values, depths, lats, lons, stamp, stride, source = _volume(ds, variable, time, bbox)

    scale = percentile_range(values)
    if scale is None:
        # The client uses this 404 to find tiles with data (land or out-of-range tiles
        # have nothing finite).
        raise HTTPException(
            404,
            f"No {ds.label.lower()} in this chunk on {time[:10]}. {ds.provider} has "
            "no coverage here — try a chunk further out to sea, or another date.",
        )

    n_depth, n_lat, n_lon = values.shape
    return ChunkMeta(
        variable=variable,
        dataset=ds.id,
        label=ds.label,
        time=stamp,
        bbox=bbox,
        depth_levels=[float(d) for d in depths],
        grid=ChunkGrid(
            lat=[float(v) for v in lats],
            lon=[float(v) for v in lons],
        ),
        shape=[n_depth, n_lat, n_lon],
        stride=stride,
        kind="surface" if ds.depth_dim is None else "volume",
        data_url="/api/chunk/data?" + _query(variable, time, bbox),
        vector_url=(
            "/api/chunk/vector?" + _query(variable, time, bbox)
            if ds.vector_components and ds.depth_dim is not None
            else None
        ),
        units=ds.units,
        units_declared_by_us=ds.units_declared_by_us,
        colormap=ds.colormap,
        value_range=(scale.low, scale.high),
        full_range=(scale.true_low, scale.true_high),
        clipped=scale.clipped,
        provider=ds.provider,
        attribution=ds.attribution,
        source=source,
    )


@router.get("/chunk/data")
def chunk_data(
    variable: str = Query(...),
    time: str = Query(...),
    lon_min: float = Query(...),
    lat_min: float = Query(...),
    lon_max: float | None = None,
    lat_max: float | None = None,
) -> Response:
    """Raw little-endian Float32, (depth, lat, lon). NaN = land or no data."""
    ds = _dataset(variable)
    bbox = _bbox(lon_min, lat_min, lon_max, lat_max)
    values, _, _, _, _, stride, source = _volume(ds, variable, time, bbox)
    return Response(
        content=np.ascontiguousarray(values, dtype="<f4").tobytes(),
        media_type="application/octet-stream",
        headers={
            "X-Chunk-Shape": ",".join(str(n) for n in values.shape),
            "X-Chunk-Stride": str(stride),
            "X-Chunk-Provenance": source.provenance,
            "Cache-Control": "public, max-age=3600",
        },
    )


@router.get("/chunk/vector")
def chunk_vector(
    variable: str = Query(...),
    time: str = Query(...),
    lon_min: float = Query(...),
    lat_min: float = Query(...),
    lon_max: float | None = None,
    lat_max: float | None = None,
) -> Response:
    """Two Float32 volumes, u then v, each (depth, lat, lon). The chunk view needs
    the direction to advect particles.
    """
    ds = _dataset(variable)
    if not ds.vector_components or ds.depth_dim is None:
        raise HTTPException(400, f"{ds.label} has no current direction to draw.")
    bbox = _bbox(lon_min, lat_min, lon_max, lat_max)
    lon0, lat0, lon1, lat1 = bbox
    vec = _guard(ds, lambda: erddap_map.fetch_vector_volume(
        ds=ds, time=time, lat_range=(lat0, lat1), lon_range=(lon0, lon1),
        depth_range=(0.0, CHUNK_MAX_DEPTH)))
    payload = np.concatenate([
        np.ascontiguousarray(vec.u, dtype="<f4").ravel(),
        np.ascontiguousarray(vec.v, dtype="<f4").ravel(),
    ])
    return Response(
        content=payload.tobytes(),
        media_type="application/octet-stream",
        headers={
            "X-Chunk-Shape": ",".join(str(n) for n in vec.u.shape),
            "X-Chunk-Stride": str(vec.stride),
            "X-Chunk-Planes": "2",
            "X-Chunk-Provenance": vec.source.provenance,
            "Cache-Control": "public, max-age=3600",
        },
    )
