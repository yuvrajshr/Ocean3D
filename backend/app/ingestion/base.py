"""DataSource interface.

New sources (ADCP, HF radar, moorings, ML products) implement one of these
protocols. Everything gets converted to a gridded field or a point profile
before it reaches a router, so nothing else needs to change.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

import numpy as np

from ..models.schemas import InstrumentProfile, PlatformSummary, SourceStatus


class VolumeResult:
    """A gridded field plus its axes. ``values`` is (depth, lat, lon), NaN for land/no data."""

    __slots__ = ("values", "depths", "lats", "lons", "time", "units", "source")

    def __init__(
        self,
        values: np.ndarray,
        depths: np.ndarray,
        lats: np.ndarray,
        lons: np.ndarray,
        time: str,
        units: str,
        source: SourceStatus,
    ) -> None:
        self.values = values
        self.depths = depths
        self.lats = lats
        self.lons = lons
        self.time = time
        self.units = units
        self.source = source


@runtime_checkable
class GriddedSource(Protocol):
    """Source of gridded model fields."""

    def available_times(self, dataset_id: str) -> tuple[list[str], SourceStatus]:
        ...

    def fetch_volume(
        self,
        *,
        dataset_id: str,
        variable: str,
        time: str,
        lat_range: tuple[float, float] | None = None,
        lon_range: tuple[float, float] | None = None,
    ) -> VolumeResult:
        ...


@runtime_checkable
class InSituSource(Protocol):
    """Source of point profiles (Argo, glider, CTD, BGC, ...)."""

    platform_type: str

    def list_platforms(
        self,
        *,
        time_start: str,
        time_end: str,
        lat_range: tuple[float, float],
        lon_range: tuple[float, float],
    ) -> tuple[list[PlatformSummary], SourceStatus, int]:
        ...

    def fetch_profile(
        self, *, platform_id: str, time_start: str, time_end: str, cycle: int | None = None
    ) -> InstrumentProfile:
        ...
