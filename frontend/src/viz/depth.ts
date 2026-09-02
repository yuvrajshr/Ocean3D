/**
 * The vertical axis, defined once.
 *
 * The 3D water column, the depth ruler and the profile chart must agree
 * exactly on where a given depth sits, or the app quietly lies: a float's
 * thermocline would draw at a different height than the analysis's. So the
 * transform lives here and nothing computes its own.
 *
 * The scale is square-root, not linear. Nearly all the structure worth seeing —
 * the mixed layer, the thermocline, a cyclone's cold wake — is in the top
 * 200 m of a 2000 m column, and a linear axis compresses it into 10% of the
 * height. Square root gives the surface layer proportionate space while keeping
 * the axis monotonic and honest. Ticks are always labelled with true metres, so
 * the reader is never asked to infer a value from a position.
 */

export const SURFACE_DEPTH = 0;
export const MAX_DEPTH = 2000;

/**
 * Curvature of the depth axis.
 *
 * Square root (0.5) gives the surface layer the most space, but its slope is
 * infinite at zero — which turned the continental shelf, dropping 0 to 200 m
 * across a single grid cell, into a sheer vertical cliff once the seafloor was
 * drawn on the same axis. 0.65 keeps most of the surface emphasis (the top
 * 200 m still gets ~22% of a 2000 m column, against 3.6% for a linear axis)
 * while being finite and well-behaved at the coastline.
 */
export const DEPTH_EXPONENT = 0.65;

/** Depth in metres to a normalized 0 (surface) .. 1 (max) position. */
export function depthToNorm(depth: number, maxDepth = MAX_DEPTH): number {
  const clamped = Math.max(0, Math.min(maxDepth, depth));
  return Math.pow(clamped / maxDepth, DEPTH_EXPONENT);
}

/**
 * Same curve, but allowed past 1.0 — the analysis stops at 2000 m and the
 * seafloor does not, so the terrain needs to continue below the ruler.
 */
export function depthToNormUnclamped(depth: number, maxDepth = MAX_DEPTH): number {
  return Math.pow(Math.max(0, depth) / maxDepth, DEPTH_EXPONENT);
}

/** Inverse of depthToNorm — used when a drag on the ruler becomes a depth. */
export function normToDepth(norm: number, maxDepth = MAX_DEPTH): number {
  const clamped = Math.max(0, Math.min(1, norm));
  return Math.pow(clamped, 1 / DEPTH_EXPONENT) * maxDepth;
}

/**
 * Tick depths for the ruler.
 *
 * Hand-chosen rather than generated: these are the depths oceanographers
 * actually reference (the mixed layer, the 26 °C isotherm's usual range, the
 * Argo parking depth at 1000 m, and its profile floor at 2000 m). An
 * even-spaced generated set would be arithmetically tidy and less useful.
 */
export const RULER_TICKS: readonly number[] = [
  0, 25, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000,
];

/** The subset that gets a printed label; the rest are unlabelled hairlines. */
export const LABELLED_TICKS: ReadonlySet<number> = new Set([
  0, 50, 100, 200, 500, 1000, 2000,
]);

/**
 * Resample a column defined at arbitrary depths onto evenly-spaced positions in
 * the normalized (square-root) axis.
 *
 * The INCOIS grid's 24 levels are unevenly spaced — dense near the surface,
 * sparse below 1000 m — but a 3D texture samples uniformly. Resampling here
 * means the shader can do a plain linear lookup, and the visual spacing matches
 * the ruler exactly.
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

    // Never interpolate across a gap: a NaN neighbour means the analysis has no
    // value there, and inventing one would draw ocean where there is none.
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
