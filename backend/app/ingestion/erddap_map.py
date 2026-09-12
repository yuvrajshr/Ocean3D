"""Gridded slices for the 2D map from global datasets.

Separate from erddap_grid because these servers differ in dimension order and
names, some store latitude north to south, and we fetch one depth level at a
time. Adding a dataset should only need a new row in MAP_DATASETS.
"""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import xarray as xr

from .. import erddap_client as client
from ..config import MAX_SLICE_CELLS, MAX_VOLUME_CELLS, MapDataset
from ..models.schemas import SourceStatus
from .netcdf_memory import open_in_memory


class SliceResult:
    """One depth level of one field. ``values`` is (n_lat, n_lon), NaN = no data."""

    __slots__ = ("values", "lats", "lons", "time", "depth", "units", "stride", "source")

    def __init__(self, values, lats, lons, time, depth, units, stride, source) -> None:
        self.values = values
        self.lats = lats
        self.lons = lons
        self.time = time
        self.depth = depth
        self.units = units
        self.stride = stride
        self.source = source


class VectorResult:
    """u and v on the same grid (not a magnitude)."""

    __slots__ = ("u", "v", "lats", "lons", "time", "depth", "units", "stride", "source")

    def __init__(self, u, v, lats, lons, time, depth, units, stride, source) -> None:
        self.u = u
        self.v = v
        self.lats = lats
        self.lons = lons
        self.time = time
        self.depth = depth
        self.units = units
        self.stride = stride
        self.source = source


class VolumeResult:
    """A whole chunk. ``values`` is (n_depth, n_lat, n_lon), NaN = no data.
    Also records the stride used.
    """

    __slots__ = ("values", "depths", "lats", "lons", "time", "units", "stride", "source")

    def __init__(self, values, depths, lats, lons, time, units, stride, source) -> None:
        self.values = values
        self.depths = depths
        self.lats = lats
        self.lons = lons
        self.time = time
        self.units = units
        self.stride = stride
        self.source = source


class VectorVolumeResult:
    """u and v over a whole chunk on one grid."""

    __slots__ = ("u", "v", "depths", "lats", "lons", "time", "units", "stride", "source")

    def __init__(self, u, v, depths, lats, lons, time, units, stride, source) -> None:
        self.u = u
        self.v = v
        self.depths = depths
        self.lats = lats
        self.lons = lons
        self.time = time
        self.units = units
        self.stride = stride
        self.source = source


class PointBlock:
    """Depth x time block at one grid cell.

    The map's point panel gets all four readouts (value, profile, time series,
    section) from this one request.
    """

    __slots__ = ("values", "depths", "times", "lat", "lon", "units", "source")

    def __init__(self, values, depths, times, lat, lon, units, source) -> None:
        self.values = values  # (n_depth, n_time), NaN = no data
        self.depths = depths
        self.times = times
        self.lat = lat
        self.lon = lon
        self.units = units
        self.source = source


class PointValue:
    """A single value at one cell, time and depth. Used by the assistant, since
    fetching a whole PointBlock is much slower.
    """

    __slots__ = ("value", "lat", "lon", "depth", "time", "units", "source", "direction_deg")

    def __init__(self, value, lat, lon, depth, time, units, source, direction_deg=None) -> None:
        self.value = value
        self.lat = lat
        self.lon = lon
        self.depth = depth
        self.time = time
        self.units = units
        self.source = source
        self.direction_deg = direction_deg


def speed_direction(u, v) -> tuple[float | None, float | None]:
    """Speed and the compass bearing the water flows towards, from u (east) and v (north)."""
    if u is None or v is None or not (np.isfinite(u) and np.isfinite(v)):
        return None, None
    return float(np.hypot(u, v)), float((np.degrees(np.arctan2(u, v)) + 360.0) % 360.0)


def _open(payload: bytes) -> xr.Dataset:
    return open_in_memory(payload, "map.nc")


def _stamp(time: str) -> str:
    return time if time.endswith("Z") else f"{time}T00:00:00Z"


def derive_stride(ds: MapDataset, lat_range, lon_range, budget: int = MAX_SLICE_CELLS) -> int:
    """Smallest stride that keeps a request under the cell budget. Large areas get
    subsampled instead of rejected.
    """
    lat0, lat1 = sorted(lat_range or ds.lat_range)
    lon0, lon1 = sorted(lon_range or ds.lon_range)
    frac_lat = (lat1 - lat0) / (ds.lat_range[1] - ds.lat_range[0])
    frac_lon = (lon1 - lon0) / (ds.lon_range[1] - ds.lon_range[0])
    cells = max(1.0, ds.native_shape[0] * frac_lat) * max(1.0, ds.native_shape[1] * frac_lon)
    stride = 1
    while cells / (stride * stride) > budget:
        stride += 1
    return stride


def _axis_expr(lo: float, hi: float, stride: int, descending: bool) -> str:
    """griddap range written in the axis's own direction. On a descending latitude
    axis (VIIRS) a low:high range returns 404.
    """
    a, b = (hi, lo) if descending else (lo, hi)
    return f"[({a}):{stride}:({b})]"


def _query(
    ds: MapDataset,
    variable: str,
    *,
    time: str | None = None,
    time_end: str | None = None,
    depth: float | None = None,
    all_depths: bool = False,
    lat_range=None,
    lon_range=None,
    lat_point: float | None = None,
    lon_point: float | None = None,
    stride: int = 1,
) -> str:
    """Build a griddap selector from the dataset's axis order."""
    lat0, lat1 = sorted(lat_range or ds.lat_range)
    lon0, lon1 = sorted(lon_range or ds.lon_range)
    parts = [variable]
    for dim in ds.axis_order:
        if dim == "time":
            if time_end:
                parts.append(f"[({_stamp(time)}):({_stamp(time_end)})]")
            else:
                parts.append(f"[({_stamp(time)})]")
        elif ds.depth_dim is not None and dim == ds.depth_dim:
            parts.append("[]" if all_depths else f"[({depth if depth is not None else 0.0})]")
        elif dim == ds.lat_dim:
            if lat_point is not None:
                parts.append(f"[({lat_point})]")
            else:
                parts.append(_axis_expr(lat0, lat1, stride, ds.lat_descending))
        elif dim == ds.lon_dim:
            if lon_point is not None:
                parts.append(f"[({lon_point})]")
            else:
                parts.append(_axis_expr(lon0, lon1, stride, False))
        else:
            # Singleton axis like VIIRS's altitude; index it so it doesn't broadcast.
            parts.append("[0]")
    return "".join(parts)


def _ascending(
    values: np.ndarray, lats: np.ndarray, axis: int = 0
) -> tuple[np.ndarray, np.ndarray]:
    """Flip a descending latitude axis. ``axis`` is 0 for (lat, lon), 1 for (depth, lat, lon).
    """
    if lats.size > 1 and lats[0] > lats[-1]:
        return np.flip(values, axis=axis), np.flip(lats)
    return values, lats


def available_times(ds: MapDataset) -> tuple[list[str], SourceStatus]:
    url = client.griddap_url(ds.dataset_id, "time", fmt="json", base=ds.base)
    payload, source = client.fetch(url)
    doc = json.loads(payload.decode("utf-8"))
    return [row[0] for row in doc["table"]["rows"]], source


def depth_levels(ds: MapDataset) -> tuple[list[float], SourceStatus | None]:
    """The dataset's depth levels, or [] for a surface field (hides the depth ruler)."""
    if ds.depth_dim is None:
        return [], None
    url = client.griddap_url(ds.dataset_id, ds.depth_dim, fmt="json", base=ds.base)
    payload, source = client.fetch(url)
    doc = json.loads(payload.decode("utf-8"))
    return [float(row[0]) for row in doc["table"]["rows"]], source


def _read(payload: bytes, ds: MapDataset, name: str):
    with _open(payload) as dset:
        da = dset[name].squeeze()
        values = np.asarray(da.values, dtype=np.float32)
        lats = np.asarray(dset[ds.lat_dim].values, dtype=np.float32)
        lons = np.asarray(dset[ds.lon_dim].values, dtype=np.float32)
    values = np.where(np.isfinite(values), values, np.nan).astype(np.float32)
    return values, lats, lons


def fetch_slice(
    *,
    ds: MapDataset,
    time: str,
    depth: float | None = None,
    lat_range=None,
    lon_range=None,
    stride: int | None = None,
) -> SliceResult:
    used = stride or derive_stride(ds, lat_range, lon_range)
    query = _query(
        ds, ds.variable, time=time, depth=depth,
        lat_range=lat_range, lon_range=lon_range, stride=used,
    )
    url = client.griddap_url(ds.dataset_id, query, fmt="nc", base=ds.base)
    payload, source = client.fetch(url)
    values, lats, lons = _read(payload, ds, ds.variable)
    values, lats = _ascending(values, lats)
    return SliceResult(
        values=np.ascontiguousarray(values, dtype=np.float32),
        lats=lats, lons=lons, time=_stamp(time), depth=depth,
        units=ds.units, stride=used, source=source,
    )


def fetch_vector_components(
    *,
    ds: MapDataset,
    time: str,
    depth: float | None = None,
    lat_range=None,
    lon_range=None,
    stride: int | None = None,
) -> VectorResult:
    """u and v kept separate. Streamlines need the direction, which the magnitude
    version throws away.
    """
    if not ds.vector_components:
        raise ValueError(f"{ds.id} has no vector components")
    u_name, v_name = ds.vector_components
    used = stride or derive_stride(ds, lat_range, lon_range)
    q_u = _query(ds, u_name, time=time, depth=depth, lat_range=lat_range,
                 lon_range=lon_range, stride=used)
    q_v = _query(ds, v_name, time=time, depth=depth, lat_range=lat_range,
                 lon_range=lon_range, stride=used)
    url = client.griddap_url(ds.dataset_id, f"{q_u},{q_v}", fmt="nc", base=ds.base)
    payload, source = client.fetch(url)
    u, lats, lons = _read(payload, ds, u_name)
    v, _, _ = _read(payload, ds, v_name)
    # Missing either component means no vector.
    both = np.isfinite(u) & np.isfinite(v)
    u = np.where(both, u, np.nan).astype(np.float32)
    v = np.where(both, v, np.nan).astype(np.float32)
    u, lats_asc = _ascending(u, lats)
    v, _ = _ascending(v, lats)
    return VectorResult(
        u=np.ascontiguousarray(u, dtype=np.float32),
        v=np.ascontiguousarray(v, dtype=np.float32),
        lats=lats_asc, lons=lons, time=_stamp(time), depth=depth,
        units=ds.units, stride=used, source=source,
    )


def _trim(values: np.ndarray, depths: np.ndarray, depth_range) -> tuple[np.ndarray, np.ndarray]:
    """Trim a volume to a depth range after fetching.

    APDRC returns HTTP 500 for some HYCOM time steps if you request the exact
    0-2000 m level range (e.g. 2013-10-05), while other ranges work. Fetching all
    levels and slicing here costs ~11% more data and avoids it.
    """
    if depth_range is None:
        return values, depths
    keep = (depths >= depth_range[0]) & (depths <= depth_range[1])
    if not keep.any():
        return values, depths
    return values[keep], depths[keep]


def _read_volume(payload: bytes, ds: MapDataset, name: str):
    """Read a (depth, lat, lon) block by dimension name. squeeze() would drop an axis
    that is only one cell wide.
    """
    if ds.depth_dim is None:
        raise ValueError(f"{ds.id} has no depth axis")
    with _open(payload) as dset:
        depths = np.asarray(dset[ds.depth_dim].values, dtype=np.float32)
        lats = np.asarray(dset[ds.lat_dim].values, dtype=np.float32)
        lons = np.asarray(dset[ds.lon_dim].values, dtype=np.float32)
        ordered = dset[name].transpose(ds.depth_dim, ds.lat_dim, ds.lon_dim, ...)
        values = np.asarray(ordered.values, dtype=np.float32).reshape(
            depths.size, lats.size, lons.size
        )
    values = np.where(np.isfinite(values), values, np.nan).astype(np.float32)
    return values, depths, lats, lons


def volume_stride(ds: MapDataset, lat_range, lon_range, n_levels: int) -> int:
    """Stride for a volume, with the cell budget split across all levels."""
    per_level = max(1, MAX_VOLUME_CELLS // max(1, n_levels))
    return derive_stride(ds, lat_range, lon_range, budget=per_level)


def fetch_volume(
    *,
    ds: MapDataset,
    time: str,
    lat_range,
    lon_range,
    depth_range=None,
    stride: int | None = None,
) -> VolumeResult:
    """Fetch a whole chunk of one field in one request, so slices, sections and the
    isosurface all come from the same data.
    """
    levels, _ = depth_levels(ds)
    if not levels:
        raise ValueError(f"{ds.id} is a surface field and has no volume")
    if depth_range is not None:
        levels = [d for d in levels if depth_range[0] <= d <= depth_range[1]]
    used = stride or volume_stride(ds, lat_range, lon_range, len(levels) or 1)
    query = _query(
        ds, ds.variable, time=time, all_depths=True,
        lat_range=lat_range, lon_range=lon_range, stride=used,
    )
    url = client.griddap_url(ds.dataset_id, query, fmt="nc", base=ds.base)
    payload, source = client.fetch(url)
    values, depths, lats, lons = _read_volume(payload, ds, ds.variable)
    values, depths = _trim(values, depths, depth_range)
    values, lats = _ascending(values, lats, axis=1)
    return VolumeResult(
        values=np.ascontiguousarray(values, dtype=np.float32),
        depths=depths, lats=lats, lons=lons, time=_stamp(time),
        units=ds.units, stride=used, source=source,
    )


def fetch_vector_volume(
    *,
    ds: MapDataset,
    time: str,
    lat_range,
    lon_range,
    depth_range=None,
    stride: int | None = None,
) -> VectorVolumeResult:
    """u and v over a chunk, kept separate so the chunk view can advect particles."""
    if not ds.vector_components:
        raise ValueError(f"{ds.id} has no vector components")
    u_name, v_name = ds.vector_components
    levels, _ = depth_levels(ds)
    if not levels:
        raise ValueError(f"{ds.id} is a surface field and has no volume")
    if depth_range is not None:
        levels = [d for d in levels if depth_range[0] <= d <= depth_range[1]]
    # Use the full budget per component so currents get the same resolution as the
    # scalar field.
    used = stride or volume_stride(ds, lat_range, lon_range, len(levels) or 1)
    common = dict(
        time=time, all_depths=True, lat_range=lat_range, lon_range=lon_range, stride=used,
    )
    q_u = _query(ds, u_name, **common)
    q_v = _query(ds, v_name, **common)
    url = client.griddap_url(ds.dataset_id, f"{q_u},{q_v}", fmt="nc", base=ds.base)
    payload, source = client.fetch(url)
    u, depths, lats, lons = _read_volume(payload, ds, u_name)
    v, _, _, _ = _read_volume(payload, ds, v_name)
    u, trimmed = _trim(u, depths, depth_range)
    v, depths = _trim(v, depths, depth_range)
    del trimmed
    # Missing either component means no vector.
    both = np.isfinite(u) & np.isfinite(v)
    u = np.where(both, u, np.nan).astype(np.float32)
    v = np.where(both, v, np.nan).astype(np.float32)
    u, lats_asc = _ascending(u, lats, axis=1)
    v, _ = _ascending(v, lats, axis=1)
    return VectorVolumeResult(
        u=np.ascontiguousarray(u, dtype=np.float32),
        v=np.ascontiguousarray(v, dtype=np.float32),
        depths=depths, lats=lats_asc, lons=lons, time=_stamp(time),
        units=ds.units, stride=used, source=source,
    )


def fetch_point_block(
    *, ds: MapDataset, lat: float, lon: float, time_start: str, time_end: str
) -> PointBlock:
    query = _query(
        ds, ds.variable, time=time_start, time_end=time_end,
        all_depths=ds.depth_dim is not None, lat_point=lat, lon_point=lon,
    )
    url = client.griddap_url(ds.dataset_id, query, fmt="nc", base=ds.base)
    payload, source = client.fetch(url)
    with _open(payload) as dset:
        da = dset[ds.variable].squeeze()
        values = np.asarray(da.values, dtype=np.float32)
        times = [str(t)[:19] + "Z" for t in np.atleast_1d(dset["time"].values)]
        if ds.depth_dim is not None:
            depths = [float(d) for d in np.atleast_1d(dset[ds.depth_dim].values)]
        else:
            depths = [0.0]
        grid_lat = float(np.atleast_1d(dset[ds.lat_dim].values)[0])
        grid_lon = float(np.atleast_1d(dset[ds.lon_dim].values)[0])

    values = np.where(np.isfinite(values), values, np.nan).astype(np.float32)
    values = np.atleast_2d(values)
    # griddap returns (time, depth); the panel wants depth first.
    if values.shape == (len(times), len(depths)) and len(times) != len(depths):
        values = values.T
    elif values.shape[0] != len(depths):
        values = values.reshape(len(depths), len(times))
    return PointBlock(
        values=np.ascontiguousarray(values, dtype=np.float32),
        depths=depths, times=times, lat=grid_lat, lon=grid_lon,
        units=ds.units, source=source,
    )


def _read_point(payload: bytes, ds: MapDataset, name: str):
    with _open(payload) as dset:
        raw = float(np.asarray(dset[name].values, dtype=np.float64).ravel()[0])
        lat = float(np.atleast_1d(dset[ds.lat_dim].values)[0])
        lon = float(np.atleast_1d(dset[ds.lon_dim].values)[0])
        depth = (
            float(np.atleast_1d(dset[ds.depth_dim].values)[0]) if ds.depth_dim is not None else None
        )
    return (raw if np.isfinite(raw) else None), lat, lon, depth


def fetch_point_value(
    *, ds: MapDataset, lat: float, lon: float, time: str, depth: float | None = None
) -> PointValue:
    """One level at one cell. For vector products, reads u and v (in parallel) and
    returns speed and bearing.
    """
    names = list(ds.vector_components) if ds.vector_components else [ds.variable]

    def one(name: str):
        query = _query(ds, name, time=time[:10], depth=depth, lat_point=lat, lon_point=lon)
        payload, source = client.fetch(
            client.griddap_url(ds.dataset_id, query, fmt="nc", base=ds.base)
        )
        return _read_point(payload, ds, name), source

    if len(names) == 1:
        results = [one(names[0])]
    else:
        with ThreadPoolExecutor(max_workers=len(names)) as pool:
            results = list(pool.map(one, names))

    (value, cell_lat, cell_lon, cell_depth), source = results[0]
    direction = None
    if ds.vector_components:
        value, direction = speed_direction(results[0][0][0], results[1][0][0])
    return PointValue(
        value=value, lat=cell_lat, lon=cell_lon, depth=cell_depth,
        time=_stamp(time[:10]), units=ds.units, source=source, direction_deg=direction,
    )
