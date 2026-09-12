"""Pydantic schemas.

Every source is converted into one of these shapes, so the frontend only ever
sees ``platform_type`` (for the icon and label), never the original format.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Provenance = Literal["live", "cached", "fixture"]


class SourceStatus(BaseModel):
    """Where a response came from (live or cache). Shown in the UI."""

    provenance: Provenance
    fetched_at: str
    upstream: str
    note: str | None = None


class GridAxes(BaseModel):
    lat: list[float]
    lon: list[float]


class ModelFieldMeta(BaseModel):
    """A gridded model field. The values themselves are a separate binary response."""

    variable: str
    label: str
    time: str
    depth_levels: list[float]
    grid: GridAxes
    data_url: str
    units: str
    units_declared_by_us: bool = False
    value_range: tuple[float, float] = Field(
        description="Range the colour scale is stretched over. Percentile-clipped "
        "so a single outlier cannot flatten the whole colorbar."
    )
    full_range: tuple[float, float] = Field(
        description="True minimum and maximum in the data, before clipping."
    )
    clipped: bool = Field(
        default=False,
        description="True when the colour range is narrower than the data, so the "
        "UI can say so rather than implying the extremes are absent.",
    )
    colormap: str
    kind: str
    shape: list[int] = Field(
        description="Array shape in C order, matching the binary payload."
    )
    fill_value: float = Field(
        default=float("nan"),
        description="Missing data marker. Land and no-data cells are NaN.",
    )
    source: SourceStatus


class ProfileLevel(BaseModel):
    """One level of a profile. ``depth`` is always metres (Argo pressure is converted
    at ingestion).
    """

    depth: float
    temperature: float | None = None
    salinity: float | None = None
    chlorophyll: float | None = None


class InstrumentProfile(BaseModel):
    """One profile from any in-situ platform."""

    platform_id: str
    platform_type: str
    cycle_number: int | None = None
    lat: float
    lon: float
    time: str
    profile: list[ProfileLevel]
    max_depth: float | None = None
    source: SourceStatus


class PlatformSummary(BaseModel):
    """A float marker. The full profile is only fetched on click."""

    platform_id: str
    platform_type: str
    lat: float
    lon: float
    time: str
    cycle_number: int | None = None
    n_levels: int
    max_depth: float | None = None
    surface_temperature: float | None = None


class InstrumentList(BaseModel):
    platforms: list[PlatformSummary]
    source: SourceStatus
    rejected_by_qc: int = Field(
        default=0,
        description="Levels dropped for failing Argo QC. Shown in Ops mode so "
        "the filtering is visible rather than silent.",
    )


class VariableInfo(BaseModel):
    key: str
    label: str
    units: str
    units_declared_by_us: bool
    kind: str
    colormap: str
    caption: str
    group: Literal["primary", "hazard"]
    available: bool = True
    unavailable_reason: str | None = None


class ScenarioInfo(BaseModel):
    key: str
    title: str
    summary: str
    time_start: str
    time_end: str
    focus_time: str
    lat_range: tuple[float, float]
    lon_range: tuple[float, float]
    featured_platforms: list[str]
    basemap: str = "october"
    timesteps: list[str] = []
