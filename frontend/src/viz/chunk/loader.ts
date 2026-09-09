/**
 * Fetching for the chunk view: which tile, which step, and what to keep.
 *
 * The chunk view asks for one variable at one instant at a time, but a person
 * scrubbing a timeline asks for thirty in a row. This module is what makes that
 * feel like one dataset rather than thirty requests: a small LRU of decoded
 * sources, a prefetch of the neighbouring steps, and a play loop that advances
 * only as steps actually land.
 *
 * It also owns tile resolution. A click on the globe is a point; a chunk is a
 * 5-degree tile. Snapping happens here and on the server both, so two clients
 * cannot ask two different questions about the same click and cache two answers.
 */

import { ApiError, api, type ChunkMeta, type ChunkVectorField } from "../../api/client";
import { createChunkSource, type ChunkRelief, type ChunkSource } from "./source";
import type { VariableKey } from "./model";

/** Mirrors CHUNK_TILE_DEGREES in backend/app/config.py. If that moves, this moves. */
export const TILE_DEGREES = 5;

/** How many decoded steps to keep. Each is ~0.6 MB, or ~1.7 MB with currents. */
const CACHE_LIMIT = 8;

/** Steps either side of the cursor to warm in the background. */
const PREFETCH_RADIUS = 2;

export type Bbox = [number, number, number, number];

/** Floor a point onto the tile grid. The same arithmetic as `_tile` on the server. */
export function snapTile(lon: number, lat: number): Bbox {
  const lon0 = Math.floor(lon / TILE_DEGREES) * TILE_DEGREES;
  const lat0 = Math.floor(lat / TILE_DEGREES) * TILE_DEGREES;
  return [lon0, lat0, lon0 + TILE_DEGREES, lat0 + TILE_DEGREES];
}

export const tileKey = (b: Bbox): string => `${b[0]},${b[1]}`;

/** Tiles at exactly `ring` steps from a centre tile, nearest edge first. */
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
  // Straight neighbours before diagonals, so "nearest" means nearest.
  return out.sort((a, b) => {
    const da = Math.abs(a[0] - centre[0]) + Math.abs(a[1] - centre[1]);
    const db = Math.abs(b[0] - centre[0]) + Math.abs(b[1] - centre[1]);
    return da - db;
  });
}

/** A window of consecutive daily steps centred on a date. */
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
  /** True when the click's own tile had no coverage and we moved outward. */
  moved: boolean;
  meta: ChunkMeta;
}

/**
 * The tile under a click, or the nearest one that actually holds data.
 *
 * The coverage test is the metadata request itself: the server answers 404 when
 * a tile has nothing finite in it, which is exactly the question being asked.
 * Two rings is 24 candidates — far enough to step off a coastline, close enough
 * that "nearest" still means something to the person who clicked.
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
        // 404 is the coverage answer, not a failure. Anything else — the
        // upstream being down, a bad shape — must not be silently retried
        // twenty-four times.
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
 * Decoded chunks, kept for as long as they are worth keeping.
 *
 * Relief is cached per tile rather than per step: it is the same seabed on every
 * day of the window, and re-fetching it thirty times would be the single most
 * wasteful thing this view could do.
 */
export class ChunkStore {
  private readonly sources = new Map<string, ChunkSource>();
  private readonly reliefs = new Map<string, ChunkRelief | null>();
  private readonly inflight = new Map<string, Promise<ChunkSource>>();
  private readonly vectors = new Map<string, Promise<ChunkVectorField | null>>();
  /**
   * Steps the upstream cannot serve, so we stop asking.
   *
   * APDRC answers HTTP 500 for a depth *range* on some HYCOM steps while
   * serving the same step's surface perfectly — broken blocks in their
   * aggregation, not a transient fault: it reproduces on every retry. Recording
   * them keeps the prefetch from hammering a request that will never succeed,
   * and lets the timeline mark the days that have no volume.
   */
  private readonly broken = new Map<string, string>();
  /** Background warms run one at a time — see `prefetch`. */
  private queue: Promise<unknown> = Promise.resolve();

  peek(bbox: Bbox, variable: string, time: string): ChunkSource | undefined {
    const key = sourceKey(bbox, variable, time);
    const hit = this.sources.get(key);
    if (hit) {
      // Re-insert so the Map's insertion order is a real recency order.
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
      // The relief is context, not the subject — the same call the water column
      // already makes. Without it the bathymetry layer says so and the field
      // still draws, because the field's own mask never depended on it.
      this.reliefs.set(key, null);
      return null;
    }
  }

  /**
   * Fetch a step, or join the fetch already running for it.
   *
   * Deliberately takes no AbortSignal. A shared promise cannot be bound to one
   * caller's lifetime: the first version of this passed the caller's signal
   * into the task, so a component that unmounted mid-flight — which React's
   * StrictMode guarantees on every mount — aborted the request AND left the
   * dead promise in `inflight` for the remount to join, so the chunk never
   * loaded at all and nothing retried.
   *
   * Running to completion is not waste here either: the result is cached, and
   * the step a caller just abandoned is usually the one it asks for next.
   * Callers that no longer want it check their own signal after awaiting.
   */
  /**
   * The tile's currents at one step, whichever scalar is being displayed.
   *
   * Deliberately keyed on tile and time alone. The currents layer is
   * independent of the variable in the colour ramp — a forecaster looking at
   * salinity still wants to see the flow through it — so binding the vector to
   * the displayed variable would make the traces vanish on every switch away
   * from current speed.
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
        // No direction available is a state the currents layer already handles:
        // it withdraws rather than freezing, and the panel says why. Forget the
        // attempt so a transient upstream failure does not cost this step its
        // currents for the rest of the session — unlike a broken scalar step,
        // which is permanent and recorded as such.
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
      // The relief and the currents run alongside rather than after: three
      // different upstreams, none waiting on the others.
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
      // A 5xx names a step the upstream cannot build. A 404 is a tile with no
      // coverage, which is equally permanent for this request. Anything else —
      // a dropped connection, the backend restarting — stays retryable.
      if (error instanceof ApiError && error.status >= 404) {
        this.broken.set(key, error.message);
      }
    }).finally(() => this.inflight.delete(key));
    return task;
  }

  /**
   * Warm the steps either side of the cursor.
   *
   * Fire-and-forget: failures are ignored, because this is an optimisation and
   * the real load reports anything that matters.
   */
  prefetch(bbox: Bbox, variable: VariableKey, times: string[], index: number): void {
    for (let d = 1; d <= PREFETCH_RADIUS; d++) {
      for (const i of [index + d, index - d]) {
        const time = times[i];
        if (time === undefined) continue;
        if (this.peek(bbox, variable, time)) continue;
        if (this.broken.has(sourceKey(bbox, variable, time))) continue;
        // One at a time. Firing all four at once made APDRC answer 503 to three
        // of them: the upstream throttles concurrent griddap requests, and a
        // prefetch storm is exactly what looks like abuse from the outside.
        // A serial queue warms the neighbours just as well and never competes
        // with the step the reader is actually waiting for.
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

  /** Whether a step can be drawn without waiting. Play advances on this. */
  has(bbox: Bbox, variable: string, time: string): boolean {
    return this.sources.has(sourceKey(bbox, variable, time));
  }

  /** Why a step cannot be drawn at all, if we have already found out. */
  brokenReason(bbox: Bbox, variable: string, time: string): string | undefined {
    return this.broken.get(sourceKey(bbox, variable, time));
  }

  isBroken(bbox: Bbox, variable: string, time: string): boolean {
    return this.broken.has(sourceKey(bbox, variable, time));
  }
}
