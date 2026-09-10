"""Endpoints for the chunk view — one block of ocean, in three dimensions.

A third gridded router, and the split is the same one `map.py` already explains.
`field.py` serves whole INCOIS volumes for the water column and `map.py` serves
one depth level of a global product; this one serves a whole *sub-volume* of a
global product, which neither of those can do without changing a contract the
other two views already depend on.

What all three share is the colour-scale rule in `scaling.py`, so a legend here
cannot disagree with the same field drawn on the map.

The chunk itself is a fixed 5-degree tile (`CHUNK_TILE_DEGREES`). That is a
request-shaping convention so a repeated visit reuses the disk cache — it is not
the storage tiling layer context.md §12 rules out, and no data is reorganised on
disk to serve it.
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
from ..erddap_client import UpstreamUnavailable
from ..ingestion import erddap_map
from ..models.schemas import SourceStatus
from ..scaling import percentile_range

router = APIRouter()


# --------------------------------------------------------------------- models


class ChunkGrid(BaseModel):
    """The chunk's real axes, as the upstream returned them."""

    lat: list[float]
    lon: list[float]


class ChunkMeta(BaseModel):
    variable: str
    dataset: str
    label: str
    time: str
    # (lon_min, lat_min, lon_max, lat_max), matching the scene spec's own order.
    bbox: tuple[float, float, float, float]
    depth_levels: list[float]
    grid: ChunkGrid
    # C order, always three long. A surface field reports a depth axis of 1 so
    # the frontend has one code path, the same trick `erddap_grid.fetch_surface`
    # already uses for INCOIS.
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


# -------------------------------------------------------------------- helpers


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
    except UpstreamUnavailable as exc:
        raise HTTPException(
            503,
            f"{ds.provider} is unreachable and this chunk has not been cached. "
            "Connect to the network once to fetch it.",
        ) from exc
    except (KeyError, ValueError) as exc:
        raise HTTPException(502, f"{ds.provider} returned an unexpected shape: {exc}") from exc


def _tile(lon_min: float, lat_min: float) -> tuple[float, float, float, float]:
    """Floor a corner onto the tile grid.

    Server-side too, not only in the browser: two clients that disagree about
    where a tile starts would ask two different questions and cache two answers
    to the same one.
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
    """Resolve the requested area to a tile.

    Bounds are accepted rather than a point so the URL — and therefore the cache
    key — states exactly what was fetched. They are snapped anyway: a caller that
    asks for a slightly different rectangle should get the same tile, not a
    near-duplicate megabyte in the cache.
    """
    del lon_max, lat_max  # snapped; kept in the signature so the URL round-trips
    return _tile(lon_min, lat_min)


def _volume(ds: MapDataset, variable: str, time: str, bbox):
    """Fetch the chunk as a (depth, lat, lon) block, whatever its kind.

    A surface product comes back with a depth axis of length 1 rather than none,
    so every caller downstream indexes it the same way.
    """
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
        # hypot, so the scalar path is identical for every variable. Direction is
        # still available in full at /api/chunk/vector — this does not discard it.
        return (
            np.hypot(vec.u, vec.v).astype(np.float32),
            vec.depths, vec.lats, vec.lons, vec.time, vec.stride, vec.source,
        )

    vol = _guard(ds, lambda: erddap_map.fetch_volume(
        ds=ds, time=time, lat_range=lat_range, lon_range=lon_range,
        depth_range=(0.0, CHUNK_MAX_DEPTH)))
    return vol.values, vol.depths, vol.lats, vol.lons, vol.time, vol.stride, vol.source


# ------------------------------------------------------------------ endpoints


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
        # This 404 is also the client's coverage test: a tile over land, or
        # outside the product's extent, has nothing finite in it.
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
    """Raw little-endian Float32, C order (depth, lat, lon). NaN = land or no data."""
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
    """Two Float32 volumes, u then v, each C order (depth, lat, lon).

    Separate from /chunk/data because that one carries speed, and a magnitude
    cannot be advected. The traces in the chunk view need the direction.
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
