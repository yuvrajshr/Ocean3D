"""Copernicus Marine (GLORYS) slices for the map.

Uses the copernicusmarine toolbox instead of ERDDAP. Two things drive the design:
there's no server-side striding (a global slice is ~17 MB), and each request
has ~11 s of overhead. So we downsample after fetching and cache the result.
Returns the same result types as erddap_map.
"""

from __future__ import annotations

import io as _io
import logging
import shutil
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import xarray as xr

from .. import cache
from ..config import (
    COPERNICUS_AVAILABLE,
    COPERNICUS_PASSWORD,
    COPERNICUS_USERNAME,
    MAX_SLICE_CELLS,
    MapDataset,
)
from ..erddap_client import UpstreamUnavailable
from ..models.schemas import SourceStatus
from .erddap_map import PointBlock, PointValue, SliceResult, VectorResult, speed_direction

log = logging.getLogger(__name__)

_logged_in = False


class CopernicusUnavailable(UpstreamUnavailable):
    """No credentials, or login failed."""


def _ensure_login() -> None:
    """Log in once per process. Doing it lazily means a missing .env just disables
    the Copernicus layers.
    """
    global _logged_in
    if _logged_in:
        return
    if not COPERNICUS_AVAILABLE:
        raise CopernicusUnavailable(
            "No Copernicus Marine credentials. Add them to backend/.env "
            "(see .env.example) and restart the backend."
        )
    import copernicusmarine as cm

    if not cm.login(
        username=COPERNICUS_USERNAME, password=COPERNICUS_PASSWORD, force_overwrite=True
    ):
        raise CopernicusUnavailable("Copernicus Marine rejected these credentials.")
    _logged_in = True


def _stride_for(ds: MapDataset, lat_range, lon_range) -> int:
    lat0, lat1 = sorted(lat_range or ds.lat_range)
    lon0, lon1 = sorted(lon_range or ds.lon_range)
    frac_lat = (lat1 - lat0) / (ds.lat_range[1] - ds.lat_range[0])
    frac_lon = (lon1 - lon0) / (ds.lon_range[1] - ds.lon_range[0])
    cells = max(1.0, ds.native_shape[0] * frac_lat) * max(1.0, ds.native_shape[1] * frac_lon)
    stride = 1
    while cells / (stride * stride) > MAX_SLICE_CELLS:
        stride += 1
    return stride


def _key(ds: MapDataset, kind: str, **parts) -> str:
    """Cache key (the cache takes any string, not just URLs)."""
    tail = "&".join(f"{k}={v}" for k, v in sorted(parts.items()) if v is not None)
    return f"cmems://{ds.dataset_id}/{kind}?{tail}"


def _pack(arrays: dict[str, np.ndarray]) -> bytes:
    buf = _io.BytesIO()
    np.savez_compressed(buf, **arrays)
    return buf.getvalue()


def _unpack(payload: bytes) -> dict[str, np.ndarray]:
    with np.load(_io.BytesIO(payload)) as z:
        return {k: z[k] for k in z.files}


def _status(provenance: str, fetched_at: float, ds: MapDataset, note: str | None = None) -> SourceStatus:
    return SourceStatus(
        provenance=provenance,  # type: ignore[arg-type]
        fetched_at=datetime.fromtimestamp(fetched_at, tz=timezone.utc).isoformat(timespec="seconds"),
        upstream=f"{ds.base}/product/{ds.dataset_id}",
        note=note,
    )


def _subset(ds: MapDataset, variables: list[str], **kw) -> xr.Dataset:
    """Run one server-side subset into a temp dir and load it into memory."""
    _ensure_login()
    import copernicusmarine as cm

    dataset_id = ds.dataset_id
    if ds.id == "cmems_wave_height" and str(kw.get("start_datetime", ""))[:10] > "2026-05-31":
        dataset_id = "cmems_mod_glo_wav_anfc_0.083deg_PT3H-i"
    if ds.id == "cmems_ph" and str(kw.get("start_datetime", ""))[:10] < "2021-11-01":
        dataset_id = "cmems_mod_glo_bgc_my_0.25deg_P1M-m"
    if ds.id == "cmems_zooplankton":
        if str(kw.get("start_datetime", ""))[:10] > "2025-06-30":
            dataset_id = "cmems_mod_glo_bgc-plankton_anfc_0.25deg_P1D-m"
            if "minimum_depth" not in kw:
                kw.update(_depth_window(0.0))
        else:
            dataset_id = "cmems_mod_glo_bgc_my_0.083deg-lmtl_P1D-i"
            kw.pop("minimum_depth", None)
            kw.pop("maximum_depth", None)

    tmp = Path(tempfile.mkdtemp(prefix="cmems-"))
    try:
        cm.subset(
            dataset_id=dataset_id,
            variables=variables,
            output_directory=str(tmp),
            overwrite=True,
            disable_progress_bar=True,
            **kw,
        )
        files = sorted(tmp.glob("*.nc"))
        if not files:
            raise CopernicusUnavailable("Copernicus returned no file for this request.")
        # Load fully before the temp dir is deleted.
        with xr.open_dataset(files[0]) as opened:
            return opened.load()
    except CopernicusUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001 - toolbox raises a wide variety
        raise CopernicusUnavailable(f"Copernicus Marine request failed: {exc}") from exc
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _depth_window(depth: float | None) -> dict[str, float]:
    """Small window around one depth level (CMEMS selects by value, not index)."""
    if depth is None:
        return {"minimum_depth": 0.0, "maximum_depth": 1.0}
    # Levels get further apart with depth, so the window grows too.
    pad = max(1.0, depth * 0.06)
    return {"minimum_depth": max(0.0, depth - pad), "maximum_depth": depth + pad}


def depth_levels(ds: MapDataset) -> tuple[list[float], SourceStatus | None]:
    key = _key(ds, "depths")
    hit = cache.read(key, ttl=30 * 24 * 3600)
    if hit is not None:
        return _unpack(hit.payload)["depths"].tolist(), _status("cached", hit.fetched_at, ds)
    _ensure_login()
    import copernicusmarine as cm

    opened = cm.open_dataset(dataset_id=ds.dataset_id)
    levels = [float(v) for v in np.atleast_1d(opened["depth"].values)]
    at = cache.write(key, _pack({"depths": np.asarray(levels, dtype=np.float64)}))
    return levels, _status("live", at, ds)


def available_times(ds: MapDataset) -> tuple[list[str], SourceStatus]:
    """Build the time axis from the stated range instead of a 10 s catalogue call.
    These products are daily with no gaps.
    """
    start = datetime.fromisoformat(ds.time_range[0]).replace(tzinfo=timezone.utc)
    end = datetime.fromisoformat(ds.time_range[1]).replace(tzinfo=timezone.utc)
    days = int((end - start).days) + 1
    stamps = [
        (start.timestamp() + i * 86400) for i in range(max(0, days))
    ]
    times = [
        datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%dT00:00:00Z") for t in stamps
    ]
    return times, _status("live", datetime.now(tz=timezone.utc).timestamp(), ds, "Daily axis, generated from the product's stated range.")


def fetch_slice(
    *,
    ds: MapDataset,
    time: str,
    depth: float | None = None,
    lat_range=None,
    lon_range=None,
    stride: int | None = None,
) -> SliceResult:
    used = stride or _stride_for(ds, lat_range, lon_range)
    day = time[:10]
    key = _key(ds, "slice", var=ds.variable, t=day, d=depth, s=used,
               bbox=None if not lat_range else f"{lat_range}:{lon_range}")

    hit = cache.read(key, ttl=30 * 24 * 3600)
    if hit is not None:
        a = _unpack(hit.payload)
        return SliceResult(
            values=a["values"], lats=a["lats"], lons=a["lons"],
            time=f"{day}T00:00:00Z", depth=depth, units=ds.units,
            stride=used, source=_status("cached", hit.fetched_at, ds),
        )

    kw: dict[str, object] = dict(start_datetime=day, end_datetime=day)
    if ds.depth_dim is not None:
        kw.update(_depth_window(depth))
    if lat_range and lon_range:
        kw.update(
            minimum_latitude=min(lat_range), maximum_latitude=max(lat_range),
            minimum_longitude=min(lon_range), maximum_longitude=max(lon_range),
        )
    opened = _subset(ds, [ds.variable], **kw)
    values, lats, lons = _thin(opened, ds.variable, used)
    at = cache.write(key, _pack({"values": values, "lats": lats, "lons": lons}))
    return SliceResult(
        values=values, lats=lats, lons=lons, time=f"{day}T00:00:00Z", depth=depth,
        units=ds.units, stride=used, source=_status("live", at, ds),
    )


def _thin(opened: xr.Dataset, variable: str, stride: int):
    """Squeeze to (lat, lon), subsample, and make latitude ascending."""
    da = opened[variable]
    if "depth" in da.dims and len(da.dims) > 2:
        da = da.isel(depth=0)
    elif "LEV" in da.dims and len(da.dims) > 2:
        da = da.isel(LEV=0)
    da = da.squeeze()
    values = np.asarray(da.values, dtype=np.float32)
    lats = np.asarray(opened["latitude"].values, dtype=np.float32)
    lons = np.asarray(opened["longitude"].values, dtype=np.float32)
    if values.ndim != 2:
        values = values.reshape(len(lats), len(lons))
    if stride > 1:
        values = values[::stride, ::stride]
        lats = lats[::stride]
        lons = lons[::stride]
    if lats.size > 1 and lats[0] > lats[-1]:
        values = np.flip(values, axis=0)
        lats = np.flip(lats)
    values = np.where(np.isfinite(values), values, np.nan).astype(np.float32)
    return np.ascontiguousarray(values), lats, lons


def fetch_vector_components(
    *,
    ds: MapDataset,
    time: str,
    depth: float | None = None,
    lat_range=None,
    lon_range=None,
    stride: int | None = None,
) -> VectorResult:
    if not ds.vector_components:
        raise ValueError(f"{ds.id} has no vector components")
    u_name, v_name = ds.vector_components
    used = stride or _stride_for(ds, lat_range, lon_range)
    day = time[:10]
    key = _key(ds, "vector", t=day, d=depth, s=used)

    hit = cache.read(key, ttl=30 * 24 * 3600)
    if hit is not None:
        a = _unpack(hit.payload)
        return VectorResult(u=a["u"], v=a["v"], lats=a["lats"], lons=a["lons"],
                            time=f"{day}T00:00:00Z", depth=depth, units=ds.units,
                            stride=used, source=_status("cached", hit.fetched_at, ds))

    opened = _subset(ds, [u_name, v_name], start_datetime=day, end_datetime=day, **_depth_window(depth))
    u, lats, lons = _thin(opened, u_name, used)
    v, _, _ = _thin(opened, v_name, used)
    both = np.isfinite(u) & np.isfinite(v)
    u = np.where(both, u, np.nan).astype(np.float32)
    v = np.where(both, v, np.nan).astype(np.float32)
    at = cache.write(key, _pack({"u": u, "v": v, "lats": lats, "lons": lons}))
    return VectorResult(u=u, v=v, lats=lats, lons=lons, time=f"{day}T00:00:00Z",
                        depth=depth, units=ds.units, stride=used, source=_status("live", at, ds))


def fetch_point_block(
    *, ds: MapDataset, lat: float, lon: float, time_start: str, time_end: str
) -> PointBlock:
    key = _key(ds, "point", var=ds.variable, lat=round(lat, 3), lon=round(lon, 3),
               a=time_start[:10], b=time_end[:10])
    hit = cache.read(key, ttl=30 * 24 * 3600)
    if hit is not None:
        a = _unpack(hit.payload)
        return PointBlock(values=a["values"], depths=a["depths"].tolist(),
                          times=[str(t) for t in a["times"]], lat=float(a["cell"][0]),
                          lon=float(a["cell"][1]), units=ds.units,
                          source=_status("cached", hit.fetched_at, ds))

    opened = _subset(
        ds, [ds.variable],
        start_datetime=time_start[:10], end_datetime=time_end[:10],
        minimum_latitude=lat - 0.05, maximum_latitude=lat + 0.05,
        minimum_longitude=lon - 0.05, maximum_longitude=lon + 0.05,
    )
    da = opened[ds.variable]
    # Take the first cell of the small lat/lon window.
    for axis in ("latitude", "longitude"):
        if axis in da.dims:
            da = da.isel({axis: 0})
    values = np.atleast_2d(np.asarray(da.values, dtype=np.float32))
    depths = [float(d) for d in np.atleast_1d(opened["depth"].values)]
    times = [str(t)[:10] + "T00:00:00Z" for t in np.atleast_1d(opened["time"].values)]
    # Panel expects (depth, time).
    if values.shape == (len(times), len(depths)) and len(times) != len(depths):
        values = values.T
    values = np.where(np.isfinite(values), values, np.nan).astype(np.float32)
    cell = np.asarray(
        [float(np.atleast_1d(opened["latitude"].values)[0]),
         float(np.atleast_1d(opened["longitude"].values)[0])]
    )
    at = cache.write(key, _pack({
        "values": np.ascontiguousarray(values), "depths": np.asarray(depths),
        "times": np.asarray(times), "cell": cell,
    }))
    return PointBlock(values=np.ascontiguousarray(values), depths=depths, times=times,
                      lat=float(cell[0]), lon=float(cell[1]), units=ds.units,
                      source=_status("live", at, ds))


# --- Point reads ---

_arco_lock = threading.Lock()
_arco: dict[str, xr.Dataset] = {}


def _arco_handle(ds: MapDataset) -> xr.Dataset:
    """ARCO store opened once and kept for the process. Opening takes ~8 s, then each
    cell is 4-6 s (vs ~11 s per subset), so point reads use this.
    """
    with _arco_lock:
        handle = _arco.get(ds.dataset_id)
        if handle is None:
            _ensure_login()
            import copernicusmarine as cm

            try:
                handle = cm.open_dataset(dataset_id=ds.dataset_id, service="arco-time-series")
            except Exception as exc:  # noqa: BLE001 - toolbox raises a wide variety
                raise CopernicusUnavailable(
                    f"Copernicus Marine could not open {ds.dataset_id}: {exc}"
                ) from exc
            _arco[ds.dataset_id] = handle
        return handle


def _point_value(arrays: dict, ds: MapDataset, day: str, source: SourceStatus) -> PointValue:
    vals = [float(v) if np.isfinite(v) else None for v in arrays["values"]]
    value, direction = vals[0], None
    if ds.vector_components:
        value, direction = speed_direction(vals[0], vals[1])
    cell = arrays["cell"]
    return PointValue(
        value=value, lat=float(cell[0]), lon=float(cell[1]),
        depth=float(cell[2]) if np.isfinite(cell[2]) else None,
        time=f"{day}T00:00:00Z", units=ds.units, source=source, direction_deg=direction,
    )


def fetch_point_value(
    *, ds: MapDataset, lat: float, lon: float, time: str, depth: float | None = None
) -> PointValue:
    """One native cell via the ARCO handle, cached on disk for 30 days."""
    day = time[:10]
    names = list(ds.vector_components) if ds.vector_components else [ds.variable]
    key = _key(ds, "value", var=",".join(names), lat=round(lat, 3), lon=round(lon, 3), t=day, d=depth)
    hit = cache.read(key, ttl=30 * 24 * 3600)
    if hit is not None:
        return _point_value(_unpack(hit.payload), ds, day, _status("cached", hit.fetched_at, ds))

    sel: dict[str, object] = {"time": day, "latitude": lat, "longitude": lon}
    if ds.depth_dim is not None:
        sel["depth"] = depth if depth is not None else 0.0
    try:
        picked = _arco_handle(ds)[names].sel(**sel, method="nearest").load()
    except CopernicusUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001
        raise CopernicusUnavailable(f"Copernicus Marine request failed: {exc}") from exc

    arrays = {
        "values": np.asarray([float(picked[n].values) for n in names], dtype=np.float64),
        "cell": np.asarray([
            float(picked["latitude"].values),
            float(picked["longitude"].values),
            float(picked["depth"].values) if "depth" in picked.coords else np.nan,
        ]),
    }
    at = cache.write(key, _pack(arrays))
    return _point_value(arrays, ds, day, _status("live", at, ds))


def warm_in_background(datasets) -> threading.Thread | None:
    """Open the ARCO handles in the background so the first question isn't slow."""
    unique = list({d.dataset_id: d for d in datasets if d.protocol == "cmems"}.values())
    if not unique or not COPERNICUS_AVAILABLE:
        return None

    def run() -> None:
        for d in unique:
            try:
                _arco_handle(d)
            except Exception as exc:  # noqa: BLE001 - a failed warm-up only costs time
                log.warning("Copernicus warm-up for %s failed: %s", d.dataset_id, exc)

    thread = threading.Thread(target=run, name="cmems-warm", daemon=True)
    thread.start()
    return thread
