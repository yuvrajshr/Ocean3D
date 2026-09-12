"""Integration tests for chunk volumes (live data).

We check physical facts, not just shapes; a shape check would pass on a field
that's upside down or all fill values. The test chunk is the default Bay of
Bengal tile (85-90 E, 10-15 N) during Cyclone Phailin.
"""

from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.config import CHUNK_MAX_DEPTH, MAP_DATASETS_BY_ID
from app.ingestion import erddap_map as em
from app.main import app

HYCOM = MAP_DATASETS_BY_ID["hycom_temperature"]
CURRENTS = MAP_DATASETS_BY_ID["hycom_currents"]

DATE = "2013-10-10"
LAT = (10.0, 15.0)
LON = (85.0, 90.0)
DEPTHS = (0.0, CHUNK_MAX_DEPTH)

client = TestClient(app)


def _bbox_query(variable: str, lon_min: float = 85.0, lat_min: float = 10.0) -> str:
    return f"variable={variable}&time={DATE}&lon_min={lon_min}&lat_min={lat_min}"


@pytest.fixture(scope="module")
def volume():
    return em.fetch_volume(
        ds=HYCOM, time=DATE, lat_range=LAT, lon_range=LON, depth_range=DEPTHS
    )


# --- ingestion ---


def test_volume_axes_agree_with_its_own_shape(volume):
    """The frontend reshapes the payload using only these numbers."""
    assert volume.values.ndim == 3
    n_depth, n_lat, n_lon = volume.values.shape
    assert n_depth == len(volume.depths)
    assert n_lat == len(volume.lats)
    assert n_lon == len(volume.lons)


def test_volume_stops_where_argo_does(volume):
    """0-2000 m, ascending. We don't request deeper levels."""
    depths = [float(d) for d in volume.depths]
    assert depths[0] == 0.0
    assert depths[-1] == CHUNK_MAX_DEPTH
    assert depths == sorted(depths), "depth axis must be monotonic"


def test_latitude_comes_back_ascending(volume):
    """Volumes flip on axis 1, not 0; getting it wrong mirrors the chunk."""
    assert volume.lats[0] < volume.lats[-1]
    assert volume.lons[0] < volume.lons[-1]


def test_the_water_column_is_warm_on_top_and_cold_at_depth(volume):
    """Sanity check units with physics: a Kelvin mix-up or wrong scale factor fails here."""
    surface = volume.values[0]
    assert 26.0 < np.nanmin(surface) < 31.0
    assert 26.0 < np.nanmax(surface) < 32.0
    # The Bay of Bengal at 2000 m is a few degrees above zero.
    assert 1.0 < np.nanmean(volume.values[-1]) < 5.0
    assert np.nanmean(volume.values[-1]) < np.nanmean(surface) - 20.0


def test_no_data_is_nan_and_never_zero(volume):
    """0.0 is a real temperature, so missing data must be NaN."""
    finite = volume.values[np.isfinite(volume.values)]
    assert finite.size > 0
    assert not np.any(np.isclose(finite, 0.0))


def test_a_tile_over_land_is_mostly_missing():
    """This tile covers Sri Lanka and the tip of India, so a good part is missing,
    and more of it with depth (the seabed).
    """
    coastal = em.fetch_volume(
        ds=HYCOM, time=DATE, lat_range=(5.0, 10.0), lon_range=(80.0, 85.0),
        depth_range=DEPTHS,
    )
    surface_finite = int(np.isfinite(coastal.values[0]).sum())
    deep_finite = int(np.isfinite(coastal.values[-1]).sum())
    assert 0 < surface_finite < coastal.values[0].size, "land must be missing"
    assert deep_finite < surface_finite, "the seabed must remove cells with depth"


def test_vector_volume_keeps_direction_and_shares_the_scalar_grid():
    """Speed is derived from these, so they need the same grid as the scalar."""
    vec = em.fetch_vector_volume(
        ds=CURRENTS, time=DATE, lat_range=LAT, lon_range=LON, depth_range=DEPTHS
    )
    assert vec.u.shape == vec.v.shape
    # Missing either component means no vector.
    assert np.array_equal(np.isfinite(vec.u), np.isfinite(vec.v))
    # Currents in the bay go both ways on both axes.
    assert np.nanmin(vec.u) < -0.1 and np.nanmax(vec.u) > 0.1
    assert np.nanmin(vec.v) < -0.1 and np.nanmax(vec.v) > 0.1
    # Makes sense in m/s, not cm/s.
    assert np.nanmax(np.hypot(vec.u, vec.v)) < 3.0

    scalar = em.fetch_volume(
        ds=HYCOM, time=DATE, lat_range=LAT, lon_range=LON, depth_range=DEPTHS
    )
    assert vec.u.shape == scalar.values.shape


# --- endpoints ---


def test_an_off_grid_click_snaps_to_its_tile():
    """Two clicks in the same tile should give one cache entry."""
    a = client.get("/api/chunk/meta?" + _bbox_query("temperature", 87.3, 13.9)).json()
    b = client.get("/api/chunk/meta?" + _bbox_query("temperature", 85.0, 10.0)).json()
    assert a["bbox"] == [85.0, 10.0, 90.0, 15.0]
    assert a["bbox"] == b["bbox"]
    assert a["data_url"] == b["data_url"]


def test_a_tile_with_no_coverage_is_a_404():
    """The globe uses this 404 to find the nearest chunk with data."""
    response = client.get("/api/chunk/meta?" + _bbox_query("temperature", 75.0, 20.0))
    assert response.status_code == 404
    detail = response.json()["detail"]
    # The message should say what to do next.
    assert "no coverage" in detail.lower()


def test_the_payload_matches_the_shape_the_metadata_promised():
    """A mismatch here would draw a chunk with the wrong shape."""
    meta = client.get("/api/chunk/meta?" + _bbox_query("temperature")).json()
    body = client.get("/api/chunk/data?" + _bbox_query("temperature")).content
    n_depth, n_lat, n_lon = meta["shape"]
    assert len(body) == n_depth * n_lat * n_lon * 4
    assert len(meta["depth_levels"]) == n_depth
    assert len(meta["grid"]["lat"]) == n_lat
    assert len(meta["grid"]["lon"]) == n_lon


def test_the_vector_payload_is_two_planes_of_that_same_shape():
    meta = client.get("/api/chunk/meta?" + _bbox_query("speed")).json()
    assert meta["vector_url"] is not None
    response = client.get("/api/chunk/vector?" + _bbox_query("speed"))
    n_depth, n_lat, n_lon = meta["shape"]
    assert response.headers["X-Chunk-Planes"] == "2"
    assert len(response.content) == 2 * n_depth * n_lat * n_lon * 4


def test_a_surface_variable_reports_a_depth_axis_of_one():
    """Chlorophyll has no 3D source. It still comes back as a one-level volume, marked
    ``kind: surface`` so the view can turn off the depth modes.
    """
    meta = client.get("/api/chunk/meta?" + _bbox_query("chlorophyll")).json()
    assert meta["kind"] == "surface"
    assert meta["shape"][0] == 1
    assert meta["depth_levels"] == [0.0]
    assert meta["vector_url"] is None
