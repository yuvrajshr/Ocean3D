"""Single value at one cell and level (used by the assistant). Uses live HYCOM for
the Phailin date; Copernicus only if credentials are set.
"""
import pytest

from app.config import COPERNICUS_AVAILABLE, CMEMS_DATASETS, MAP_DATASETS_BY_ID
from app.ingestion import erddap_map
from app.ingestion.erddap_map import speed_direction


def test_speed_and_bearing_from_u_and_v():
    assert speed_direction(0.0, 1.0) == (1.0, 0.0)  # due north
    speed, bearing = speed_direction(1.0, 0.0)
    assert speed == 1.0 and bearing == 90.0  # due east
    assert speed_direction(0.3, 0.4)[0] == pytest.approx(0.5)
    assert speed_direction(None, 1.0) == (None, None)


def test_hycom_surface_value_matches_the_panel_block():
    ds = MAP_DATASETS_BY_ID["hycom_temperature"]
    pv = erddap_map.fetch_point_value(ds=ds, lat=15.0, lon=88.0, time="2013-10-12")
    # Same value the 40-level block's surface row gives for this cell.
    assert pv.value == pytest.approx(27.79, abs=0.05)
    assert abs(pv.lat - 15.0) < 0.1 and abs(pv.lon - 88.0) < 0.1
    assert pv.depth == 0.0


def test_hycom_reads_the_requested_level_not_the_surface():
    ds = MAP_DATASETS_BY_ID["hycom_temperature"]
    pv = erddap_map.fetch_point_value(ds=ds, lat=15.0, lon=88.0, time="2013-10-12", depth=100.0)
    assert pv.depth == pytest.approx(100.0, abs=15.0)
    assert pv.value < 27.0, "100 m sits below the Bay of Bengal's mixed layer in October"


def test_hycom_currents_are_speed_and_direction_not_u_alone():
    ds = MAP_DATASETS_BY_ID["hycom_currents"]
    pv = erddap_map.fetch_point_value(ds=ds, lat=15.0, lon=88.0, time="2013-10-12")
    assert pv.value is not None and pv.value >= 0
    assert 0.0 <= pv.direction_deg < 360.0


@pytest.mark.skipif(not COPERNICUS_AVAILABLE, reason="no Copernicus credentials")
def test_copernicus_point_value_through_the_held_handle():
    from app.ingestion import cmems

    ds = next(d for d in CMEMS_DATASETS if d.id == "cmems_temperature")
    pv = cmems.fetch_point_value(ds=ds, lat=15.0, lon=88.0, time="2026-06-23")
    assert 20.0 < pv.value < 35.0
    assert pv.depth is not None and pv.depth < 1.0
