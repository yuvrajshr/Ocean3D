"""An HTTP error from an upstream says "refused", not "unreachable".

APDRC answered HTTP 500 for a date outside HYCOM's coverage, and every HTTP
error used to surface as "did not answer ... not cached" — sending a reader to
check the network when the query itself was the problem. No network.
"""
import httpx
import pytest
from fastapi import HTTPException

from app import erddap_client
from app.config import MAP_DATASETS_BY_ID
from app.erddap_client import UpstreamRefused, UpstreamUnavailable
from app.routers import chunk as chunk_router
from app.routers import map as map_router

URL = "https://apdrc.soest.hawaii.edu/erddap/griddap/x.nc?water_temp"


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_http_500_is_refused_and_names_the_status(monkeypatch):
    monkeypatch.setattr(erddap_client, "_strict_client", _client(lambda r: httpx.Response(500)))
    with pytest.raises(UpstreamRefused) as e:
        erddap_client.fetch(URL, allow_cache=False)
    assert e.value.status == 500
    assert "apdrc.soest.hawaii.edu" in str(e.value) and "HTTP 500" in str(e.value)
    assert isinstance(e.value, UpstreamUnavailable), "existing handlers must still catch it"


def test_a_connection_failure_is_still_unreachable(monkeypatch):
    def boom(request):
        raise httpx.ConnectError("no route", request=request)

    monkeypatch.setattr(erddap_client, "_strict_client", _client(boom))
    with pytest.raises(UpstreamUnavailable) as e:
        erddap_client.fetch(URL, allow_cache=False)
    assert not isinstance(e.value, UpstreamRefused)
    assert "did not answer" in str(e.value)


@pytest.mark.parametrize("router", [map_router, chunk_router])
def test_the_routers_report_a_refusal_as_one(router):
    ds = MAP_DATASETS_BY_ID["hycom_temperature"]

    def refuse():
        raise UpstreamRefused("apdrc.soest.hawaii.edu", 500)

    with pytest.raises(HTTPException) as e:
        router._guard(ds, refuse)
    assert e.value.status_code == 502
    assert "refused" in e.value.detail and "unreachable" not in e.value.detail
