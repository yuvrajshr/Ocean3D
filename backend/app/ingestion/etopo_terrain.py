"""Seafloor and land relief from NOAA CoastWatch ETOPO.

A second upstream, on a different server, behind the same `DataSource` shape as
the INCOIS sources. That is the point as much as the pixels are: the problem
statement asks for an architecture that accepts new sensors and products with
minimal change, and this is the first chance to show that rather than claim it.

Physically this is one surface. ETOPO's `altitude` is positive on land and
negative at sea, so the Eastern Ghats, the Indian coastline and the floor of the
Bay of Bengal all come from a single grid and render as a single mesh — which is
what they are.
"""

from __future__ import annotations

import io

import netCDF4
import numpy as np
import xarray as xr

from .. import erddap_client as client
from ..config import (
    TERRAIN_BASE,
    TERRAIN_DATASET,
    TERRAIN_LAT_RANGE,
    TERRAIN_LON_RANGE,
    TERRAIN_STRIDE,
)
from ..models.schemas import SourceStatus


class TerrainResult:
    """Elevation in metres on a regular lat/lon grid, C order (lat, lon)."""

    __slots__ = ("elevation", "lats", "lons", "source")

    def __init__(
        self,
        elevation: np.ndarray,
        lats: np.ndarray,
        lons: np.ndarray,
        source: SourceStatus,
    ) -> None:
        self.elevation = elevation
        self.lats = lats
        self.lons = lons
        self.source = source


def _open(payload: bytes) -> xr.Dataset:
    nc = netCDF4.Dataset("terrain.nc", mode="r", memory=payload)
    return xr.open_dataset(xr.backends.NetCDF4DataStore(nc))


def fetch_relief(
    *,
    lat_range: tuple[float, float] = TERRAIN_LAT_RANGE,
    lon_range: tuple[float, float] = TERRAIN_LON_RANGE,
    stride: int = TERRAIN_STRIDE,
) -> TerrainResult:
    lat0, lat1 = sorted(lat_range)
    lon0, lon1 = sorted(lon_range)
    query = f"altitude[({lat0}):{stride}:({lat1})][({lon0}):{stride}:({lon1})]"
    url = client.griddap_url(TERRAIN_DATASET, query, fmt="nc", base=TERRAIN_BASE)
    payload, source = client.fetch(url)

    with _open(payload) as ds:
        da = ds["altitude"].transpose("latitude", "longitude")
        elevation = np.asarray(da.values, dtype=np.float32)
        lats = np.asarray(ds["latitude"].values, dtype=np.float32)
        lons = np.asarray(ds["longitude"].values, dtype=np.float32)

    # ETOPO has no gaps, but a NaN reaching the vertex shader would tear a hole
    # in the mesh, so anything non-finite is pinned to sea level.
    elevation = np.where(np.isfinite(elevation), elevation, 0.0).astype(np.float32)
    return TerrainResult(elevation=elevation, lats=lats, lons=lons, source=source)


def summarize(result: TerrainResult) -> dict[str, float | int]:
    """Numbers the frontend needs to scale and shade the mesh."""
    elevation = result.elevation
    land = elevation > 0
    return {
        "min_elevation": float(elevation.min()),
        "max_elevation": float(elevation.max()),
        "land_fraction": float(land.mean()),
        "n_lat": int(elevation.shape[0]),
        "n_lon": int(elevation.shape[1]),
    }
