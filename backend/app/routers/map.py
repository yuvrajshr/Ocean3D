"""Endpoints for the 2D map view.

A separate router from `field.py` on purpose. That one serves whole volumes from
INCOIS for the 3D column and builds its `data_url` around that contract; this one
serves a single depth level from a global upstream, with a stride, and must not
change what the 3D view already depends on. What the two DO share is the colour
scale rule, which lives in `scaling.py` so a legend cannot disagree with pixels.

Response models are declared here rather than in `models/schemas.py` because
nothing outside this feature uses them, and `schemas.py` is edited by everyone.
"""

from __future__ import annotations

from urllib.parse import urlencode

import numpy as np
from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel

from ..config import MAP_DATASETS, MAP_DATASETS_BY_ID, MAX_TIME_ENTRIES, MapDataset
from ..erddap_client import UpstreamRefused, UpstreamUnavailable
from ..ingestion import cmems, erddap_map
from ..models.schemas import SourceStatus
from ..scaling import percentile_range

router = APIRouter()

# Depth axes never change for a given product, so probe once per process. The
# disk cache already makes the second call cheap; this makes it free.
_DEPTH_CACHE: dict[str, list[float]] = {}


def _source(ds: MapDataset):
    """Pick the ingestion module for a layer.

    Both modules expose the same four functions and return the same result
    objects, so everything downstream is protocol-agnostic. Adding a fourth
    upstream means adding a module and a line here.
    """
    return cmems if ds.protocol == "cmems" else erddap_map


def _dataset(dataset_id: str) -> MapDataset:
    ds = MAP_DATASETS_BY_ID.get(dataset_id)
    if ds is None:
        known = ", ".join(sorted(MAP_DATASETS_BY_ID))
        raise HTTPException(404, f"Unknown map layer '{dataset_id}'. Available: {known}.")
    return ds


def _levels(ds: MapDataset) -> list[float]:
    if ds.depth_dim is None:
        return []
    if ds.id not in _DEPTH_CACHE:
        try:
            _DEPTH_CACHE[ds.id] = _source(ds).depth_levels(ds)[0]
        except Exception:
            # A catalogue that fails because one axis probe timed out is worse
            # than a catalogue that reports no depth for one layer.
            _DEPTH_CACHE[ds.id] = []
    return _DEPTH_CACHE[ds.id]


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
            f"{ds.provider} is unreachable and this layer has not been cached. "
            "Connect to the network once to fetch it.",
        ) from exc
    except (KeyError, ValueError) as exc:
        raise HTTPException(502, f"{ds.provider} returned an unexpected shape: {exc}") from exc


# --------------------------------------------------------------------- models


class MapLayerInfo(BaseModel):
    id: str
    label: str
    provider: str
    attribution: str
    units: str
    units_declared_by_us: bool
    kind: str
    colormap: str
    caption: str
    # Empty for a surface field, and that emptiness is what removes the depth
    # ruler. A surface field reporting a depth would assert a measurement that
    # does not exist (context.md §10).
    depth_levels: list[float]
    lat_range: tuple[float, float]
    lon_range: tuple[float, float]
    native_shape: tuple[int, int]
    time_start: str
    time_end: str
    cadence: str
    cadence_days: float
    has_vectors: bool
    regional: bool
    variable_key: str
    preference: int


class GridDescriptor(BaseModel):
    """A regular lat/lon grid, described rather than enumerated.

    Sending the axes as two arrays costs ~9 KB per slice and invites off-by-one
    handling at both ends; four numbers and a count cannot drift.
    """

    lat0: float
    dlat: float
    n_lat: int
    lon0: float
    dlon: float
    n_lon: int


class MapSliceMeta(BaseModel):
    dataset: str
    label: str
    time: str
    depth: float | None
    grid: GridDescriptor
    shape: list[int]
    stride: int
    data_url: str
    units: str
    units_declared_by_us: bool
    colormap: str
    value_range: tuple[float, float]
    full_range: tuple[float, float]
    clipped: bool
    attribution: str
    source: SourceStatus


class MapPointBlock(BaseModel):
    dataset: str
    label: str
    units: str
    units_declared_by_us: bool
    colormap: str
    lat: float
    lon: float
    grid_lat: float
    grid_lon: float
    offset_km: float
    depths: list[float]
    times: list[str]
    values: list[float | None]  # flat, C order (depth, time)
    value_range: tuple[float, float]
    full_range: tuple[float, float]
    clipped: bool
    source: SourceStatus


# ------------------------------------------------------------------ endpoints


@router.get("/map/catalogue", response_model=list[MapLayerInfo])
def catalogue() -> list[MapLayerInfo]:
    return [
        MapLayerInfo(
            id=ds.id,
            label=ds.label,
            provider=ds.provider,
            attribution=ds.attribution,
            units=ds.units,
            units_declared_by_us=ds.units_declared_by_us,
            kind=ds.kind,
            colormap=ds.colormap,
            caption=ds.caption,
            depth_levels=_levels(ds),
            lat_range=ds.lat_range,
            lon_range=ds.lon_range,
            native_shape=ds.native_shape,
            time_start=ds.time_range[0],
            time_end=ds.time_range[1],
            cadence=ds.cadence,
            cadence_days=ds.cadence_days,
            has_vectors=ds.vector_components is not None,
            regional=ds.regional,
            variable_key=ds.variable_key,
            preference=ds.preference,
        )
        for ds in MAP_DATASETS
    ]


@router.get("/map/times")
def times(dataset: str = Query(...)) -> dict[str, object]:
    """The layer's real time axis.

    Truncated past MAX_TIME_ENTRIES rather than sent whole: HYCOM has 8034 daily
    steps and VIIRS 4833, which is ~200 KB of ISO strings the timeline does not
    need to draw a rail.
    """
    ds = _dataset(dataset)
    stamps, source = _guard(ds, lambda: _source(ds).available_times(ds))
    truncated = len(stamps) > MAX_TIME_ENTRIES
    step = (len(stamps) // MAX_TIME_ENTRIES + 1) if truncated else 1
    return {
        "dataset": ds.id,
        "cadence": ds.cadence,
        "cadence_days": ds.cadence_days,
        "count": len(stamps),
        "start": stamps[0] if stamps else ds.time_range[0],
        "end": stamps[-1] if stamps else ds.time_range[1],
        "times": stamps[::step],
        "truncated": truncated,
        "source": source.model_dump(),
    }


def _bounds(lat_min, lat_max, lon_min, lon_max):
    lat = (lat_min, lat_max) if lat_min is not None and lat_max is not None else None
    lon = (lon_min, lon_max) if lon_min is not None and lon_max is not None else None
    return lat, lon


def _slice_query(dataset, time, depth, lat, lon, stride) -> str:
    params: dict[str, object] = {"dataset": dataset, "time": time}
    if depth is not None:
        params["depth"] = depth
    if lat and lon:
        params.update(lat_min=lat[0], lat_max=lat[1], lon_min=lon[0], lon_max=lon[1])
    if stride is not None:
        params["stride"] = stride
    return urlencode(params)


@router.get("/map/slice/meta", response_model=MapSliceMeta)
def slice_meta(
    dataset: str = Query(...),
    time: str = Query(...),
    depth: float | None = None,
    lat_min: float | None = None,
    lat_max: float | None = None,
    lon_min: float | None = None,
    lon_max: float | None = None,
    stride: int | None = None,
) -> MapSliceMeta:
    ds = _dataset(dataset)
    lat, lon = _bounds(lat_min, lat_max, lon_min, lon_max)
    result = _guard(ds, lambda: _source(ds).fetch_slice(
        ds=ds, time=time, depth=depth, lat_range=lat, lon_range=lon, stride=stride))

    scale = percentile_range(result.values)
    if scale is None:
        raise HTTPException(
            404,
            f"No {ds.label.lower()} here on {time[:10]}. "
            f"{ds.provider} has no coverage for this area and date — try a wider "
            "area, or a different date.",
        )

    lats, lons = result.lats, result.lons
    n_lat, n_lon = result.values.shape
    return MapSliceMeta(
        dataset=ds.id,
        label=ds.label,
        time=result.time,
        depth=result.depth,
        grid=GridDescriptor(
            lat0=float(lats[0]),
            dlat=float(lats[1] - lats[0]) if n_lat > 1 else 0.0,
            n_lat=n_lat,
            lon0=float(lons[0]),
            dlon=float(lons[1] - lons[0]) if n_lon > 1 else 0.0,
            n_lon=n_lon,
        ),
        shape=[n_lat, n_lon],
        stride=result.stride,
        data_url="/api/map/slice/data?" + _slice_query(ds.id, time, depth, lat, lon, stride),
        units=ds.units,
        units_declared_by_us=ds.units_declared_by_us,
        colormap=ds.colormap,
        value_range=(scale.low, scale.high),
        full_range=(scale.true_low, scale.true_high),
        clipped=scale.clipped,
        attribution=ds.attribution,
        source=result.source,
    )


@router.get("/map/slice/data")
def slice_data(
    dataset: str = Query(...),
    time: str = Query(...),
    depth: float | None = None,
    lat_min: float | None = None,
    lat_max: float | None = None,
    lon_min: float | None = None,
    lon_max: float | None = None,
    stride: int | None = None,
) -> Response:
    """Raw little-endian Float32, C order (lat, lon). NaN = land or no data."""
    ds = _dataset(dataset)
    lat, lon = _bounds(lat_min, lat_max, lon_min, lon_max)
    result = _guard(ds, lambda: _source(ds).fetch_slice(
        ds=ds, time=time, depth=depth, lat_range=lat, lon_range=lon, stride=stride))
    return Response(
        content=np.ascontiguousarray(result.values, dtype="<f4").tobytes(),
        media_type="application/octet-stream",
        headers={
            "X-Map-Shape": ",".join(str(n) for n in result.values.shape),
            "X-Map-Stride": str(result.stride),
            "X-Map-Provenance": result.source.provenance,
            "Cache-Control": "public, max-age=3600",
        },
    )


@router.get("/map/vector/data")
def vector_data(
    dataset: str = Query(...),
    time: str = Query(...),
    depth: float | None = None,
    lat_min: float | None = None,
    lat_max: float | None = None,
    lon_min: float | None = None,
    lon_max: float | None = None,
    stride: int | None = None,
) -> Response:
    """Two Float32 planes, u then v, each C order (lat, lon).

    Direction is the payload. Magnitude alone cannot drive a streamline.
    """
    ds = _dataset(dataset)
    if ds.vector_components is None:
        raise HTTPException(400, f"{ds.label} has no direction to draw — it is a scalar field.")
    lat, lon = _bounds(lat_min, lat_max, lon_min, lon_max)
    result = _guard(ds, lambda: _source(ds).fetch_vector_components(
        ds=ds, time=time, depth=depth, lat_range=lat, lon_range=lon, stride=stride))
    payload = (
        np.ascontiguousarray(result.u, dtype="<f4").tobytes()
        + np.ascontiguousarray(result.v, dtype="<f4").tobytes()
    )
    return Response(
        content=payload,
        media_type="application/octet-stream",
        headers={
            "X-Map-Shape": ",".join(str(n) for n in result.u.shape),
            "X-Map-Planes": "2",
            "X-Map-Stride": str(result.stride),
            "X-Map-Provenance": result.source.provenance,
            "Cache-Control": "public, max-age=3600",
        },
    )


@router.get("/map/point", response_model=MapPointBlock)
def point(
    dataset: str = Query(...),
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-360, le=360),
    time_start: str = Query(...),
    time_end: str = Query(...),
    surface_only: bool = Query(False),
) -> MapPointBlock:
    """A depth x time block at one grid cell — all four point readouts at once.

    `surface_only` exists because the full block is genuinely expensive: 40
    levels x 60 days measured at ~50 s against HYCOM, where the surface series
    alone is ~8 s. The panel asks for the cheap parts first and the section on
    demand, so a click feels immediate.
    """
    ds = _dataset(dataset)
    block = _guard(ds, lambda: _source(ds).fetch_point_block(
        ds=ds, lat=lat, lon=lon, time_start=time_start, time_end=time_end))

    values = block.values[:1] if surface_only else block.values
    depths = block.depths[:1] if surface_only else block.depths

    scale = percentile_range(values)
    if scale is None:
        raise HTTPException(
            404,
            f"No {ds.label.lower()} at {abs(lat):.2f}°{'N' if lat >= 0 else 'S'} "
            f"{abs(lon):.2f}°{'E' if lon >= 0 else 'W'} in this window — "
            "this point may be on land.",
        )

    # Nearest cell centre, stated rather than implied. Same convention as
    # /api/compare's grid_point: a readout is a cell, not an interpolation.
    dlat = block.lat - lat
    dlon = (block.lon - lon) * float(np.cos(np.radians(lat)))
    offset_km = float(np.hypot(dlat, dlon) * 111.32)

    return MapPointBlock(
        dataset=ds.id,
        label=ds.label,
        units=ds.units,
        units_declared_by_us=ds.units_declared_by_us,
        colormap=ds.colormap,
        lat=lat,
        lon=lon,
        grid_lat=block.lat,
        grid_lon=block.lon,
        offset_km=offset_km,
        depths=depths,
        times=block.times,
        values=[None if not np.isfinite(v) else float(v) for v in values.ravel()],
        value_range=(scale.low, scale.high),
        full_range=(scale.true_low, scale.true_high),
        clipped=scale.clipped,
        source=block.source,
    )
