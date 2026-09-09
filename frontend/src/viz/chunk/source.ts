/**
 * The chunk view's data seam.
 *
 * Everything the viewport draws reads through a `ChunkSource`. Until now that
 * was `model.ts`, a pure analytic ocean; this is the same surface backed by the
 * real thing — one HYCOM sub-volume, one ETOPO relief tile, one set of Argo
 * casts, all fetched by `loader.ts` and frozen into the object below.
 *
 * Two properties are deliberate and load-bearing:
 *
 * **A source is one variable at one instant.** There is no `t` parameter and no
 * `name` parameter anywhere in it. A different timestep or a different variable
 * is a different fetch and therefore a different source object, so the question
 * "which moment am I looking at" has exactly one answer at any time and cannot
 * be answered differently by two layers in the same frame.
 *
 * **The field's own NaN is the water mask.** Sub-seabed and land cells arrive
 * absent from the upstream, and that absence is what the shader discards on.
 * The ETOPO relief is used only to *draw* the seabed — never to decide where the
 * field stops. Letting relief clip the field would carve one dataset's coastline
 * out of another's, which context.md §10 (2026-09-01) already settled the other
 * way for the water column.
 *
 * Sampling is nearest-neighbour, matching the convention in `erddap_grid.py`,
 * `map/raster.ts` and `map/state.ts`. The grid is 0.08 degrees; interpolating it
 * would imply a precision the analysis does not have.
 */

import type { ChunkMeta, ChunkVectorField } from "../../api/client";
import type { VariableKey } from "./model";

export interface ChunkGrid {
  /** Longitude cells. */
  nx: number;
  /** Latitude cells. */
  ny: number;
  /** Depth levels. 1 for a surface variable. */
  nz: number;
  lon0: number;
  lon1: number;
  lat0: number;
  lat1: number;
  /** Deepest level actually present, in metres. */
  maxDepth: number;
  /** The upstream's real levels, ascending. Never a computed curve. */
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

/** ETOPO relief for one tile. Positive elevation is land. */
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
 * One surfacing of one platform.
 *
 * An Argo float reports its position when it comes up, roughly every ten days.
 * What it did in between is not measured, so nothing here describes it — the
 * dive path the synthetic model used to draw was invented, and CONTRIBUTING §8
 * rules that out.
 */
export interface ChunkFix {
  cycle: number | null;
  time: string;
  /** Nearest step in the loaded window. Resolved once, where the times are known. */
  step: number;
  lon: number;
  lat: number;
  /** How deep this cast actually reached. */
  maxDepth: number | null;
  nLevels: number;
  surfaceTemperature: number | null;
}

export interface ChunkPlatform {
  id: string;
  /** "argo_float" today. The seam is here for the gliders §2 still owes. */
  type: string;
  /** Ordered in time. Two or more of these make a track. */
  fixes: ChunkFix[];
}

export interface ChunkSource {
  readonly grid: ChunkGrid;
  readonly variable: VariableKey;
  readonly meta: ChunkMeta;
  readonly relief: ChunkRelief | null;
  readonly hasVector: boolean;
  /** How much of the chunk the upstream actually covered, for the readout. */
  readonly coverage: { finite: number; total: number };

  lonAt(i: number): number;
  latAt(j: number): number;
  /** Nearest real level to a depth in metres, as an index into `grid.levels`. */
  levelIndex(depth: number): number;
  /** Seabed depth in metres, from the relief. NaN when no relief is loaded. */
  bathymetry(lon: number, lat: number): number;
  /** NaN where the analysis has no value here. */
  value(lon: number, lat: number, depth: number): number;
  /** RGBA payload for a constant-depth slice: R = value, G = 1 inside the data. */
  levelTexture(depth: number): Float32Array;
  sectionTexture(axis: "lon" | "lat", f: number): SectionPayload;
  /** Depth of an iso-value per column; -1 where it does not occur. */
  isoDepthField(target: number): Float32Array;
  histogram(bins?: number): Histogram;
  /** Horizontal velocity in m/s. [0, 0] where there is no vector field. */
  velocity(lon: number, lat: number, depth: number): [number, number];
}

export interface ChunkPayload {
  meta: ChunkMeta;
  values: Float32Array;
  vector: ChunkVectorField | null;
  relief: ChunkRelief | null;
}

/** Nearest index on an evenly-spaced axis, clamped to its ends. */
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

  // The axes the upstream returned, not the tile we asked for: HYCOM's cells are
  // centred, so a 85-90 request comes back spanning 85.04-90.0. Drawing against
  // the requested box instead would shift the whole chunk by half a cell.
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
    // Levels are non-uniform (0, 2, 4 ... 1500, 2000), so this is a real search
    // rather than the arithmetic the evenly-spaced lat/lon axes allow.
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
    // Positive elevation is land; the seabed is the depth below sea level.
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
          // R is only read where G passes, but a NaN in a float texture is not
          // safely ignorable on every driver — write a real number regardless.
          out[o] = ok ? v : 0;
          out[o + 1] = ok ? 1 : 0;
        }
      }
      return out;
    },

    sectionTexture(axis, f) {
      const n = axis === "lon" ? ny : nx;
      const out = new Float32Array(n * nz * 4);
      // The plane is fixed on one axis and swept along the other.
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
              // The shallowest crossing wins: below it the same value may recur,
              // and the surface a forecaster means is the first one.
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
      // A missing component is masked to NaN upstream for both, so one check
      // covers the pair. Still water is the honest answer where there is none.
      return u !== undefined && Number.isFinite(u) && v !== undefined && Number.isFinite(v)
        ? [u, v]
        : [0, 0];
    },
  };
}
