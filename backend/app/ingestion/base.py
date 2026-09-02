"""The DataSource plugin interface.

This is where the problem statement's extensibility requirement actually lives.
Adding ADCP, HF-radar, moorings or an ML product means implementing this
protocol and registering it — nothing elsewhere in the app is special-cased per
format, because everything is normalized to the two schemas in context.md §6
before it reaches a router.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

import numpy as np

from ..models.schemas import InstrumentProfile, PlatformSummary, SourceStatus


class VolumeResult:
    """A gridded field plus the axes needed to interpret it.

    ``values`` is C-ordered (depth, lat, lon) with NaN for land and no-data.
    """

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
    """A source of gridded model/analysis fields."""

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
    """A source of point-profile observations (Argo, glider, CTD, BGC, ...)."""

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
