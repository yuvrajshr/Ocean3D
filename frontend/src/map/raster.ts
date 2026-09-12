/**
 * Colours a field into pixels on the CPU.
 *
 * Not a shader on purpose: GPU paths (tone mapping, colour-space conversion) have
 * shifted colormap values away from the colorbar before. Writing LUT bytes into
 * ImageData avoids all of that, and it's easy to unit test in Node.
 *
 * Performance is fine: a global slice is ~300k cells and this only reruns when
 * the data or scale changes, not on pan or zoom.
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
  /** Log scale, for skewed fields like chlorophyll. */
  log?: boolean;
  /** 0..1, applied to every valid pixel. No-data stays transparent. */
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
 * Colour one depth slice into an ImageData, north up.
 *
 * The data is (lat, lon) with latitude ascending, so row 0 is the south. ImageData
 * row 0 is the top (north), so rows are written in reverse. Tests check this.
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

/**
 * Just the RGBA bytes, so the colouring can be tested in Node (ImageData is a
 * browser global).
 */
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

  // Shared with the 3D volume so diverging maps are centred the same way.
  let encoded = encodeRange(valueRange, colormap);
  if (log) {
    // Log scale can't do zero, and these fields can reach it.
    const lo = Math.max(encoded[0], 1e-4);
    const hi = Math.max(encoded[1], lo * 10);
    encoded = [Math.log10(lo), Math.log10(hi)];
  }

  // Use an explicit ArrayBuffer: TypeScript 7 types a bare Uint8ClampedArray as
  // ArrayBufferLike, which ImageData won't accept.
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
        // No data: fully transparent so the basemap shows through.
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
 * Land / no-data mask as an opaque silhouette. It comes from the data's own
 * missing values, so it always matches the data and needs no extra request.
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
  // Explicit ArrayBuffer, see above.
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

/** Nearest-cell lookup for the value under the cursor. */
export function sampleAt(
  values: Float32Array,
  grid: SliceGrid,
  lat: number,
  lon: number,
): number | null {
  const row = Math.round((lat - grid.lat0) / grid.dlat);
  let col = Math.round((lon - grid.lon0) / grid.dlon);
  // Longitude wraps; latitude doesn't.
  const span = grid.n_lon * grid.dlon;
  if (Math.abs(span) >= 359) col = ((col % grid.n_lon) + grid.n_lon) % grid.n_lon;
  if (row < 0 || row >= grid.n_lat || col < 0 || col >= grid.n_lon) return null;
  const value = values[row * grid.n_lon + col]!;
  return Number.isFinite(value) ? value : null;
}
