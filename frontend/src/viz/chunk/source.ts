/**
 * The chunk view's data interface.
 *
 * Everything the viewport draws goes through a ChunkSource: one HYCOM sub-volume,
 * one ETOPO seabed tile and the Argo profiles, loaded by loader.ts.
 *
 * - A source is one variable at one time. A different time or variable is a new
 *   source object, so two layers can't show different moments.
 * - The field's own NaN is the water mask. ETOPO only draws the seabed; it never
 *   clips the field, since the two datasets don't agree exactly on coastlines.
 *
 * Sampling is nearest-neighbour, like the rest of the app, since interpolating
 * the 0.08 degree grid would suggest more precision than it has.
 */

import type { ChunkMeta, ChunkVectorField } from "../../api/client";
import type { VariableKey } from "./model";

export interface ChunkGrid {
  /** Longitude cells. */
  nx: number;
  /** Latitude cells. */
  ny: number;
  /** Depth levels (1 for surface variables). */
  nz: number;
  lon0: number;
  lon1: number;
  lat0: number;
  lat1: number;
  /** Deepest level present, in metres. */
  maxDepth: number;
  /** The upstream's actual levels, ascending. */
  levels: number[];
}

export interface SectionPayload {
  data: Float32Array;
  width: number;
  height: number;
}

export interface Histogram {
  counts: number[];
  lo: number;
  hi: number;
  max: number;
}

/** ETOPO elevation for one tile. Positive is land. */
export interface ChunkRelief {
  elevation: Float32Array;
  nLat: number;
  nLon: number;
  lat0: number;
  lat1: number;
  lon0: number;
  lon1: number;
  minElevation: number;
  maxElevation: number;
}

/**
 * One surfacing of one float. Argo floats report a position roughly every ten
 * days; nothing in between is known, so nothing is stored.
 */
export interface ChunkFix {
  cycle: number | null;
  time: string;
  /** Nearest step in the loaded window. */
  step: number;
  lon: number;
  lat: number;
  /** How deep this profile went. */
  maxDepth: number | null;
  nLevels: number;
  surfaceTemperature: number | null;
}

export interface ChunkPlatform {
  id: string;
  /** "argo_float" for now; gliders can plug in here later. */
  type: string;
  /** In time order. Two or more make a track. */
  fixes: ChunkFix[];
}

export interface ChunkSource {
  readonly grid: ChunkGrid;
  readonly variable: VariableKey;
  readonly meta: ChunkMeta;
  readonly relief: ChunkRelief | null;
  readonly hasVector: boolean;
  /** How much of the chunk has data, for the readout. */
  readonly coverage: { finite: number; total: number };

  lonAt(i: number): number;
  latAt(j: number): number;
  /** Index of the nearest real level to a depth in metres. */
  levelIndex(depth: number): number;
  /** Seabed depth in metres. NaN if no relief is loaded. */
  bathymetry(lon: number, lat: number): number;
  /** NaN where there's no data. */
  value(lon: number, lat: number, depth: number): number;
  /** RGBA data for a constant-depth slice: R = value, G = 1 inside the data. */
  levelTexture(depth: number): Float32Array;
  sectionTexture(axis: "lon" | "lat", f: number): SectionPayload;
  /** Depth of an isovalue per column; -1 where it doesn't occur. */
  isoDepthField(target: number): Float32Array;
  histogram(bins?: number): Histogram;
  /** Horizontal velocity in m/s. [0, 0] where there's no vector field. */
  velocity(lon: number, lat: number, depth: number): [number, number];
}

export interface ChunkPayload {
  meta: ChunkMeta;
  values: Float32Array;
  vector: ChunkVectorField | null;
  relief: ChunkRelief | null;
}

/** Nearest index on an evenly spaced axis, clamped. */
function nearest(v: number, v0: number, v1: number, n: number): number {
  if (n <= 1) return 0;
  const f = ((v - v0) / (v1 - v0)) * (n - 1);
  if (!Number.isFinite(f)) return 0;
  return f <= 0 ? 0 : f >= n - 1 ? n - 1 : Math.round(f);
}

export function createChunkSource(payload: ChunkPayload): ChunkSource {
  const { meta, values, vector, relief } = payload;
  const [nz, ny, nx] = meta.shape;
  const levels = meta.depth_levels;
  const lats = meta.grid.lat;
  const lons = meta.grid.lon;

  // Use the axes the upstream returned, not the requested tile: HYCOM cells are
  // centred, so an 85-90 request comes back as 85.04-90.0.
  const lat0 = lats[0] ?? meta.bbox[1];
  const lat1 = lats[lats.length - 1] ?? meta.bbox[3];
  const lon0 = lons[0] ?? meta.bbox[0];
  const lon1 = lons[lons.length - 1] ?? meta.bbox[2];
  const maxDepth = levels[levels.length - 1] ?? 0;

  const grid: ChunkGrid = { nx, ny, nz, lon0, lon1, lat0, lat1, maxDepth, levels };

  const plane = ny * nx;
  const at = (k: number, j: number, i: number): number => values[k * plane + j * nx + i] ?? NaN;

  const iOf = (lon: number) => nearest(lon, lon0, lon1, nx);
  const jOf = (lat: number) => nearest(lat, lat0, lat1, ny);
  const kOf = (depth: number) => {
    // Levels are uneven (0, 2, 4 ... 1500, 2000), so search instead of computing.
    let best = 0;
    let bestGap = Infinity;
    for (let k = 0; k < levels.length; k++) {
      const gap = Math.abs(levels[k]! - depth);
      if (gap < bestGap) {
        bestGap = gap;
        best = k;
      }
    }
    return best;
  };

  let finite = 0;
  for (let n = 0; n < values.length; n++) {
    if (Number.isFinite(values[n]!)) finite++;
  }

  const reliefAt = (lon: number, lat: number): number => {
    if (!relief) return NaN;
    const i = nearest(lon, relief.lon0, relief.lon1, relief.nLon);
    const j = nearest(lat, relief.lat0, relief.lat1, relief.nLat);
    const e = relief.elevation[j * relief.nLon + i];
    if (e === undefined || !Number.isFinite(e)) return NaN;
    // Positive elevation is land; seabed depth is below sea level.
    return e >= 0 ? 0 : -e;
  };

  return {
    grid,
    variable: meta.variable as VariableKey,
    meta,
    relief,
    hasVector: vector !== null,
    coverage: { finite, total: values.length },

    lonAt: (i) => lons[i] ?? lon0,
    latAt: (j) => lats[j] ?? lat0,
    levelIndex: kOf,
    bathymetry: reliefAt,

    value(lon, lat, depth) {
      return at(kOf(depth), jOf(lat), iOf(lon));
    },

    levelTexture(depth) {
      const k = kOf(depth);
      const out = new Float32Array(nx * ny * 4);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const v = at(k, j, i);
          const o = (j * nx + i) * 4;
          const ok = Number.isFinite(v);
          // R is only read where G is set, but NaN in a float texture isn't safe on every
          // driver, so write 0.
          out[o] = ok ? v : 0;
          out[o + 1] = ok ? 1 : 0;
        }
      }
      return out;
    },

    sectionTexture(axis, f) {
      const n = axis === "lon" ? ny : nx;
      const out = new Float32Array(n * nz * 4);
      // The plane is fixed on one axis and sweeps along the other.
      const fixed = axis === "lon" ? iOf(lon0 + (lon1 - lon0) * f) : jOf(lat0 + (lat1 - lat0) * f);
      for (let k = 0; k < nz; k++) {
        for (let s = 0; s < n; s++) {
          const v = axis === "lon" ? at(k, s, fixed) : at(k, fixed, s);
          const o = (k * n + s) * 4;
          const ok = Number.isFinite(v);
          out[o] = ok ? v : 0;
          out[o + 1] = ok ? 1 : 0;
        }
      }
      return { data: out, width: n, height: nz };
    },

    isoDepthField(target) {
      const out = new Float32Array(nx * ny);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          let found = -1;
          let prevV = NaN;
          let prevD = 0;
          for (let k = 0; k < nz; k++) {
            const v = at(k, j, i);
            const d = levels[k]!;
            if (!Number.isFinite(v)) break; // the column ends at the seabed
            if (Number.isFinite(prevV) && (prevV - target) * (v - target) <= 0 && prevV !== v) {
              // Take the shallowest crossing; the value can occur again further down.
              found = prevD + ((target - prevV) / (v - prevV)) * (d - prevD);
              break;
            }
            prevV = v;
            prevD = d;
          }
          out[j * nx + i] = found;
        }
      }
      return out;
    },

    histogram(bins = 48) {
      const counts: number[] = new Array(bins).fill(0);
      let lo = Infinity;
      let hi = -Infinity;
      for (let n = 0; n < values.length; n++) {
        const v = values[n]!;
        if (!Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (lo > hi) return { counts, lo: 0, hi: 1, max: 1 };
      const span = hi - lo || 1;
      for (let n = 0; n < values.length; n++) {
        const v = values[n]!;
        if (!Number.isFinite(v)) continue;
        const b = Math.min(bins - 1, Math.floor(((v - lo) / span) * bins));
        counts[b] = counts[b]! + 1;
      }
      return { counts, lo, hi, max: Math.max(...counts, 1) };
    },

    velocity(lon, lat, depth) {
      if (!vector) return [0, 0];
      const n = kOf(depth) * plane + jOf(lat) * nx + iOf(lon);
      const u = vector.u[n];
      const v = vector.v[n];
      // Both components are NaN when either is missing, so one check is enough.
      // No data means still water.
      return u !== undefined && Number.isFinite(u) && v !== undefined && Number.isFinite(v)
        ? [u, v]
        : [0, 0];
    },
  };
}
