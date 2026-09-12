/**
 * Loading for the chunk view: which tile, which time step, and what to cache.
 *
 * Scrubbing the timeline can ask for dozens of steps in a row, so there's a
 * small LRU of decoded steps, prefetching of neighbouring steps, and a play loop
 * that only advances once a step has loaded.
 *
 * Also snaps clicks to 5 degree tiles (the server does the same, so clients
 * share cache entries).
 */

import { ApiError, api, type ChunkMeta, type ChunkVectorField } from "../../api/client";
import { createChunkSource, type ChunkRelief, type ChunkSource } from "./source";
import type { VariableKey } from "./model";

/** Same as CHUNK_TILE_DEGREES in backend/app/config.py. */
export const TILE_DEGREES = 5;

/** Decoded steps to keep. ~0.6 MB each, ~1.7 MB with currents. */
const CACHE_LIMIT = 8;

/** Steps on each side of the current one to load in the background. */
const PREFETCH_RADIUS = 2;

export type Bbox = [number, number, number, number];

/** Snap a point to the tile grid (same maths as _tile on the server). */
export function snapTile(lon: number, lat: number): Bbox {
  const lon0 = Math.floor(lon / TILE_DEGREES) * TILE_DEGREES;
  const lat0 = Math.floor(lat / TILE_DEGREES) * TILE_DEGREES;
  return [lon0, lat0, lon0 + TILE_DEGREES, lat0 + TILE_DEGREES];
}

export const tileKey = (b: Bbox): string => `${b[0]},${b[1]}`;

/** Tiles exactly ``ring`` steps away from a centre tile, nearest first. */
function ringTiles(centre: Bbox, ring: number): Bbox[] {
  if (ring === 0) return [centre];
  const out: Bbox[] = [];
  for (let dj = -ring; dj <= ring; dj++) {
    for (let di = -ring; di <= ring; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue;
      out.push([
        centre[0] + di * TILE_DEGREES,
        centre[1] + dj * TILE_DEGREES,
        centre[0] + (di + 1) * TILE_DEGREES,
        centre[1] + (dj + 1) * TILE_DEGREES,
      ]);
    }
  }
  // Edge neighbours before diagonals.
  return out.sort((a, b) => {
    const da = Math.abs(a[0] - centre[0]) + Math.abs(a[1] - centre[1]);
    const db = Math.abs(b[0] - centre[0]) + Math.abs(b[1] - centre[1]);
    return da - db;
  });
}

/** Consecutive daily steps centred on a date. */
export function dailyWindow(centre: string, steps: number): string[] {
  const mid = Date.UTC(
    Number(centre.slice(0, 4)),
    Number(centre.slice(5, 7)) - 1,
    Number(centre.slice(8, 10)),
  );
  const half = Math.floor(steps / 2);
  return Array.from({ length: steps }, (_, i) => {
    const d = new Date(mid + (i - half) * 86_400_000);
    return d.toISOString().slice(0, 10);
  });
}

export interface TileResolution {
  bbox: Bbox;
  /** True if the clicked tile had no data and we used a neighbour. */
  moved: boolean;
  meta: ChunkMeta;
}

/**
 * The tile under a click, or the nearest one with data.
 *
 * The server's metadata request returns 404 for tiles with no data, so that's the
 * test. We check up to two rings out (24 tiles).
 */
export async function resolveTile(
  lon: number,
  lat: number,
  variable: VariableKey,
  time: string,
  signal?: AbortSignal,
): Promise<TileResolution> {
  const centre = snapTile(lon, lat);
  for (let ring = 0; ring <= 2; ring++) {
    for (const bbox of ringTiles(centre, ring)) {
      if (bbox[1] < -90 || bbox[3] > 90) continue;
      try {
        const meta = await api.chunkMeta(
          { variable, time, lon_min: bbox[0], lat_min: bbox[1] },
          signal,
        );
        return { bbox, moved: ring > 0, meta };
      } catch (error) {
        if (signal?.aborted) throw error;
        // 404 just means no data. Other errors shouldn't be retried 24 times.
        if (error instanceof ApiError && error.status === 404) continue;
        throw error;
      }
    }
  }
  throw new ApiError(
    "No ocean model data within two chunks of that point. Try somewhere further out to sea.",
    404,
  );
}

const sourceKey = (bbox: Bbox, variable: string, time: string): string =>
  `${tileKey(bbox)}|${variable}|${time}`;

/**
 * Decoded chunks. The seabed is cached per tile, not per step, since it's the
 * same every day.
 */
export class ChunkStore {
  private readonly sources = new Map<string, ChunkSource>();
  private readonly reliefs = new Map<string, ChunkRelief | null>();
  private readonly inflight = new Map<string, Promise<ChunkSource>>();
  private readonly vectors = new Map<string, Promise<ChunkVectorField | null>>();
  /**
   * Steps the upstream can't serve, so we don't keep asking. APDRC consistently
   * returns HTTP 500 for some HYCOM steps. The timeline marks these days.
   */
  private readonly broken = new Map<string, string>();
  /** Background loads run one at a time (see prefetch). */
  private queue: Promise<unknown> = Promise.resolve();

  peek(bbox: Bbox, variable: string, time: string): ChunkSource | undefined {
    const key = sourceKey(bbox, variable, time);
    const hit = this.sources.get(key);
    if (hit) {
      // Re-insert so Map order tracks recency.
      this.sources.delete(key);
      this.sources.set(key, hit);
    }
    return hit;
  }

  private async relief(bbox: Bbox): Promise<ChunkRelief | null> {
    const key = tileKey(bbox);
    const cached = this.reliefs.get(key);
    if (cached !== undefined) return cached;
    try {
      const meta = await api.terrainMeta({
        lon_min: bbox[0],
        lat_min: bbox[1],
        lon_max: bbox[2],
        lat_max: bbox[3],
      });
      const elevation = await api.terrainData(meta);
      const value: ChunkRelief = {
        elevation,
        nLat: meta.shape[0],
        nLon: meta.shape[1],
        lat0: meta.lat_range[0],
        lat1: meta.lat_range[1],
        lon0: meta.lon_range[0],
        lon1: meta.lon_range[1],
        minElevation: meta.min_elevation,
        maxElevation: meta.max_elevation,
      };
      this.reliefs.set(key, value);
      return value;
    } catch {
      // The seabed is optional; without it the bathymetry layer says so and the field
      // still draws.
      this.reliefs.set(key, null);
      return null;
    }
  }

  /**
   * Fetch a step, or join a fetch that's already running.
   *
   * No AbortSignal on purpose: the promise is shared, so one caller's abort would
   * kill it for everyone (StrictMode's unmount/remount did exactly this and the
   * chunk never loaded). The result is cached anyway. Callers check their own
   * signal after awaiting.
   */
  /**
   * The tile's currents for one step. Keyed on tile and time only, so the current
   * traces stay when you switch the colour variable.
   */
  private vector(bbox: Bbox, time: string): Promise<ChunkVectorField | null> {
    const key = `${tileKey(bbox)}|${time}`;
    const running = this.vectors.get(key);
    if (running) return running;
    const task = (async () => {
      try {
        const meta = await api.chunkMeta({
          variable: "speed",
          time,
          lon_min: bbox[0],
          lat_min: bbox[1],
        });
        if (!meta.vector_url) return null;
        return await api.chunkVector(meta);
      } catch {
        // Forget failed attempts so a temporary error doesn't lose currents for the
        // whole session (unlike broken scalar steps, which are permanent).
        this.vectors.delete(key);
        return null;
      }
    })();
    this.vectors.set(key, task);
    return task;
  }

  load(bbox: Bbox, variable: VariableKey, time: string): Promise<ChunkSource> {
    const key = sourceKey(bbox, variable, time);
    const ready = this.peek(bbox, variable, time);
    if (ready) return Promise.resolve(ready);
    const known = this.broken.get(key);
    if (known) return Promise.reject(new ApiError(known, 502));
    const running = this.inflight.get(key);
    if (running) return running;

    const task = (async () => {
      const meta = await api.chunkMeta({ variable, time, lon_min: bbox[0], lat_min: bbox[1] });
      // Seabed and currents load in parallel with the field.
      const [values, relief, vector] = await Promise.all([
        api.chunkData(meta),
        this.relief(bbox),
        this.vector(bbox, time),
      ]);
      const source = createChunkSource({ meta, values, vector, relief });
      this.sources.set(key, source);
      while (this.sources.size > CACHE_LIMIT) {
        const oldest = this.sources.keys().next().value;
        if (oldest === undefined) break;
        this.sources.delete(oldest);
      }
      return source;
    })();

    this.inflight.set(key, task);
    task.catch((error: unknown) => {
      // 5xx means the upstream can't build this step; 404 means no data. Both are
      // permanent. Other errors can be retried.
      if (error instanceof ApiError && error.status >= 404) {
        this.broken.set(key, error.message);
      }
    }).finally(() => this.inflight.delete(key));
    return task;
  }

  /** Load the steps around the current one in the background. Errors are ignored. */
  prefetch(bbox: Bbox, variable: VariableKey, times: string[], index: number): void {
    for (let d = 1; d <= PREFETCH_RADIUS; d++) {
      for (const i of [index + d, index - d]) {
        const time = times[i];
        if (time === undefined) continue;
        if (this.peek(bbox, variable, time)) continue;
        if (this.broken.has(sourceKey(bbox, variable, time))) continue;
        // One at a time: APDRC throttles parallel requests and returned 503 when we
        // fired four at once.
        this.queue = this.queue.then(() =>
          this.peek(bbox, variable, time)
            ? undefined
            : this.load(bbox, variable, time).then(
                () => undefined,
                () => undefined,
              ),
        );
      }
    }
  }

  /** Whether a step is ready to draw. Playback waits on this. */
  has(bbox: Bbox, variable: string, time: string): boolean {
    return this.sources.has(sourceKey(bbox, variable, time));
  }

  /** Why a step can't be drawn, if we already know. */
  brokenReason(bbox: Bbox, variable: string, time: string): string | undefined {
    return this.broken.get(sourceKey(bbox, variable, time));
  }

  isBroken(bbox: Bbox, variable: string, time: string): boolean {
    return this.broken.has(sourceKey(bbox, variable, time));
  }
}
