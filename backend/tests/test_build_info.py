"""The API reports the commit it started from, cheaply."""

from fastapi.testclient import TestClient

from app import build_info
from app.main import app

client = TestClient(app)


def test_build_reports_the_start_commit():
    res = client.get("/api/build")
    assert res.status_code == 200
    body = res.json()
    assert set(body) == {"sha", "branch", "started_at"}
    # Running from a checkout: the sha is a real 40-character commit id.
    assert body["sha"] == build_info.SHA
    assert body["sha"] is None or len(body["sha"]) == 40
    assert isinstance(body["started_at"], int)


def test_build_is_fixed_at_import_not_read_per_request(monkeypatch):
    # The point of the endpoint is to report what the PROCESS started with, so
    # a later `git pull` must not change the answer until the process restarts.
    monkeypatch.setattr(build_info, "_git", lambda *a: "0" * 40)
    assert client.get("/api/build").json()["sha"] == build_info.SHA
