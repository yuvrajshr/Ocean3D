"""Catalog endpoints: what can be shown, and for when."""

from __future__ import annotations

from fastapi import APIRouter

from ..config import HAZARD_VARIABLES, PHAILIN, SCENARIOS, VALUE_ADDED_TIME_RANGE, VARIABLES
from ..ingestion import erddap_grid
from ..models.schemas import ScenarioInfo, VariableInfo

router = APIRouter()


def _availability(spec) -> tuple[bool, str | None]:
    """Hazard layers and currents come from the value-added product, which
    stops in March 2019. Rather than letting them silently vanish on a recent
    date, say why."""
    if spec.dataset_id == "incois_valueadded_products_datasets":
        return True, (
            f"Available {VALUE_ADDED_TIME_RANGE[0]} to {VALUE_ADDED_TIME_RANGE[1]} only."
        )
    return True, None


@router.get("/variables", response_model=list[VariableInfo])
def list_variables() -> list[VariableInfo]:
    out: list[VariableInfo] = []
    for group, specs in (("primary", VARIABLES), ("hazard", HAZARD_VARIABLES)):
        for spec in specs:
            available, reason = _availability(spec)
            out.append(
                VariableInfo(
                    key=spec.key,
                    label=spec.label,
                    units=spec.units,
                    units_declared_by_us=spec.units_declared_by_us,
                    kind=spec.kind,
                    colormap=spec.colormap,
                    caption=spec.caption,
                    group=group,  # type: ignore[arg-type]
                    available=available,
                    unavailable_reason=reason,
                )
            )
    return out


@router.get("/scenarios", response_model=list[ScenarioInfo])
def list_scenarios() -> list[ScenarioInfo]:
    out: list[ScenarioInfo] = []
    for scenario in SCENARIOS.values():
        timesteps: list[str] = []
        try:
            all_times, _ = erddap_grid.available_times()
            timesteps = [
                t
                for t in all_times
                if scenario.time_start <= t[:10] <= scenario.time_end
            ]
        except Exception:  # noqa: BLE001 - catalog must not fail on upstream
            timesteps = []
        out.append(
            ScenarioInfo(
                key=scenario.key,
                title=scenario.title,
                summary=scenario.summary,
                time_start=scenario.time_start,
                time_end=scenario.time_end,
                focus_time=scenario.focus_time,
                lat_range=scenario.lat_range,
                lon_range=scenario.lon_range,
                featured_platforms=list(scenario.featured_platforms),
                basemap=scenario.basemap,
                timesteps=timesteps,
            )
        )
    return out


@router.get("/health")
def health() -> dict[str, object]:
    """Liveness plus a real upstream probe, so the UI can show provenance
    before anyone touches a control."""
    upstream_ok = True
    detail = "INCOIS ERDDAP reachable."
    try:
        times, source = erddap_grid.available_times()
        detail = f"{len(times)} timesteps available ({source.provenance})."
    except Exception as exc:  # noqa: BLE001
        upstream_ok = False
        detail = f"INCOIS ERDDAP unreachable: {exc}"
    return {
        "status": "ok",
        "upstream_ok": upstream_ok,
        "detail": detail,
        "default_scenario": PHAILIN.key,
    }
