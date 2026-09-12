"""Colour scale range, shared by the field, map and chunk routes."""

from __future__ import annotations

import numpy as np


class ValueRange:
    """Colorbar range, and whether it cuts off real extremes."""

    __slots__ = ("low", "high", "true_low", "true_high", "clipped")

    def __init__(self, low: float, high: float, true_low: float, true_high: float, clipped: bool):
        self.low = low
        self.high = high
        self.true_low = true_low
        self.true_high = true_high
        self.clipped = clipped


def percentile_range(values: np.ndarray, lo_pct: float = 2.0, hi_pct: float = 98.0) -> ValueRange | None:
    """Use the 2nd-98th percentile instead of min/max.

    Currents blow up near the equator and chlorophyll is heavily skewed, so one
    outlier would flatten the whole scale. The true range is still returned.
    Returns None if there's nothing finite.
    """
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return None

    low, high = (float(v) for v in np.percentile(finite, [lo_pct, hi_pct]))
    true_low, true_high = float(finite.min()), float(finite.max())
    if not np.isfinite(low) or not np.isfinite(high) or high <= low:
        low, high = true_low, true_high
    return ValueRange(
        low=low,
        high=high,
        true_low=true_low,
        true_high=true_high,
        clipped=low > true_low or high < true_high,
    )
