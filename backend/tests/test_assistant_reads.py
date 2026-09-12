"""Reads: the only way the assistant learns a number, now resolved per view.

A point question is answered from the dataset the view on screen actually draws,
on the date it shows, at the source's native cell — never a source that does not
cover the date (the "HYCOM unreachable" failure), and never the strided slice.
In the chunk view, "here" means the tile on screen, sampled from the volume the
view already loaded. Fetches are faked: no network.
"""

import numpy as np
import pytest

from app import config
from app.assistant import reads
from app.assistant.reads import ReadError, cache_context
from app.assistant.tools import ChunkState, MapState, ScreenState
from app.erddap_client import UpstreamRefused
from app.ingestion import cmems, erddap_map
from app.ingestion.erddap_map import PointValue
from app.models.schemas import SourceStatus
from app.routers import chunk as chunk_router

BASE = tuple(d for d in config.MAP_DATASETS if d.protocol != "cmems")
WITH_CMEMS = BASE + config.CMEMS_DATASETS
SOURCE = SourceStatus(provenance="cached", fetched_at="2026-09-10T00:00:00+00:00", upstream="test")


@pytest.fixture
def point_calls(monkeypatch):
    calls: list[dict] = []

    def fake(*, ds, lat, lon, time, depth=None):
        calls.append({"dataset": ds.id, "time": time, "depth": depth, "lat": lat, "lon": lon})
        return PointValue(
            value=27.5, lat=lat, lon=lon, depth=0.0 if depth is None else depth,
            time=time, units=ds.units, source=SOURCE,
        )

    monkeypatch.setattr(erddap_map, "fetch_point_value", fake)
    monkeypatch.setattr(cmems, "fetch_point_value", fake)
    return calls


def on_map(time="2026-06-23T00:00:00Z", active=None, layers=None) -> ScreenState:
    return ScreenState(
        view="map",
        map=MapState(
            layers=layers if layers is not None else [{"key": "temperature", "visible": True}],
            time=time,
            active=active,
        ),
    )


def in_chunk(**over) -> ScreenState:
    c = dict(
        mounted=True, bbox=[85.0, 10.0, 90.0, 15.0], variable="temperature",
        time="2013-10-07", window=["2013-09-25", "2013-10-24"],
    )
    c.update(over)
    return ScreenState(view="chunk", chunk=ChunkState(**c))


# --------------------------------------------------------------------------
# The map: the source the map draws, on the date it shows
# --------------------------------------------------------------------------

def test_the_2026_map_is_read_from_copernicus_not_hycom(monkeypatch, point_calls):
    monkeypatch.setattr(config, "MAP_DATASETS", WITH_CMEMS)
    out = reads.query_point(on_map(), {"lat": 15, "lon": 88})
    assert point_calls[0]["dataset"] == "cmems_temperature"
    assert point_calls[0]["time"] == "2026-06-23"
    assert out["value"] == 27.5 and out["provenance"]["dataset"] == "cmems_temperature"


def test_a_date_no_source_covers_is_refused_before_any_request(monkeypatch, point_calls):
    monkeypatch.setattr(config, "MAP_DATASETS", BASE)
    with pytest.raises(ReadError) as e:
        reads.query_point(on_map(), {"lat": 15, "lon": 88})
    assert "1994-01-01" in str(e.value) and "2015-12-30" in str(e.value)
    assert point_calls == [], "the upstream must never be asked for a date it lacks"


def test_chlorophyll_in_2013_is_read_from_incois(monkeypatch, point_calls):
    monkeypatch.setattr(config, "MAP_DATASETS", WITH_CMEMS)
    reads.query_point(on_map(time="2013-10-12"), {"lat": 15, "lon": 88, "variable": "chlorophyll"})
    assert point_calls[0]["dataset"] == "incois_chlorophyll"
    assert point_calls[0]["depth"] is None, "a surface field has no depth to ask for"


def test_depth_defaults_to_the_map_layers_own_depth(monkeypatch, point_calls):
    monkeypatch.setattr(config, "MAP_DATASETS", WITH_CMEMS)
    state = on_map(active={"key": "temperature", "depth_m": 100.0, "depth_levels": [0.5, 100.0]})
    reads.query_point(state, {"lat": 15, "lon": 88})
    reads.query_point(state, {"lat": 15, "lon": 88, "depth_m": 50})
    assert [c["depth"] for c in point_calls] == [100.0, 50.0]


def test_a_refused_request_says_refused(monkeypatch):
    monkeypatch.setattr(config, "MAP_DATASETS", BASE)

    def refuse(**_):
        raise UpstreamRefused("apdrc.soest.hawaii.edu", 500)

    monkeypatch.setattr(erddap_map, "fetch_point_value", refuse)
    with pytest.raises(ReadError) as e:
        reads.query_point(on_map(time="2013-10-12"), {"lat": 15, "lon": 88})
    assert "refused" in str(e.value) and "HTTP 500" in str(e.value)


def test_the_reads_cache_key_changes_with_the_date_on_screen():
    a = cache_context("query_point", on_map(time="2013-10-12"))
    b = cache_context("query_point", on_map(time="2013-10-13"))
    assert a != b


# --------------------------------------------------------------------------
# The chunk: "here" is the tile on screen
# --------------------------------------------------------------------------

DEPTHS = np.array([0.0, 50.0, 100.0, 200.0], dtype="f4")
LATS = np.array([10.0, 12.5, 15.0], dtype="f4")
LONS = np.array([85.0, 87.5, 90.0], dtype="f4")


@pytest.fixture
def volume(monkeypatch):
    calls: list[tuple] = []
    profile = np.array([29.0, 28.5, 22.0, 15.0], dtype="f4")
    values = np.broadcast_to(profile[:, None, None], (4, 3, 3)).copy()
    values[3, 0, 0] = np.nan  # below the seabed in one corner
    values[2, 2, 2] = 23.0  # the warmest cell at 100 m

    def fake(ds, variable, time, bbox):
        calls.append((ds.id, variable, time, tuple(bbox)))
        return values, DEPTHS, LATS, LONS, f"{time}T00:00:00Z", 1, SOURCE

    monkeypatch.setattr(chunk_router, "_volume", fake)
    return calls


def test_a_point_in_the_tile_is_sampled_from_the_loaded_chunk(volume, point_calls):
    out = reads.query_point(in_chunk(), {"lat": 12.4, "lon": 87.6, "depth_m": 90})
    assert out["value"] == 22.0
    assert out["grid_cell"] == {"lat": 12.5, "lon": 87.5, "depth_m": 100.0}
    assert volume == [("hycom_temperature", "temperature", "2013-10-07", (85.0, 10.0, 90.0, 15.0))]
    assert point_calls == [], "no second request for a value already on screen"


def test_a_cell_below_the_seabed_says_so(volume):
    with pytest.raises(ReadError) as e:
        reads.query_point(in_chunk(), {"lat": 10.0, "lon": 85.0, "depth_m": 200})
    assert "seabed" in str(e.value)


def test_a_point_outside_the_tile_reads_one_native_level(volume, point_calls):
    reads.query_point(in_chunk(), {"lat": 17.0, "lon": 88.0})
    assert volume == [], "a neighbouring tile is not fetched whole for one value"
    assert point_calls[0]["dataset"] == "hycom_temperature"
    assert point_calls[0]["time"] == "2013-10-07"


def test_describe_chunk_finds_the_thermocline(volume):
    out = reads.describe_chunk(in_chunk(), {})
    assert [level["depth_m"] for level in out["levels"]] == [0.0, 50.0, 100.0, 200.0]
    assert out["strongest_vertical_gradient"]["from_m"] == 50.0
    assert out["strongest_vertical_gradient"]["to_m"] == 100.0
    assert out["provenance"]["dataset"] == "hycom_temperature"


def test_describe_chunk_at_one_depth_says_where_the_extremes_are(volume):
    out = reads.describe_chunk(in_chunk(), {"depth_m": 100})
    assert out["level"]["max"] == 23.0
    assert out["level"]["max_at"] == {"lat": 15.0, "lon": 90.0}


# --------------------------------------------------------------------------
# The comparison: the signature feature must carry its citation
# --------------------------------------------------------------------------

def test_compare_float_is_cited_and_compact(monkeypatch):
    from app.routers import instruments as instruments_router

    full = {
        "variable": "temperature", "units": "°C", "platform_id": "2901335", "cycle_number": 183,
        "observed_time": "2013-10-04T12:00:00Z", "model_time": "2013-10-06T00:00:00Z",
        "lat": 15.97, "lon": 89.02,
        "observed": [{"depth": float(d), "value": 29 - d / 100} for d in range(0, 2000, 13)],
        "model": [{"depth": float(d), "value": 28.5 - d / 100} for d in (5, 15, 25, 50, 100, 200, 500, 1000, 2000)],
        "residual": [{"depth": 3.65, "value": 0.81}, {"depth": 76.0, "value": -1.21}, {"depth": 500.0, "value": 0.1}],
        "grid_point": {"lat": 15.5, "lon": 88.5, "offset_km": 78.0, "resolution_deg": 1.0},
        "extent": {"lat": [-29.5, 29.5], "lon": [30.5, 119.5]},
        "source": {"provenance": "cached"},
    }
    monkeypatch.setattr(instruments_router, "compare", lambda **_: full)
    out = reads.compare_float(on_map(), {"platform_id": "2901335"})

    # Found live, 2026-09-12: the comparison's numbers reached the reader with no
    # citation, because the result carried no provenance block.
    assert out["provenance"]["dataset"] == config.GRID_DATASET
    assert out["provenance"]["time"] == "2013-10-06"
    assert out["residual_summary"]["largest"] == {"depth_m": 76.0, "value": -1.21}
    assert out["residual_summary"]["levels_compared"] == 3
    # ~154 measured levels become the handful a forecaster reads a cast at.
    assert len(out["observed"]) <= 12 and out["observed"][0]["depth_m"] == 0.0
    assert "extent" not in out and "source" not in out
