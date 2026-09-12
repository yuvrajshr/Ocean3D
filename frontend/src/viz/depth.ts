/**
 * The depth axis, shared by the 3D column, the depth ruler and the profile chart
 * so they all put a given depth at the same height.
 *
 * The scale is a power curve, not linear: most of the interesting structure
 * (mixed layer, thermocline, cold wake) is in the top 200 m of 2000 m. Ticks
 * always show real metres.
 */

export const SURFACE_DEPTH = 0;
export const MAX_DEPTH = 2000;

/**
 * Depth axis exponent. 0.5 (square root) has infinite slope at zero, which made
 * the continental shelf look like a cliff. 0.65 still gives the top 200 m about
 * 22% of the height (vs 3.6% linear).
 */
export const DEPTH_EXPONENT = 0.65;

/** Depth in metres to 0 (surface) .. 1 (max). */
export function depthToNorm(depth: number, maxDepth = MAX_DEPTH): number {
  const clamped = Math.max(0, Math.min(maxDepth, depth));
  return Math.pow(clamped / maxDepth, DEPTH_EXPONENT);
}

/** Same curve but can go past 1, for terrain below 2000 m. */
export function depthToNormUnclamped(depth: number, maxDepth = MAX_DEPTH): number {
  return Math.pow(Math.max(0, depth) / maxDepth, DEPTH_EXPONENT);
}

/** Inverse of depthToNorm, for dragging on the ruler. */
export function normToDepth(norm: number, maxDepth = MAX_DEPTH): number {
  const clamped = Math.max(0, Math.min(1, norm));
  return Math.pow(clamped, 1 / DEPTH_EXPONENT) * maxDepth;
}

/**
 * Ruler tick depths. Picked by hand: depths people actually refer to (mixed layer,
 * 26 °C isotherm range, Argo parking depth 1000 m, profile floor 2000 m).
 */
export const RULER_TICKS: readonly number[] = [
  0, 25, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000,
];

/** Ticks that get a label; the rest are plain lines. */
export const LABELLED_TICKS: ReadonlySet<number> = new Set([
  0, 50, 100, 200, 500, 1000, 2000,
]);

/**
 * Resample a column from its own depth levels onto even steps of the normalised
 * axis. The INCOIS levels are uneven, but a 3D texture samples evenly, so this
 * lets the shader do a plain lookup that lines up with the ruler.
 */
export function resampleToNormAxis(
  sourceDepths: readonly number[],
  sourceValues: Float32Array,
  offset: number,
  stride: number,
  layers: number,
  maxDepth = MAX_DEPTH,
): Float32Array {
  const out = new Float32Array(layers);
  const norms = sourceDepths.map((d) => depthToNorm(d, maxDepth));
  if (norms.length === 0) return out;

  for (let k = 0; k < layers; k++) {
    const target = k / (layers - 1);

    if (target <= norms[0]!) {
      out[k] = sourceValues[offset]!;
      continue;
    }
    if (target >= norms[norms.length - 1]!) {
      out[k] = sourceValues[offset + (sourceDepths.length - 1) * stride]!;
      continue;
    }

    let hi = 1;
    while (hi < norms.length && norms[hi]! < target) hi++;
    const lo = hi - 1;

    const a = sourceValues[offset + lo * stride]!;
    const b = sourceValues[offset + hi * stride]!;

    // Don't interpolate across a gap, or we'd draw ocean where there's no data.
    if (Number.isNaN(a) || Number.isNaN(b)) {
      out[k] = Number.isNaN(a) ? b : a;
      continue;
    }

    const span = norms[hi]! - norms[lo]!;
    const t = span > 0 ? (target - norms[lo]!) / span : 0;
    out[k] = a + (b - a) * t;
  }
  return out;
}
