"""Pydantic schemas.

These mirror context.md §6 exactly. Every ingestion source normalizes into one
of these two shapes, so the frontend never learns whether a point came from an
Argo float, a glider or a CTD — only ``platform_type``, for the icon and label.
That is what makes "add a new sensor with minimal code change" true rather than
aspirational.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Provenance = Literal["live", "cached", "fixture"]


class SourceStatus(BaseModel):
    """Where this response actually came from.

    Surfaced in the UI as a readout rather than hidden, because a demo that
    silently falls back to cached data while claiming to be live is worse than
    one that says so.
    """

    provenance: Provenance
    fetched_at: str
    upstream: str
    note: str | None = None


class GridAxes(BaseModel):
    lat: list[float]
    lon: list[float]


class ModelFieldMeta(BaseModel):
    """context.md §6.1 — a gridded model/analysis field.

    The payload itself is NOT in here. Values travel as a separate binary
    Float32Array response (~259 KB) instead of JSON (~8 MB) — see /volume.
    """

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
    """One measurement level of an in-situ cast.

    ``depth`` is metres, always. Argo reports pressure in decibar; the
    conversion happens once, at ingestion, because the whole point of this app
    is comparing a float against a gridded field whose vertical axis is metres.
    """

    depth: float
    temperature: float | None = None
    salinity: float | None = None
    chlorophyll: float | None = None


class InstrumentProfile(BaseModel):
    """context.md §6.2 — one point-profile from any in-situ platform."""

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
    """A marker in the 3D scene. Deliberately light — the full profile is
    fetched only when someone clicks."""

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
