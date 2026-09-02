"""In-situ observation endpoints, including the model-vs-measurement comparison.

The comparison endpoint is the point of the whole product: it puts an INCOIS
gridded analysis and a real Argo cast on one depth axis so a forecaster can see
where the analysis is right and where it is not.
"""

from __future__ import annotations

import datetime as dt

import numpy as np
from fastapi import APIRouter, HTTPException, Query

from ..config import GRID_LAT_RANGE, GRID_LON_RANGE, PHAILIN, VARIABLES
from ..erddap_client import UpstreamUnavailable
from ..ingestion import erddap_argo, erddap_grid
from ..models.schemas import InstrumentList, InstrumentProfile

router = APIRouter()

_GRID_VARIABLE = {"temperature": "TEMP", "salinity": "SAL"}


def _scenario_window(
    time_start: str | None, time_end: str | None,
    lat_min: float | None, lat_max: float | None,
    lon_min: float | None, lon_max: float | None,
) -> tuple[str, str, tuple[float, float], tuple[float, float]]:
    return (
        time_start or PHAILIN.time_start,
        time_end or PHAILIN.time_end,
        (lat_min if lat_min is not None else PHAILIN.lat_range[0],
         lat_max if lat_max is not None else PHAILIN.lat_range[1]),
        (lon_min if lon_min is not None else PHAILIN.lon_range[0],
         lon_max if lon_max is not None else PHAILIN.lon_range[1]),
    )


@router.get("/instruments", response_model=InstrumentList)
def list_instruments(
    time_start: str | None = None,
    time_end: str | None = None,
    lat_min: float | None = None,
    lat_max: float | None = None,
    lon_min: float | None = None,
    lon_max: float | None = None,
) -> InstrumentList:
    start, end, lat, lon = _scenario_window(time_start, time_end, lat_min, lat_max, lon_min, lon_max)
    try:
        platforms, source, rejected = erddap_argo.list_platforms(
            time_start=start, time_end=end, lat_range=lat, lon_range=lon
        )
    except UpstreamUnavailable as exc:
        raise HTTPException(
            503,
            "INCOIS ERDDAP is unreachable and this window has not been cached.",
        ) from exc
    return InstrumentList(platforms=platforms, source=source, rejected_by_qc=rejected)


@router.get("/instruments/{platform_id}/profile", response_model=InstrumentProfile)
def get_profile(
    platform_id: str,
    cycle: int | None = None,
    time_start: str | None = None,
    time_end: str | None = None,
) -> InstrumentProfile:
    start, end, lat, lon = _scenario_window(time_start, time_end, None, None, None, None)
    profile = erddap_argo.fetch_profile(
        platform_id=platform_id, time_start=start, time_end=end,
        lat_range=lat, lon_range=lon, cycle=cycle,
    )
    if profile is None:
        raise HTTPException(
            404,
            f"No quality-controlled data for platform {platform_id} in this window. "
            "Its levels may all have failed QC — try another float or widen the dates.",
        )
    return profile


def _nearest_time(target: str, options: list[str]) -> str:
    def parse(value: str) -> dt.datetime:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))

    goal = parse(target)
    return min(options, key=lambda t: abs((parse(t) - goal).total_seconds()))


@router.get("/compare")
def compare(
    platform_id: str = Query(...),
    variable: str = Query("temperature"),
    cycle: int | None = None,
) -> dict[str, object]:
    """Overlay one Argo cast on the gridded analysis at the same place and time.

    The model column is sampled nearest-neighbour, not interpolated: the grid is
    1 degree (~111 km) and smoothing it would imply precision the analysis does
    not have. The response states the offset so the UI can show it.
    """
    if variable not in _GRID_VARIABLE:
        raise HTTPException(
            400,
            f"'{variable}' cannot be compared — only temperature and salinity exist "
            "in both the gridded analysis and the float record.",
        )
    spec = next(s for s in VARIABLES if s.key == variable)

    profile = erddap_argo.fetch_profile(
        platform_id=platform_id,
        time_start=PHAILIN.time_start, time_end=PHAILIN.time_end,
        lat_range=PHAILIN.lat_range, lon_range=PHAILIN.lon_range,
        cycle=cycle,
    )
    if profile is None:
        raise HTTPException(404, f"No quality-controlled data for platform {platform_id}.")

    try:
        times, _ = erddap_grid.available_times()
        grid_time = _nearest_time(profile.time, times)
        volume = erddap_grid.fetch_volume(
            variable=_GRID_VARIABLE[variable], time=grid_time,
            lat_range=(profile.lat - 2, profile.lat + 2),
            lon_range=(profile.lon - 2, profile.lon + 2),
        )
    except UpstreamUnavailable as exc:
        raise HTTPException(503, "INCOIS ERDDAP is unreachable and this comparison is not cached.") from exc

    depths, column = erddap_grid.sample_column(volume, profile.lat, profile.lon)
    gi = int(np.argmin(np.abs(volume.lats - profile.lat)))
    gj = int(np.argmin(np.abs(volume.lons - profile.lon)))

    observed = [
        (lvl.depth, lvl.temperature if variable == "temperature" else lvl.salinity)
        for lvl in profile.profile
    ]
    observed = [(d, v) for d, v in observed if v is not None]

    model_pairs = [
        (float(d), float(v)) for d, v in zip(depths, column, strict=True) if np.isfinite(v)
    ]

    # Residual = observation - analysis, with the analysis interpolated onto the
    # float's own levels. Only within the analysis's depth span; extrapolating
    # past 2000 m would invent numbers.
    residual: list[dict[str, float]] = []
    if model_pairs and observed:
        md = np.array([p[0] for p in model_pairs])
        mv = np.array([p[1] for p in model_pairs])
        lo, hi = md.min(), md.max()
        for d, v in observed:
            if lo <= d <= hi:
                residual.append({"depth": d, "value": round(float(v - np.interp(d, md, mv)), 4)})

    return {
        "variable": variable,
        "units": spec.units,
        "platform_id": profile.platform_id,
        "cycle_number": profile.cycle_number,
        "observed_time": profile.time,
        "model_time": volume.time,
        "lat": profile.lat,
        "lon": profile.lon,
        "observed": [{"depth": d, "value": v} for d, v in observed],
        "model": [{"depth": d, "value": v} for d, v in model_pairs],
        "residual": residual,
        "grid_point": {
            "lat": float(volume.lats[gi]),
            "lon": float(volume.lons[gj]),
            "offset_km": round(
                float(
                    np.hypot(
                        (float(volume.lats[gi]) - profile.lat) * 111.0,
                        (float(volume.lons[gj]) - profile.lon) * 111.0 * np.cos(np.deg2rad(profile.lat)),
                    )
                ),
                1,
            ),
            "resolution_deg": 1.0,
        },
        "extent": {"lat": list(GRID_LAT_RANGE), "lon": list(GRID_LON_RANGE)},
        "source": profile.source.model_dump(),
    }
