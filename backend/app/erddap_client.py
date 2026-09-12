"""All ERDDAP requests go through here.

ERDDAP sends no CORS headers, so the browser can't call it directly. INCOIS also
serves an incomplete TLS chain, so verification is turned off for that host only.
"""

from __future__ import annotations

import datetime as dt
import logging
import urllib.parse

import httpx

from . import cache
from .config import ERDDAP_BASE, ERDDAP_VERIFY_TLS
from .models.schemas import SourceStatus

log = logging.getLogger("erddap")

if not ERDDAP_VERIFY_TLS:
    log.warning(
        "TLS verification is DISABLED for %s because the server omits its "
        "intermediate certificate. Scoped to this client only.",
        ERDDAP_BASE,
    )

_HEADERS = {"User-Agent": "INCOIS-OceanViz/0.1 (SIH 2026 PS 26067)"}
_TIMEOUT = httpx.Timeout(120.0, connect=20.0)

# Relaxed TLS for INCOIS only; every other host is verified.
_incois_client = httpx.Client(
    verify=ERDDAP_VERIFY_TLS, timeout=_TIMEOUT, follow_redirects=True, headers=_HEADERS
)
_strict_client = httpx.Client(
    verify=True, timeout=_TIMEOUT, follow_redirects=True, headers=_HEADERS
)


def _client_for(url: str) -> httpx.Client:
    return _incois_client if "incois.gov.in" in url else _strict_client


class UpstreamUnavailable(RuntimeError):
    """The upstream failed and there's nothing cached. Also covers a server returning
    500 for one specific query (APDRC does this for some HYCOM depth ranges).
    """


class UpstreamRefused(UpstreamUnavailable):
    """The server answered with an error for this request, usually because the query is
    outside what the dataset has. Subclass so existing handlers still catch it.
    """

    def __init__(self, host: str, status: int) -> None:
        super().__init__(f"{host} refused this request (HTTP {status}).")
        self.host = host
        self.status = status


def _host(url: str) -> str:
    """Host name, used in error messages."""
    try:
        return urllib.parse.urlsplit(url).netloc or "The upstream"
    except ValueError:
        return "The upstream"


def _iso(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts, dt.UTC).isoformat(timespec="seconds")


def fetch(url: str, *, allow_cache: bool = True) -> tuple[bytes, SourceStatus]:
    """GET a URL: fresh cache, then network, then stale cache. The SourceStatus says
    which one we used.
    """
    cached = cache.read(url) if allow_cache else None
    if cached and not cached.stale:
        return cached.payload, SourceStatus(
            provenance="cached",
            fetched_at=_iso(cached.fetched_at),
            upstream=url,
            note="Served from local cache.",
        )

    try:
        response = _client_for(url).get(url)
        response.raise_for_status()
        payload = response.content
        fetched_at = cache.write(url, payload)
        return payload, SourceStatus(
            provenance="live",
            fetched_at=_iso(fetched_at),
            upstream=url,
        )
    except (httpx.HTTPError, OSError) as exc:
        if cached is not None:
            log.warning("INCOIS unreachable (%s); serving cached copy.", exc)
            return cached.payload, SourceStatus(
                provenance="cached",
                fetched_at=_iso(cached.fetched_at),
                upstream=url,
                note=f"{_host(url)} did not answer — showing the last copy we fetched.",
            )
        if isinstance(exc, httpx.HTTPStatusError):
            raise UpstreamRefused(_host(url), exc.response.status_code) from exc
        raise UpstreamUnavailable(
            f"{_host(url)} did not answer this request and it has not been cached."
        ) from exc


# ERDDAP uses [ ] < > " in its query syntax and Tomcat rejects them unencoded
# (HTTP 400). These characters have to stay literal:
_QUERY_SAFE = "=&,():/.-~*"


def _encode_query(query: str) -> str:
    """Percent-encode a query but keep ERDDAP's syntax characters."""
    return urllib.parse.quote(query, safe=_QUERY_SAFE)


def griddap_url(dataset_id: str, query: str, fmt: str = "nc", base: str = ERDDAP_BASE) -> str:
    return f"{base}/griddap/{dataset_id}.{fmt}?{_encode_query(query)}"


def tabledap_url(dataset_id: str, variables: list[str], constraints: list[str], fmt: str = "json") -> str:
    cols = ",".join(variables)
    parts = [cols, *constraints]
    return f"{ERDDAP_BASE}/tabledap/{dataset_id}.{fmt}?{_encode_query('&'.join(parts))}"
