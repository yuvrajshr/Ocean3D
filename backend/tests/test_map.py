"""Integration tests for the 2D map's global upstreams.

Live data, like the rest of this suite. These assert physical facts about the
ocean rather than array shapes, because a shape test passes just as happily on a
field that is upside down, in the wrong hemisphere, or all fill value.
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
    """This emptiness is what removes the depth ruler.

    A surface field that reported a depth would let the UI write "500 m" on a
    measurement that does not exist (context.md §10).
    """
    levels, _ = em.depth_levels(CHLA)
    assert levels == []
    assert CHLA.depth_dim is None


def test_global_surface_temperature_is_physically_plausible():
    result = em.fetch_slice(ds=HYCOM, time=DATE, depth=0.0)
    finite = result.values[np.isfinite(result.values)]
    assert finite.size > 0
    # Sea water spans roughly the freezing point of brine to the warmest tropics.
    assert -3.0 < finite.min() < 0.0
    assert 28.0 < finite.max() < 36.0
    # Earth is ~71% ocean; this grid runs -80..90 lat, so a little less.
    ocean_fraction = finite.size / result.values.size
    assert 0.55 < ocean_fraction < 0.80


def test_deep_water_is_colder_than_the_surface():
    """The single cheapest check that the depth axis is wired to the right dim."""
    surface = em.fetch_slice(ds=HYCOM, time=DATE, depth=0.0).values
    deep = em.fetch_slice(ds=HYCOM, time=DATE, depth=1000.0).values
    assert np.nanmax(deep) < np.nanmax(surface) - 5.0
    # And the seafloor rises above 1000 m in places, so there is strictly less
    # valid water down there than at the surface.
    assert np.isfinite(deep).sum() < np.isfinite(surface).sum()


def test_land_is_nan_and_never_zero():
    """A fill value leaking through as 0.0 would render as freezing water."""
    values = em.fetch_slice(ds=HYCOM, time=DATE, depth=0.0).values
    assert np.isnan(values).any(), "a global field must have land"
    # Exact zeros would be suspicious in a percentile-scaled temperature field.
    assert (values == 0.0).sum() < values.size * 0.001


def test_descending_latitude_is_normalised_to_ascending():
    """VIIRS stores latitude north-to-south; HYCOM does not.

    Every consumer sees one convention, so this flip happens at the boundary.
    Getting it wrong renders the whole ocean upside down, which looks plausible.
    """
    assert CHLA.lat_descending is True
    result = em.fetch_slice(ds=CHLA, time="2020-06-01")
    assert result.lats[0] < result.lats[-1], "latitude must come back ascending"
    assert result.lats[0] < -80.0 and result.lats[-1] > 80.0


def test_vector_components_keep_their_direction():
    """`fetch_vector_magnitude` discards direction; streamlines cannot use it."""
    result = em.fetch_vector_components(ds=CURRENTS, time=DATE, depth=0.0, stride=16)
    assert result.u.shape == result.v.shape
    # A global current field flows both ways on both axes.
    assert np.nanmin(result.u) < -0.2 and np.nanmax(result.u) > 0.2
    assert np.nanmin(result.v) < -0.2 and np.nanmax(result.v) > 0.2
    # Ocean currents, not a runaway model: a few m/s at most.
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
    # A tropical Bay of Bengal column: warm lid, cold abyss.
    column = block.values[:, 0]
    assert column[0] > 26.0
    deepest_valid = column[np.isfinite(column)][-1]
    assert deepest_valid < 10.0


@pytest.mark.parametrize(
    "lat_range,lon_range",
    [(None, None), ((-10.0, 10.0), (60.0, 100.0)), ((-80.0, 90.0), (-180.0, 179.0))],
)
def test_derive_stride_always_respects_the_cell_budget(lat_range, lon_range):
    """The budget applies to the cells actually requested, not to the whole globe.

    A 20 x 40 degree box is a small fraction of a global grid, so stride 1 is the
    right answer there; only a near-global request needs subsampling.
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

        # And the stride must be the SMALLEST that fits, not merely a safe one.
        if stride > 1:
            looser = (ds.native_shape[0] * frac_lat / (stride - 1)) * (
                ds.native_shape[1] * frac_lon / (stride - 1)
            )
            assert looser > MAX_SLICE_CELLS
