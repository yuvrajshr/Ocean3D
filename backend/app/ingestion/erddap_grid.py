"""Gridded fields from INCOIS ERDDAP, via NetCDF + xarray.

We request .nc instead of .json: a full volume is 1 MB as NetCDF vs 8 MB as JSON.
"""

from __future__ import annotations

import io
import json

import numpy as np
import xarray as xr

from .. import erddap_client as client
from ..config import GRID_DATASET
from ..models.schemas import SourceStatus
from .base import VolumeResult
from .netcdf_memory import open_in_memory


def _open(payload: bytes) -> xr.Dataset:
    """Open NetCDF bytes as an xarray Dataset without touching disk."""
    return open_in_memory(payload)


def available_times(dataset_id: str = GRID_DATASET) -> tuple[list[str], SourceStatus]:
    """All timesteps in the dataset, as ISO strings."""
    url = client.griddap_url(dataset_id, "time", fmt="json")
    payload, source = client.fetch(url)
    doc = json.loads(payload)
    return [row[0] for row in doc["table"]["rows"]], source


def _range_expr(bounds: tuple[float, float] | None) -> str:
    if bounds is None:
        return "[]"
    lo, hi = sorted(bounds)
    return f"[({lo}):({hi})]"


def fetch_volume(
    *,
    variable: str,
    time: str,
    dataset_id: str = GRID_DATASET,
    lat_range: tuple[float, float] | None = None,
    lon_range: tuple[float, float] | None = None,
) -> VolumeResult:
    """Fetch one timestep of a 3D field as (depth, lat, lon), NaN where there's no data."""
    stamp = time if time.endswith("Z") else f"{time}T00:00:00Z"
    query = (
        f"{variable}[({stamp})]"
        f"[]"  # all 24 depth levels
        f"{_range_expr(lat_range)}"
        f"{_range_expr(lon_range)}"
    )
    url = client.griddap_url(dataset_id, query, fmt="nc")
    payload, source = client.fetch(url)

    with _open(payload) as ds:
        da = ds[variable]
        # ERDDAP keeps time as a length-1 leading dimension.
        if "time" in da.dims:
            da = da.isel(time=0)
        depth_name = next(
            (d for d in ("ZAX", "depth", "LEV", "z") if d in da.dims), None
        )
        if depth_name is None:
            raise ValueError(f"No depth dimension found in {variable}; dims={da.dims}")
        da = da.transpose(depth_name, "latitude", "longitude")

        values = np.asarray(da.values, dtype=np.float32)
        depths = np.asarray(ds[depth_name].values, dtype=np.float32)
        lats = np.asarray(ds["latitude"].values, dtype=np.float32)
        lons = np.asarray(ds["longitude"].values, dtype=np.float32)
        units = str(da.attrs.get("units", "")).strip()
        actual_time = str(np.datetime_as_string(ds["time"].values.reshape(-1)[0], unit="s")) + "Z"

    # Treat anything non-finite as missing; the shader skips NaN.
    values = np.where(np.isfinite(values), values, np.nan).astype(np.float32)

    return VolumeResult(
        values=values,
        depths=depths,
        lats=lats,
        lons=lons,
        time=actual_time,
        units=units,
        source=source,
    )


def fetch_surface(
    *,
    variable: str,
    dataset_id: str,
    time: str,
    lat_range: tuple[float, float] | None = None,
    lon_range: tuple[float, float] | None = None,
) -> VolumeResult:
    """Fetch a 2D field (currents, chlorophyll, hazard layers). Returned with a
    length-1 depth axis so the frontend handles everything the same way.
    """
    stamp = time if time.endswith("Z") else f"{time}T00:00:00Z"
    query = (
        f"{variable}[({stamp})]"
        f"{_range_expr(lat_range)}"
        f"{_range_expr(lon_range)}"
    )
    url = client.griddap_url(dataset_id, query, fmt="nc")
    payload, source = client.fetch(url)

    with _open(payload) as ds:
        da = ds[variable]
        if "time" in da.dims:
            da = da.isel(time=0)
        da = da.transpose("latitude", "longitude")
        values = np.asarray(da.values, dtype=np.float32)[np.newaxis, :, :]
        lats = np.asarray(ds["latitude"].values, dtype=np.float32)
        lons = np.asarray(ds["longitude"].values, dtype=np.float32)
        units = str(da.attrs.get("units", "")).strip()
        actual_time = str(np.datetime_as_string(ds["time"].values.reshape(-1)[0], unit="s")) + "Z"

    values = np.where(np.isfinite(values), values, np.nan).astype(np.float32)

    return VolumeResult(
        values=values,
        depths=np.asarray([0.0], dtype=np.float32),
        lats=lats,
        lons=lons,
        time=actual_time,
        units=units,
        source=source,
    )


def fetch_vector_magnitude(
    *,
    components: tuple[str, str],
    dataset_id: str,
    time: str,
    lat_range: tuple[float, float] | None = None,
    lon_range: tuple[float, float] | None = None,
) -> VolumeResult:
    """Current speed, sqrt(u^2 + v^2). Using u alone would show strong north-south
    flow as still water.
    """
    u_name, v_name = components
    stamp = time if time.endswith("Z") else f"{time}T00:00:00Z"
    query = ",".join(
        f"{name}[({stamp})]{_range_expr(lat_range)}{_range_expr(lon_range)}"
        for name in (u_name, v_name)
    )
    url = client.griddap_url(dataset_id, query, fmt="nc")
    payload, source = client.fetch(url)

    with _open(payload) as ds:
        def component(name: str) -> np.ndarray:
            da = ds[name]
            if "time" in da.dims:
                da = da.isel(time=0)
            return np.asarray(da.transpose("latitude", "longitude").values, dtype=np.float32)

        u = component(u_name)
        v = component(v_name)
        lats = np.asarray(ds["latitude"].values, dtype=np.float32)
        lons = np.asarray(ds["longitude"].values, dtype=np.float32)
        actual_time = str(np.datetime_as_string(ds["time"].values.reshape(-1)[0], unit="s")) + "Z"

    # Need both components, otherwise hypot quietly returns just the other one.
    speed = np.hypot(u, v).astype(np.float32)
    speed = np.where(np.isfinite(u) & np.isfinite(v), speed, np.nan).astype(np.float32)

    return VolumeResult(
        values=speed[np.newaxis, :, :],
        depths=np.asarray([0.0], dtype=np.float32),
        lats=lats,
        lons=lons,
        time=actual_time,
        units="",
        source=source,
    )


def sample_column(volume: VolumeResult, lat: float, lon: float) -> tuple[np.ndarray, np.ndarray]:
    """Nearest grid column to a point. No interpolation, since the grid is 1 degree
    and smoothing would suggest more precision than we have.
    """
    i = int(np.argmin(np.abs(volume.lats - lat)))
    j = int(np.argmin(np.abs(volume.lons - lon)))
    return volume.depths, volume.values[:, i, j]
