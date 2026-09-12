"""/api/build reports the commit the API started from."""

from fastapi.testclient import TestClient

from app import build_info
from app.main import app

client = TestClient(app)


def test_build_reports_the_start_commit():
    res = client.get("/api/build")
    assert res.status_code == 200
    body = res.json()
    assert set(body) == {"sha", "branch", "started_at"}
    # In a git checkout the sha is a full 40-character id.
    assert body["sha"] == build_info.SHA
    assert body["sha"] is None or len(body["sha"]) == 40
    assert isinstance(body["started_at"], int)


def test_build_is_fixed_at_import_not_read_per_request(monkeypatch):
    # It should report what the process started with, even after a later git pull.
    monkeypatch.setattr(build_info, "_git", lambda *a: "0" * 40)
    assert client.get("/api/build").json()["sha"] == build_info.SHA
