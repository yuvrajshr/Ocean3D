"""Disk cache with honest provenance.

Demo-day rule: the app must keep working when the venue wifi does not. So every
upstream response is written to disk, and if INCOIS is unreachable we serve the
stale copy and *say so* rather than pretending it is live.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from pathlib import Path

from .config import CACHE_DIR, CACHE_TTL_SECONDS


@dataclass
class CacheEntry:
    payload: bytes
    fetched_at: float
    stale: bool


def _key(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()[:32]


def _paths(url: str) -> tuple[Path, Path]:
    k = _key(url)
    return CACHE_DIR / f"{k}.bin", CACHE_DIR / f"{k}.json"


def read(url: str, *, ttl: int = CACHE_TTL_SECONDS) -> CacheEntry | None:
    """Return a cached response, or None if we have never seen this URL.

    A hit past its TTL is still returned, flagged ``stale``. The caller decides
    whether to try the network first — but it always has something to fall back
    on.
    """
    blob, meta = _paths(url)
    if not blob.exists() or not meta.exists():
        return None
    try:
        info = json.loads(meta.read_text(encoding="utf-8"))
        fetched_at = float(info["fetched_at"])
    except (json.JSONDecodeError, KeyError, ValueError, OSError):
        return None
    return CacheEntry(
        payload=blob.read_bytes(),
        fetched_at=fetched_at,
        stale=(time.time() - fetched_at) > ttl,
    )


def write(url: str, payload: bytes) -> float:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    blob, meta = _paths(url)
    now = time.time()
    blob.write_bytes(payload)
    meta.write_text(
        json.dumps({"url": url, "fetched_at": now, "bytes": len(payload)}, indent=2),
        encoding="utf-8",
    )
    return now
