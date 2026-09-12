/**
 * cmocean colormaps for data.
 *
 * Only for encoding values, never for UI colours. They're perceptually uniform,
 * so there's no fake banding and they hold up for colour-blind readers. Values
 * are sampled from Kristen Thyng's cmocean, the usual choice in oceanography.
 */

export type ColormapName =
  | "thermal"
  | "haline"
  | "delta"
  | "balance"
  | "speed"
  | "algae";

type Stop = [number, number, number];

/** Control points, low to high. Interpolated to 256 steps. */
const STOPS: Record<ColormapName, Stop[]> = {
  // Temperature: deep blue (cold) through magenta to pale yellow (warm).
  thermal: [
    [3, 35, 51], [23, 51, 122], [85, 59, 137], [129, 79, 143],
    [170, 100, 132], [208, 127, 113], [233, 165, 92], [243, 209, 89],
    [232, 250, 91],
  ],
  // Salinity: indigo (fresh) through teal to pale gold (salty).
  haline: [
    [41, 24, 107], [37, 58, 143], [12, 98, 137], [10, 130, 131],
    [23, 161, 125], [86, 190, 103], [175, 211, 78], [238, 227, 106],
    [253, 238, 153],
  ],
  // Diverging, for anomaly fields.
  delta: [
    [16, 31, 63], [42, 107, 165], [134, 198, 224], [241, 237, 236],
    [159, 204, 114], [71, 145, 60], [37, 45, 20],
  ],
  // Diverging blue-white-red around zero, for model minus observation:
  // blue = model too warm, red = model too cold.
  balance: [
    [24, 28, 67], [37, 82, 158], [96, 154, 205], [178, 205, 226],
    [241, 237, 236], [228, 178, 160], [206, 108, 88], [161, 42, 43],
    [92, 17, 24],
  ],
  // Current speed: pale (slow) to dark teal (fast).
  speed: [
    [255, 252, 224], [214, 232, 160], [150, 206, 124], [79, 174, 114],
    [27, 138, 107], [25, 98, 87], [20, 52, 58],
  ],
  // Chlorophyll.
  algae: [
    [215, 249, 208], [162, 225, 160], [107, 199, 126], [53, 169, 106],
    [20, 139, 94], [20, 107, 78], [16, 69, 59], [11, 42, 35],
  ],
};

export const LUT_SIZE = 256;

/** Build a 256-entry RGB lookup table from the stops. */
export function buildLut(name: ColormapName): Uint8Array {
  const stops = STOPS[name] ?? STOPS.thermal;
  const lut = new Uint8Array(LUT_SIZE * 3);
  const segments = stops.length - 1;

  for (let i = 0; i < LUT_SIZE; i++) {
    const t = (i / (LUT_SIZE - 1)) * segments;
    const idx = Math.min(Math.floor(t), segments - 1);
    const frac = t - idx;
    const a = stops[idx]!;
    const b = stops[idx + 1]!;
    lut[i * 3 + 0] = Math.round(a[0] + (b[0] - a[0]) * frac);
    lut[i * 3 + 1] = Math.round(a[1] + (b[1] - a[1]) * frac);
    lut[i * 3 + 2] = Math.round(a[2] + (b[2] - a[2]) * frac);
  }
  return lut;
}

/** One CSS colour from a colormap, for legends and chart lines. */
export function sampleCss(name: ColormapName, t: number): string {
  const lut = buildLut(name);
  const i = Math.max(0, Math.min(LUT_SIZE - 1, Math.round(t * (LUT_SIZE - 1))));
  return `rgb(${lut[i * 3]}, ${lut[i * 3 + 1]}, ${lut[i * 3 + 2]})`;
}

/** CSS gradient for the colorbar. */
export function toCssGradient(name: ColormapName, steps = 24): string {
  const lut = buildLut(name);
  const parts: string[] = [];
  for (let s = 0; s < steps; s++) {
    const t = s / (steps - 1);
    const i = Math.round(t * (LUT_SIZE - 1));
    parts.push(`rgb(${lut[i * 3]}, ${lut[i * 3 + 1]}, ${lut[i * 3 + 2]}) ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(to top, ${parts.join(", ")})`;
}

/** Diverging maps have to be centred on zero. */
export const DIVERGING: ReadonlySet<ColormapName> = new Set(["balance", "delta"]);

/**
 * The range actually encoded into the LUT, after re-centring diverging maps.
 * Used by the volume, the colorbar and the map, so a value gets the same colour
 * everywhere.
 */
export function encodeRange(
  range: [number, number],
  colormap: ColormapName,
): [number, number] {
  if (!DIVERGING.has(colormap)) return range;
  // Centre diverging maps on zero so "no difference" is the neutral colour.
  const extent = Math.max(Math.abs(range[0]), Math.abs(range[1])) || 1;
  return [-extent, extent];
}

/** Value to 0..1 in an encoded range. Non-finite gives NaN. */
export function normaliseValue(value: number, encoded: [number, number]): number {
  const span = encoded[1] - encoded[0] || 1;
  return Number.isFinite(value) ? (value - encoded[0]) / span : NaN;
}

/** Value to LUT index, or -1 for no data. */
export function lutIndex(value: number, encoded: [number, number]): number {
  const t = normaliseValue(value, encoded);
  if (!Number.isFinite(t)) return -1;
  return Math.max(0, Math.min(LUT_SIZE - 1, Math.round(t * (LUT_SIZE - 1))));
}
