"""Integration tests for the map's global datasets (live data). We check physical
facts, since a shape check passes on a field that's upside down or all fill values.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.config import MAP_DATASETS_BY_ID, MAX_SLICE_CELLS
from app.ingestion import erddap_map as em

HYCOM = MAP_DATASETS_BY_ID["hycom_temperature"]
CURRENTS = MAP_DATASETS_BY_ID["hycom_currents"]
CHLA = MAP_DATASETS_BY_ID["viirs_chlorophyll"]

DATE = "2013-10-10"


def test_hycom_has_a_real_depth_axis():
    levels, _ = em.depth_levels(HYCOM)
    assert len(levels) == 40
    assert levels[0] == 0.0
    assert levels[-1] == 5000.0
    assert levels == sorted(levels), "depth axis must be monotonic"


def test_surface_field_reports_no_depth_levels():
    """Surface fields report no depth levels, which hides the depth ruler."""
    levels, _ = em.depth_levels(CHLA)
    assert levels == []
    assert CHLA.depth_dim is None


def test_global_surface_temperature_is_physically_plausible():
    result = em.fetch_slice(ds=HYCOM, time=DATE, depth=0.0)
    finite = result.values[np.isfinite(result.values)]
    assert finite.size > 0
    # Roughly from the freezing point of seawater to the warmest tropics.
    assert -3.0 < finite.min() < 0.0
    assert 28.0 < finite.max() < 36.0
    # Earth is ~71% ocean; this grid covers -80..90 lat, so a bit less.
    ocean_fraction = finite.size / result.values.size
    assert 0.55 < ocean_fraction < 0.80


def test_deep_water_is_colder_than_the_surface():
    """Quick check that the depth axis is the right dimension."""
    surface = em.fetch_slice(ds=HYCOM, time=DATE, depth=0.0).values
    deep = em.fetch_slice(ds=HYCOM, time=DATE, depth=1000.0).values
    assert np.nanmax(deep) < np.nanmax(surface) - 5.0
    # The seafloor comes above 1000 m in places, so there's less valid water at depth.
    assert np.isfinite(deep).sum() < np.isfinite(surface).sum()


def test_land_is_nan_and_never_zero():
    """A fill value showing up as 0.0 would look like freezing water."""
    values = em.fetch_slice(ds=HYCOM, time=DATE, depth=0.0).values
    assert np.isnan(values).any(), "a global field must have land"
    # Exact zeros would be suspicious in a temperature field.
    assert (values == 0.0).sum() < values.size * 0.001


def test_descending_latitude_is_normalised_to_ascending():
    """VIIRS stores latitude north to south, HYCOM doesn't. We flip at the boundary;
    getting it wrong draws the ocean upside down.
    """
    assert CHLA.lat_descending is True
    # Take the date from the dataset's coverage. The product has a rolling one-year
    # window, so a hardcoded date would go stale and keep passing from the cache.
    result = em.fetch_slice(ds=CHLA, time=CHLA.time_range[1])
    assert result.lats[0] < result.lats[-1], "latitude must come back ascending"
    assert result.lats[0] < -80.0 and result.lats[-1] > 80.0


def test_vector_components_keep_their_direction():
    """fetch_vector_magnitude drops direction, so streamlines can't use it."""
    result = em.fetch_vector_components(ds=CURRENTS, time=DATE, depth=0.0, stride=16)
    assert result.u.shape == result.v.shape
    # Global currents go both ways on both axes.
    assert np.nanmin(result.u) < -0.2 and np.nanmax(result.u) > 0.2
    assert np.nanmin(result.v) < -0.2 and np.nanmax(result.v) > 0.2
    # A few m/s at most.
    assert np.nanmax(np.hypot(result.u, result.v)) < 6.0


def test_a_missing_component_never_becomes_a_valid_vector():
    result = em.fetch_vector_components(ds=CURRENTS, time=DATE, depth=0.0, stride=16)
    assert np.array_equal(np.isfinite(result.u), np.isfinite(result.v))


def test_point_block_is_depth_by_time():
    block = em.fetch_point_block(
        ds=HYCOM, lat=16.0, lon=88.0, time_start="2013-10-01", time_end="2013-10-10"
    )
    assert block.values.shape == (len(block.depths), len(block.times))
    assert len(block.depths) == 40
    # Tropical column: warm on top, cold at depth.
    column = block.values[:, 0]
    assert column[0] > 26.0
    deepest_valid = column[np.isfinite(column)][-1]
    assert deepest_valid < 10.0


@pytest.mark.parametrize(
    "lat_range,lon_range",
    [(None, None), ((-10.0, 10.0), (60.0, 100.0)), ((-80.0, 90.0), (-180.0, 179.0))],
)
def test_derive_stride_always_respects_the_cell_budget(lat_range, lon_range):
    """The budget applies to the cells requested, not the whole globe. A 20 x 40
    degree box fits at stride 1; only near-global requests need subsampling.
    """
    for ds in (HYCOM, CHLA):
        stride = em.derive_stride(ds, lat_range, lon_range)
        assert stride >= 1

        lat0, lat1 = sorted(lat_range or ds.lat_range)
        lon0, lon1 = sorted(lon_range or ds.lon_range)
        frac_lat = (lat1 - lat0) / (ds.lat_range[1] - ds.lat_range[0])
        frac_lon = (lon1 - lon0) / (ds.lon_range[1] - ds.lon_range[0])
        cells = (ds.native_shape[0] * frac_lat / stride) * (ds.native_shape[1] * frac_lon / stride)
        assert cells <= MAX_SLICE_CELLS * 1.05

        # And it should be the smallest stride that fits.
        if stride > 1:
            looser = (ds.native_shape[0] * frac_lat / (stride - 1)) * (
                ds.native_shape[1] * frac_lon / (stride - 1)
            )
            assert looser > MAX_SLICE_CELLS
