"""Gridded slices for the 2D map, from global upstreams.

Separate from `erddap_grid` because these products differ from INCOIS's in ways
that matter to the query, not just to the URL: they live on other servers, their
dimensions come in different orders and under different names, their latitude
axis may run north-to-south, and they are addressed one depth level at a time
rather than as a whole volume.

The shape of the module deliberately mirrors `erddap_grid`: module-level
functions, ``__slots__`` result objects, in-memory NetCDF, NaN for no-data. A new
global upstream should be a row in ``MAP_DATASETS``, not a new code path — which
is the extensibility claim in the problem statement, tested rather than asserted.
"""

from __future__ import annotations

import json

import netCDF4
import numpy as np
import xarray as xr

from .. import erddap_client as client
from ..config import MAX_SLICE_CELLS, MAX_VOLUME_CELLS, MapDataset
from ..models.schemas import SourceStatus


class SliceResult:
    """One depth level of one field. `values` is (n_lat, n_lon), NaN = no data."""

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
    """u and v on the same grid. Direction is preserved — this is not a magnitude."""

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
    """A whole chunk of water. `values` is (n_depth, n_lat, n_lon), NaN = no data.

    The same shape `erddap_grid.VolumeResult` carries for INCOIS, so the two
    upstreams reach the frontend identically. Kept as its own class rather than
    imported from there because the axis bookkeeping differs: this one records
    the stride it used, which INCOIS's 1-degree grid never needs.
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
    """u and v over a whole chunk, on one grid. Direction is the payload."""

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
    """A depth x time block at one grid cell.

    Deliberately one object rather than three endpoints: the four readouts the
    map's point panel shows are all views of this. Values at the cursor are one
    cell, the depth profile is a column, the time series is a row, and the
    depth-time section is the whole block. One upstream request serves all four.
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


def _open(payload: bytes) -> xr.Dataset:
    nc = netCDF4.Dataset("map.nc", mode="r", memory=payload)
    return xr.open_dataset(xr.backends.NetCDF4DataStore(nc))


def _stamp(time: str) -> str:
    return time if time.endswith("Z") else f"{time}T00:00:00Z"


def derive_stride(ds: MapDataset, lat_range, lon_range, budget: int = MAX_SLICE_CELLS) -> int:
    """Smallest stride that keeps a request under the cell budget.

    Never refuse a large area — subsample it and report what was used. A 404 for
    "too big" would make the map feel broken at exactly the moment a user zooms
    out to see the whole ocean.
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
    """A griddap range, written in the axis's own direction.

    On a north-to-south latitude axis, ``[(lo):(hi)]`` selects nothing and ERDDAP
    answers 404 rather than reordering it. VIIRS stores latitude descending;
    HYCOM does not. Getting this backwards produces a plausible-looking failure.
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
    """Build a griddap selector by walking the dataset's own axis order."""
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
            # A singleton the dataset carries but that means nothing here, such
            # as VIIRS's `altitude`. Index it rather than letting it broadcast.
            parts.append("[0]")
    return "".join(parts)


def _ascending(
    values: np.ndarray, lats: np.ndarray, axis: int = 0
) -> tuple[np.ndarray, np.ndarray]:
    """Flip a descending latitude axis so every consumer sees one convention.

    `axis` is where latitude sits in `values`: 0 for a (lat, lon) slice, 1 for a
    (depth, lat, lon) volume.
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
    """The dataset's real depth axis, or [] for a surface field.

    An empty list is what removes the depth ruler from the map entirely. A
    surface field that reported a depth would assert a measurement that does not
    exist (context.md §10).
    """
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
    """u and v, kept separate.

    ``erddap_grid.fetch_vector_magnitude`` computes hypot and discards the
    direction, which is precisely what streamlines need and what cannot be
    recovered afterwards.
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
    # A single missing component must not masquerade as a valid vector.
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
    """Cut a volume to a depth range after fetching, not during.

    Asking griddap for a depth *range* looks like the obvious thing and is a
    trap on APDRC. Requesting exactly the 36 HYCOM levels between 0 and 2000 m
    makes their server answer a bare Tomcat HTTP 500 on some time steps —
    2013-10-05, -06 and -09 among them — while 35 levels, 40 levels, or the
    same step's surface all return fine. It reproduces on every retry, so it is
    a boundary bug in their aggregation rather than a transient fault.

    Fetching the whole axis and slicing here costs four extra levels (~11% more
    bytes) and cannot hit it. See context.md §10.
    """
    if depth_range is None:
        return values, depths
    keep = (depths >= depth_range[0]) & (depths <= depth_range[1])
    if not keep.any():
        return values, depths
    return values[keep], depths[keep]


def _read_volume(payload: bytes, ds: MapDataset, name: str):
    """Read a (depth, lat, lon) block, naming the axes rather than squeezing.

    `squeeze()` is what the slice path uses, and it is wrong here: a chunk one
    cell wide in any direction would silently lose that axis and the reshape
    below would then succeed on the wrong shape. Asking xarray to transpose to
    named dimensions makes a mis-ordered upstream fail loudly instead.
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
    """Stride for a volume, with the cell budget shared across its levels.

    `derive_stride` counts one plane. A volume is that plane times its depth
    axis, so spending the whole 2D budget per level would be 36 times the
    intended payload.
    """
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
    """A whole chunk of one scalar field, in one request.

    One request rather than one per level: the chunk view's slices, sections,
    isosurface and histogram are all reads of the same block, and fetching them
    separately would be both slower and capable of disagreeing with itself.
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
    """u and v over a chunk, kept separate.

    The chunk view advects particles through this, which needs direction. The
    magnitude path in `erddap_grid.fetch_vector_magnitude` discards it, and it
    cannot be recovered afterwards.
    """
    if not ds.vector_components:
        raise ValueError(f"{ds.id} has no vector components")
    u_name, v_name = ds.vector_components
    levels, _ = depth_levels(ds)
    if not levels:
        raise ValueError(f"{ds.id} is a surface field and has no volume")
    if depth_range is not None:
        levels = [d for d in levels if depth_range[0] <= d <= depth_range[1]]
    # The budget is per component, deliberately: halving it would stride the
    # currents twice as hard as the scalar field beside them, and the chunk view
    # derives `speed` from these — two grids would mean two chunk resolutions.
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
    # A single missing component must not masquerade as a valid vector.
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
    # griddap returns (time, depth); the panel reads a column as a profile.
    if values.shape == (len(times), len(depths)) and len(times) != len(depths):
        values = values.T
    elif values.shape[0] != len(depths):
        values = values.reshape(len(depths), len(times))
    return PointBlock(
        values=np.ascontiguousarray(values, dtype=np.float32),
        depths=depths, times=times, lat=grid_lat, lon=grid_lon,
        units=ds.units, source=source,
    )
