"""The one place that talks to erddap.incois.gov.in.

Two upstream quirks are contained here so they cannot leak into the rest of the
app:

1. **No CORS headers.** The browser cannot call ERDDAP directly at all. This is
   why the backend exists (context.md §10).
2. **Incomplete TLS chain.** INCOIS serves its leaf certificate without the
   intermediate, so strict clients raise UNABLE_TO_VERIFY_LEAF_SIGNATURE.
   Browsers usually recover by fetching the missing intermediate via the AIA
   extension; httpx does not. Verification is therefore disabled *for this host
   only*, and loudly, rather than silently across the process.
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

# INCOIS gets the relaxed client because of its incomplete chain. Every other
# host — NOAA CoastWatch, which serves the ETOPO relief — is verified normally.
# Keeping these separate means the workaround cannot silently spread.
_incois_client = httpx.Client(
    verify=ERDDAP_VERIFY_TLS, timeout=_TIMEOUT, follow_redirects=True, headers=_HEADERS
)
_strict_client = httpx.Client(
    verify=True, timeout=_TIMEOUT, follow_redirects=True, headers=_HEADERS
)


def _client_for(url: str) -> httpx.Client:
    return _incois_client if "incois.gov.in" in url else _strict_client


class UpstreamUnavailable(RuntimeError):
    """INCOIS could not be reached and nothing was cached."""


def _iso(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts, dt.UTC).isoformat(timespec="seconds")


def fetch(url: str, *, allow_cache: bool = True) -> tuple[bytes, SourceStatus]:
    """GET a URL, preferring the network but never depending on it.

    Order: fresh cache -> network -> stale cache. The returned SourceStatus
    records which of those actually happened, and the UI shows it.
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
                note="INCOIS ERDDAP was unreachable — showing the last copy we fetched.",
            )
        raise UpstreamUnavailable(
            "INCOIS ERDDAP is unreachable and this request has not been cached."
        ) from exc


# ERDDAP's own query syntax uses characters that RFC 3986 reserves: square
# brackets for griddap subsetting, and < > " in tabledap constraints. Tomcat,
# which ERDDAP runs on, rejects those raw with a bare HTTP 400 — verified
# against the live server, where every raw-bracket request failed and every
# percent-encoded one succeeded. These characters are ERDDAP's grammar and must
# stay literal, so they are the safe set:
_QUERY_SAFE = "=&,():/.-~*"


def _encode_query(query: str) -> str:
    """Percent-encode a query while preserving ERDDAP's own syntax characters."""
    return urllib.parse.quote(query, safe=_QUERY_SAFE)


def griddap_url(dataset_id: str, query: str, fmt: str = "nc", base: str = ERDDAP_BASE) -> str:
    return f"{base}/griddap/{dataset_id}.{fmt}?{_encode_query(query)}"


def tabledap_url(dataset_id: str, variables: list[str], constraints: list[str], fmt: str = "json") -> str:
    cols = ",".join(variables)
    parts = [cols, *constraints]
    return f"{ERDDAP_BASE}/tabledap/{dataset_id}.{fmt}?{_encode_query('&'.join(parts))}"
