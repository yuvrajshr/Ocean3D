"""Integration tests against INCOIS ERDDAP.

These deliberately hit the real server on first run and the local cache
afterwards. They assert against values that were verified by hand before this
code existed, so a silent change in shape, units or quality control fails here
rather than in front of judges.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.config import PHAILIN
from app.ingestion import erddap_argo, erddap_grid

BAY_OF_BENGAL = {"lat_range": (5.0, 22.0), "lon_range": (80.0, 95.0)}


# --------------------------------------------------------------------------
# Gridded analysis
# --------------------------------------------------------------------------

def test_volume_has_expected_shape_and_axes() -> None:
    v = erddap_grid.fetch_volume(variable="TEMP", time="2013-10-10", **BAY_OF_BENGAL)
    assert v.values.ndim == 3, "volume must be (depth, lat, lon)"
    assert v.values.shape[0] == len(v.depths) == 24, "24 depth levels, 5-2000 m"
    assert v.values.shape[1] == len(v.lats)
    assert v.values.shape[2] == len(v.lons)
    assert v.depths[0] == pytest.approx(5.0)
    assert v.depths[-1] == pytest.approx(2000.0)


def test_surface_temperature_is_physically_plausible() -> None:
    """Bay of Bengal, October, 5 m: verified by hand as 28.23-29.87 C."""
    v = erddap_grid.fetch_volume(variable="TEMP", time="2013-10-10", **BAY_OF_BENGAL)
    surface = v.values[0]
    finite = surface[np.isfinite(surface)]
    assert finite.size > 100, "expected substantial ocean coverage in this box"
    assert 26.0 < float(finite.min()), f"unexpectedly cold surface: {finite.min()}"
    assert float(finite.max()) < 32.0, f"unexpectedly warm surface: {finite.max()}"


def test_land_and_nodata_are_nan_not_zero() -> None:
    """A fill value leaking through as 0.0 would render as ice-cold ocean."""
    v = erddap_grid.fetch_volume(variable="TEMP", time="2013-10-10", **BAY_OF_BENGAL)
    assert np.isnan(v.values).any(), "expected NaN where the analysis has no data"
    finite = v.values[np.isfinite(v.values)]
    assert not np.any(np.isclose(finite, 0.0)), "0.0 present — fill value likely leaked"


def test_deep_water_is_colder_than_surface() -> None:
    v = erddap_grid.fetch_volume(variable="TEMP", time="2013-10-10", **BAY_OF_BENGAL)
    surface = np.nanmean(v.values[0])
    deep = np.nanmean(v.values[-1])
    assert deep < surface - 15.0, f"surface {surface:.2f} vs 2000 m {deep:.2f}"


# --------------------------------------------------------------------------
# Pressure -> depth
# --------------------------------------------------------------------------

def test_pressure_to_depth_conversion() -> None:
    depth = erddap_argo.pressure_to_depth(np.array([1000.0]), latitude=15.0)[0]
    # At 1000 db, ~15 N, depth is about 993 m: close to pressure but not equal.
    assert 985.0 < depth < 1000.0, depth
    assert depth < 1000.0, "depth in metres must be less than pressure in decibar"


def test_pressure_to_depth_is_monotonic() -> None:
    p = np.array([0.0, 10.0, 100.0, 500.0, 1000.0, 2000.0])
    d = erddap_argo.pressure_to_depth(p, latitude=15.0)
    assert np.all(np.diff(d) > 0)


# --------------------------------------------------------------------------
# Argo quality control — the trap that produced a fake result once already
# --------------------------------------------------------------------------

def test_bad_qc_float_is_rejected_entirely() -> None:
    """Float 2900757 looks like a -4 C cold wake but is entirely QC=4.

    Every level is at 0 db with a salinity of 0.014 PSU: an instrument failure.
    If this ever returns a profile, the QC filter has regressed and the demo is
    showing a fabricated signal.
    """
    profile = erddap_argo.fetch_profile(
        platform_id="2900757",
        time_start="2013-09-20", time_end="2013-10-25",
        lat_range=(5.0, 22.0), lon_range=(78.0, 95.0),
    )
    assert profile is None, "QC=4 float must not produce a usable profile"


def test_qc_rejection_is_counted_and_reported() -> None:
    _, _, rejected = erddap_argo.list_platforms(
        time_start=PHAILIN.time_start, time_end=PHAILIN.time_end,
        lat_range=PHAILIN.lat_range, lon_range=PHAILIN.lon_range,
    )
    assert rejected > 0, "expected some levels to fail QC in a real window"


def test_featured_float_profile_is_deep_and_ordered() -> None:
    profile = erddap_argo.fetch_profile(
        platform_id="2901327",
        time_start=PHAILIN.time_start, time_end=PHAILIN.time_end,
        lat_range=PHAILIN.lat_range, lon_range=PHAILIN.lon_range,
    )
    assert profile is not None
    assert len(profile.profile) > 50
    depths = [lvl.depth for lvl in profile.profile]
    assert depths == sorted(depths), "levels must be ordered surface-downward"
    assert profile.max_depth is not None and profile.max_depth > 1000


# --------------------------------------------------------------------------
# The demo narrative itself
# --------------------------------------------------------------------------

def test_phailin_cold_wake_is_present_in_float_2901335() -> None:
    """The headline result: ~2.6 C of surface cooling as Phailin passed.

    Verified by hand: 28.96 C on 10 Oct falling to 26.38 C on 11 Oct. If this
    fails, either QC handling changed or the narrative is wrong — and the
    narrative must never outrun the data.
    """
    platforms, _, _ = erddap_argo.list_platforms(
        time_start="2013-10-09", time_end="2013-10-16",
        lat_range=(15.0, 17.0), lon_range=(88.0, 90.0),
    )
    wake = [p for p in platforms if p.platform_id == "2901335" and p.surface_temperature]
    assert len(wake) > 10, "expected many high-cadence cycles from this float"

    before = [p.surface_temperature for p in wake if p.time < "2013-10-11T00:00:00Z"]
    during = [p.surface_temperature for p in wake if "2013-10-11" <= p.time[:10] <= "2013-10-13"]
    assert before and during
    drop = max(before) - min(during)  # type: ignore[type-var]
    assert drop >= 2.0, f"expected >=2 C of cooling, measured {drop:.2f} C"


def test_instrument_profiles_normalize_to_schema() -> None:
    platforms, source, _ = erddap_argo.list_platforms(
        time_start=PHAILIN.time_start, time_end=PHAILIN.time_end,
        lat_range=PHAILIN.lat_range, lon_range=PHAILIN.lon_range,
    )
    assert platforms, "expected Argo floats in the Bay of Bengal during Phailin"
    assert source.provenance in ("live", "cached")
    for p in platforms[:20]:
        assert p.platform_type == "argo_float"
        assert -90 <= p.lat <= 90 and -180 <= p.lon <= 180
        assert p.n_levels > 0
