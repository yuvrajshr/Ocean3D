"""Argo float profiles from INCOIS ERDDAP.

Two things in here are correctness requirements rather than polish:

**Quality control.** Argo ships raw and adjusted values with a QC flag per
level. Only flags 1 (good) and 2 (probably good) are usable. Float 2900757, for
instance, appears to show a dramatic -4 C cold wake during Cyclone Phailin, but
every one of its levels is QC=4 with a salinity of 0.014 PSU — an instrument
failure, not an ocean signal. Skipping this filter produces confident nonsense.

**Pressure is not depth.** Argo measures pressure in decibar; the gridded
analysis is indexed by depth in metres. They differ by roughly 2% and the
difference grows with depth. Since the headline feature of this app is
overlaying the two, the conversion happens here, once.
"""

from __future__ import annotations

import json

import numpy as np
import pandas as pd

from .. import erddap_client as client
from ..config import ARGO_ACCEPTED_QC, ARGO_DATASET
from ..models.schemas import (
    InstrumentProfile,
    PlatformSummary,
    ProfileLevel,
    SourceStatus,
)

PLATFORM_TYPE = "argo_float"

_COLUMNS = [
    "PLATFORM_NUMBER",
    "CYCLE_NUMBER",
    "time",
    "latitude",
    "longitude",
    "PRES",
    "PRES_ADJUSTED",
    "TEMP",
    "TEMP_ADJUSTED",
    "PSAL",
    "PSAL_ADJUSTED",
    "PRES_QC",
    "TEMP_QC",
    "PSAL_QC",
]


def pressure_to_depth(pressure_db: np.ndarray, latitude: float) -> np.ndarray:
    """Convert pressure (decibar) to depth (metres).

    UNESCO / Fofonoff & Millard (1983) formula, which accounts for the
    latitude dependence of gravity. At 2000 db this differs from the naive
    ``p / 1.02`` shortcut by several metres — small, but this app draws the
    float and the gridded analysis on the same axis, so the error would show up
    exactly where someone is trying to read a difference.
    """
    p = np.asarray(pressure_db, dtype=np.float64)
    phi = np.deg2rad(latitude)
    sin2 = np.sin(phi) ** 2
    gravity = 9.780318 * (1.0 + 5.2788e-3 * sin2 + 2.36e-5 * sin2**2) + 1.092e-6 * p
    numerator = (((-1.82e-15 * p + 2.279e-10) * p - 2.2512e-5) * p + 9.72659) * p
    return numerator / gravity


def _fetch_window(
    *,
    time_start: str,
    time_end: str,
    lat_range: tuple[float, float],
    lon_range: tuple[float, float],
) -> tuple[pd.DataFrame, SourceStatus, int]:
    """Pull every level in a space/time window, then QC-filter locally.

    Filtering here rather than server-side lets us count what was rejected and
    show that number in Ops mode, so the filtering is visible instead of silent.
    """
    lat0, lat1 = sorted(lat_range)
    lon0, lon1 = sorted(lon_range)
    constraints = [
        f"time>={time_start}T00:00:00Z",
        f"time<={time_end}T23:59:59Z",
        f"latitude>={lat0}",
        f"latitude<={lat1}",
        f"longitude>={lon0}",
        f"longitude<={lon1}",
    ]
    url = client.tabledap_url(ARGO_DATASET, _COLUMNS, constraints)
    payload, source = client.fetch(url)

    doc = json.loads(payload)
    table = doc["table"]
    frame = pd.DataFrame(table["rows"], columns=table["columnNames"])
    if frame.empty:
        return frame, source, 0

    for col in ("latitude", "longitude", "PRES", "PRES_ADJUSTED", "TEMP", "TEMP_ADJUSTED", "PSAL", "PSAL_ADJUSTED"):
        frame[col] = pd.to_numeric(frame[col], errors="coerce")
    frame["CYCLE_NUMBER"] = pd.to_numeric(frame["CYCLE_NUMBER"], errors="coerce").astype("Int64")

    # Prefer the delayed-mode adjusted values when present; that is what the
    # Argo programme considers scientifically usable.
    frame["pres_use"] = frame["PRES_ADJUSTED"].where(frame["PRES_ADJUSTED"].notna(), frame["PRES"])
    frame["temp_use"] = frame["TEMP_ADJUSTED"].where(frame["TEMP_ADJUSTED"].notna(), frame["TEMP"])
    frame["psal_use"] = frame["PSAL_ADJUSTED"].where(frame["PSAL_ADJUSTED"].notna(), frame["PSAL"])

    before = len(frame)
    qc_ok = (
        frame["PRES_QC"].astype(str).str.strip().isin(ARGO_ACCEPTED_QC)
        & frame["TEMP_QC"].astype(str).str.strip().isin(ARGO_ACCEPTED_QC)
    )
    usable = frame["pres_use"].notna() & frame["temp_use"].notna()
    frame = frame[qc_ok & usable].copy()
    rejected = before - len(frame)

    if frame.empty:
        return frame, source, rejected

    # Salinity carries its own flag; drop only the salinity value when it fails,
    # never the whole level, or a good temperature profile would vanish because
    # one sensor misbehaved.
    psal_bad = ~frame["PSAL_QC"].astype(str).str.strip().isin(ARGO_ACCEPTED_QC)
    frame.loc[psal_bad, "psal_use"] = np.nan

    frame["depth_m"] = [
        float(pressure_to_depth(np.array([p]), lat)[0])
        for p, lat in zip(frame["pres_use"], frame["latitude"], strict=True)
    ]
    return frame, source, rejected


def list_platforms(
    *,
    time_start: str,
    time_end: str,
    lat_range: tuple[float, float],
    lon_range: tuple[float, float],
) -> tuple[list[PlatformSummary], SourceStatus, int]:
    frame, source, rejected = _fetch_window(
        time_start=time_start, time_end=time_end, lat_range=lat_range, lon_range=lon_range
    )
    if frame.empty:
        return [], source, rejected

    summaries: list[PlatformSummary] = []
    for (platform, cycle), group in frame.groupby(["PLATFORM_NUMBER", "CYCLE_NUMBER"], sort=True):
        group = group.sort_values("depth_m")
        shallowest = group.iloc[0]
        summaries.append(
            PlatformSummary(
                platform_id=str(platform),
                platform_type=PLATFORM_TYPE,
                lat=float(shallowest["latitude"]),
                lon=float(shallowest["longitude"]),
                time=str(shallowest["time"]),
                cycle_number=int(cycle) if pd.notna(cycle) else None,
                n_levels=int(len(group)),
                max_depth=float(group["depth_m"].max()),
                surface_temperature=float(shallowest["temp_use"]),
            )
        )
    summaries.sort(key=lambda s: (s.time, s.platform_id))
    return summaries, source, rejected


def fetch_profile(
    *,
    platform_id: str,
    time_start: str,
    time_end: str,
    lat_range: tuple[float, float],
    lon_range: tuple[float, float],
    cycle: int | None = None,
) -> InstrumentProfile | None:
    """One cast, normalized to context.md §6.2."""
    frame, source, _ = _fetch_window(
        time_start=time_start, time_end=time_end, lat_range=lat_range, lon_range=lon_range
    )
    if frame.empty:
        return None

    subset = frame[frame["PLATFORM_NUMBER"].astype(str) == str(platform_id)]
    if subset.empty:
        return None
    if cycle is not None:
        subset = subset[subset["CYCLE_NUMBER"] == cycle]
        if subset.empty:
            return None
    else:
        first_cycle = subset.sort_values("time")["CYCLE_NUMBER"].iloc[0]
        subset = subset[subset["CYCLE_NUMBER"] == first_cycle]

    subset = subset.sort_values("depth_m")
    head = subset.iloc[0]
    levels = [
        ProfileLevel(
            depth=round(float(row["depth_m"]), 2),
            temperature=None if pd.isna(row["temp_use"]) else round(float(row["temp_use"]), 4),
            salinity=None if pd.isna(row["psal_use"]) else round(float(row["psal_use"]), 4),
        )
        for _, row in subset.iterrows()
    ]

    return InstrumentProfile(
        platform_id=str(head["PLATFORM_NUMBER"]),
        platform_type=PLATFORM_TYPE,
        cycle_number=int(head["CYCLE_NUMBER"]) if pd.notna(head["CYCLE_NUMBER"]) else None,
        lat=float(head["latitude"]),
        lon=float(head["longitude"]),
        time=str(head["time"]),
        profile=levels,
        max_depth=float(subset["depth_m"].max()),
        source=source,
    )
