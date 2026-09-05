/**
 * Colouring a field into pixels, on the CPU.
 *
 * Deliberately not a shader. context.md §10 records two separate incidents where
 * a GPU path silently shifted a cmocean value away from the colorbar that
 * labelled it — once through renderer tone mapping, once through a Three.js
 * addon's colour-space fragment. Writing LUT bytes straight into an ImageData
 * removes that entire class of failure: there is no colour-space conversion, no
 * premultiplied alpha, no filtering mode, and no `outputColorSpace` to get wrong.
 *
 * It is also the only version that can be tested. The screenshot harness runs on
 * SwiftShader and, as next_session.md §7 states, tells you nothing about shading;
 * this function is pure and returns bytes you can assert on in Node.
 *
 * Cost is not the constraint: a global HYCOM slice is ~300k cells, one LUT lookup
 * each, and it re-runs only when the data or the scale changes — never on pan or
 * zoom, which are a canvas transform over an already-coloured bitmap.
 */

import { buildLut, encodeRange, lutIndex, type ColormapName } from "../viz/colormaps";

export interface SliceGrid {
  lat0: number;
  dlat: number;
  n_lat: number;
  lon0: number;
  dlon: number;
  n_lon: number;
}

export interface RasterOptions {
  /** Logarithmic scale, for strongly right-skewed fields such as chlorophyll. */
  log?: boolean;
  /** 0..1, applied to every valid pixel. No-data stays fully transparent. */
  opacity?: number;
}

const lutCache = new Map<ColormapName, Uint8Array>();

function lutFor(name: ColormapName): Uint8Array {
  let lut = lutCache.get(name);
  if (!lut) {
    lut = buildLut(name);
    lutCache.set(name, lut);
  }
  return lut;
}

/**
 * Colour one depth slice into an ImageData, north-up.
 *
 * The payload arrives C order (lat, lon) with **latitude ascending** — row 0 is
 * the southernmost. An ImageData's row 0 is the TOP of the picture, which is
 * north. So the rows are written in reverse. Getting this wrong renders a
 * perfectly plausible upside-down ocean, which is why it is stated here and
 * asserted in the tests rather than left to the reader.
 */
export function rasterizeSlice(
  values: Float32Array,
  grid: SliceGrid,
  valueRange: [number, number],
  colormap: ColormapName,
  options: RasterOptions = {},
): ImageData {
  const bytes = rasterizeSliceBytes(values, grid, valueRange, colormap, options);
  return new ImageData(bytes, grid.n_lon, grid.n_lat);
}

/** The pixels themselves, RGBA, without the DOM wrapper.
 *
 *  Split out so the colouring can be asserted byte-for-byte in a plain Node
 *  test: `ImageData` is a browser global, and the thing worth testing is the
 *  bytes, not the wrapper. */
export function rasterizeSliceBytes(
  values: Float32Array,
  grid: SliceGrid,
  valueRange: [number, number],
  colormap: ColormapName,
  options: RasterOptions = {},
): Uint8ClampedArray<ArrayBuffer> {
  const { n_lat: nLat, n_lon: nLon } = grid;
  if (values.length !== nLat * nLon) {
    throw new Error(`rasterizeSlice: ${values.length} values for a ${nLat}x${nLon} grid`);
  }

  const lut = lutFor(colormap);
  const log = options.log === true;
  const alpha = Math.round(Math.max(0, Math.min(1, options.opacity ?? 1)) * 255);

  // encodeRange is shared with the 3D volume so a diverging map is centred
  // identically in both views. See its comment in viz/colormaps.ts.
  let encoded = encodeRange(valueRange, colormap);
  if (log) {
    // Guard the lower bound: a log scale cannot express zero, and these fields
    // (chlorophyll especially) legitimately reach it.
    const lo = Math.max(encoded[0], 1e-4);
    const hi = Math.max(encoded[1], lo * 10);
    encoded = [Math.log10(lo), Math.log10(hi)];
  }

  // Allocated from an explicit ArrayBuffer: TypeScript 7 types a bare
  // Uint8ClampedArray as ArrayBufferLike, which ImageData will not accept.
  const out = new Uint8ClampedArray(new ArrayBuffer(nLat * nLon * 4));
  for (let row = 0; row < nLat; row++) {
    // Flip: data row 0 is south, image row 0 is north.
    const src = (nLat - 1 - row) * nLon;
    const dst = row * nLon * 4;
    for (let col = 0; col < nLon; col++) {
      const raw = values[src + col]!;
      const value = log ? (raw > 0 ? Math.log10(raw) : NaN) : raw;
      const i = lutIndex(value, encoded);
      const o = dst + col * 4;
      if (i < 0) {
        // No data. Fully transparent so the basemap shows through — never a
        // colour, which would read as a measurement.
        out[o + 3] = 0;
        continue;
      }
      out[o] = lut[i * 3]!;
      out[o + 1] = lut[i * 3 + 1]!;
      out[o + 2] = lut[i * 3 + 2]!;
      out[o + 3] = alpha;
    }
  }
  return out;
}

/**
 * A land / no-data mask as an opaque silhouette.
 *
 * The basemap is derived from the data's own missing values rather than a
 * coastline asset — the same decision context.md §10 already records for the 3D
 * view ("land is derived from the analysis's own no-data mask"). It cannot drift
 * from the data, needs no extra request, and at a global grid it is a finer
 * coastline than a strided bathymetry file would give.
 */
export function rasterizeLandMask(
  values: Float32Array,
  grid: SliceGrid,
  rgb: [number, number, number],
  alpha = 255,
): ImageData {
  return new ImageData(rasterizeLandMaskBytes(values, grid, rgb, alpha), grid.n_lon, grid.n_lat);
}

export function rasterizeLandMaskBytes(
  values: Float32Array,
  grid: SliceGrid,
  rgb: [number, number, number],
  alpha = 255,
): Uint8ClampedArray<ArrayBuffer> {
  const { n_lat: nLat, n_lon: nLon } = grid;
  // Allocated from an explicit ArrayBuffer: TypeScript 7 types a bare
  // Uint8ClampedArray as ArrayBufferLike, which ImageData will not accept.
  const out = new Uint8ClampedArray(new ArrayBuffer(nLat * nLon * 4));
  for (let row = 0; row < nLat; row++) {
    const src = (nLat - 1 - row) * nLon;
    const dst = row * nLon * 4;
    for (let col = 0; col < nLon; col++) {
      if (Number.isFinite(values[src + col]!)) continue; // ocean: leave clear
      const o = dst + col * 4;
      out[o] = rgb[0];
      out[o + 1] = rgb[1];
      out[o + 2] = rgb[2];
      out[o + 3] = alpha;
    }
  }
  return out;
}

/** Nearest-cell lookup, for the value readout under the cursor. */
export function sampleAt(
  values: Float32Array,
  grid: SliceGrid,
  lat: number,
  lon: number,
): number | null {
  const row = Math.round((lat - grid.lat0) / grid.dlat);
  let col = Math.round((lon - grid.lon0) / grid.dlon);
  // Longitude wraps; latitude does not.
  const span = grid.n_lon * grid.dlon;
  if (Math.abs(span) >= 359) col = ((col % grid.n_lon) + grid.n_lon) % grid.n_lon;
  if (row < 0 || row >= grid.n_lat || col < 0 || col >= grid.n_lon) return null;
  const value = values[row * grid.n_lon + col]!;
  return Number.isFinite(value) ? value : null;
}
