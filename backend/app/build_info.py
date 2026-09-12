"""The git commit this API process started from.

Read once at import. uvicorn doesn't reload, so after a pull the frontend can
show that the API is behind. None when git isn't available.
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
