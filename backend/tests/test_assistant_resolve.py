"""Which dataset answers a variable on a given date.

MAP_DATASETS isn't in preference order, so picking the first match sent 2026
temperature questions to HYCOM (which ends in 2015). The resolver has to use
both preference and coverage. No network.
"""
import pytest

from app import config

BASE = tuple(d for d in config.MAP_DATASETS if d.protocol != "cmems")
WITH_CMEMS = BASE + config.CMEMS_DATASETS


def pick(key, date=None):
    ds = config.map_dataset_for(key, date)
    return ds.id if ds else None


@pytest.fixture
def cmems(monkeypatch):
    monkeypatch.setattr(config, "MAP_DATASETS", WITH_CMEMS)


@pytest.fixture
def no_cmems(monkeypatch):
    monkeypatch.setattr(config, "MAP_DATASETS", BASE)


def test_temperature_in_2026_is_the_copernicus_layer_the_map_draws(cmems):
    assert pick("temperature", "2026-06-23") == "cmems_temperature"


def test_temperature_in_2013_prefers_copernicus_when_configured(cmems):
    assert pick("temperature", "2013-10-12") == "cmems_temperature"


def test_temperature_in_2013_falls_back_to_hycom_without_copernicus(no_cmems):
    assert pick("temperature", "2013-10-12") == "hycom_temperature"


def test_a_date_no_source_covers_resolves_to_nothing(no_cmems):
    assert pick("temperature", "2026-06-23") is None


def test_chlorophyll_in_2013_is_incois_not_viirs(cmems):
    assert pick("chlorophyll", "2013-10-12") == "incois_chlorophyll"


def test_chlorophyll_inside_the_viirs_window_uses_viirs(cmems):
    assert pick("chlorophyll", "2026-01-15") == "viirs_chlorophyll"


def test_no_date_keeps_the_old_behaviour_most_preferred(cmems):
    assert pick("temperature") == "cmems_temperature"


def test_coverage_lists_sources_most_preferred_first(cmems):
    spans = config.coverage_for("temperature")
    assert spans[0][0] == "Copernicus Marine GLORYS12V1"
    assert ("HYCOM GLBv0.08", "1994-01-01", "2015-12-30") in spans
