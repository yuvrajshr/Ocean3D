"""Colour-scale range for a field.

Extracted from `routers/field.py` when the 2D map needed the same rule. Two
copies of "what range does the colorbar span" is how a legend ends up
disagreeing with the pixels it labels, so there is one.
"""

from __future__ import annotations

import numpy as np


class ValueRange:
    """The span a colorbar should use, and whether it hides real extremes."""

    __slots__ = ("low", "high", "true_low", "true_high", "clipped")

    def __init__(self, low: float, high: float, true_low: float, true_high: float, clipped: bool):
        self.low = low
        self.high = high
        self.true_low = true_low
        self.true_high = true_high
        self.clipped = clipped


def percentile_range(values: np.ndarray, lo_pct: float = 2.0, hi_pct: float = 98.0) -> ValueRange | None:
    """Stretch the colour scale over the 2nd-98th percentile, not the extremes.

    Some of these fields carry genuine outliers — geostrophic currents diverge as
    1/f toward the equator, and chlorophyll is strongly right-skewed with most
    values below 1 mg/m3 — and a min/max scale lets one extreme cell wash out all
    the structure everyone actually needs to see. The true range is still
    reported, and the UI says when clipping applied.

    Returns None when there is nothing finite to scale.
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
