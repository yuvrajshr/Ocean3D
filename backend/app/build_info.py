"""Which commit this API process was started from.

Read once, at import. That is the point: uvicorn runs without --reload, so
after a `git pull` the process keeps serving the code it started with. Reporting
the start commit lets the frontend show "api <sha>" beside its own, and a
mismatch is the whole diagnosis — no one has to guess which half is stale.

Returns None for the sha when git is unavailable (a zip download, a container
without .git); the UI then shows nothing rather than a made-up identity.
"""

from __future__ import annotations

import subprocess
import time
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]


def _git(*args: str) -> str | None:
    try:
        out = subprocess.run(
            ["git", *args],
            cwd=_REPO,
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() or None


SHA: str | None = _git("rev-parse", "HEAD")
BRANCH: str | None = _git("rev-parse", "--abbrev-ref", "HEAD")
STARTED_AT_MS: int = int(time.time() * 1000)


def identity() -> dict[str, object]:
    return {"sha": SHA, "branch": BRANCH, "started_at": STARTED_AT_MS}
