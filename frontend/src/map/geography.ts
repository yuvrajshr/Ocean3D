/**
 * Coastlines and national borders.
 *
 * These are the only lines on the map that are not measured. They are reference
 * geography — the thing that lets a reader say "that warm tongue is off Somalia"
 * rather than "that warm tongue is somewhere". context.md §5.1 Principle 7 bars
 * *decoration* on a data surface, not orientation; a coastline is the same class
 * of mark as the graticule, which the map already draws.
 *
 * They are strokes only. The filled land still comes from the data's own no-data
 * mask (§10), so a coastline can never hide an ocean pixel or invent one: the
 * mask governs what is true, these lines govern what is legible. Where the two
 * disagree by a fraction of a cell, the fill wins and the line sits just inside
 * or outside it — visible only when zoomed well in.
 *
 * Natural Earth, public domain, bundled in `public/` by
 * `scripts/fetch-geography.mjs` because the deployment target cannot call out.
 */

import type { MapTransform } from "./projection";

export interface Geography {
  /** Each line is a flat [lon, lat, lon, lat, ...] array. */
  coast: number[][];
  borders: number[][];
}

export type GeographyScale = "110m" | "50m";

const cache = new Map<GeographyScale, Geography>();
const inflight = new Map<GeographyScale, Promise<Geography | null>>();

/**
 * Which level of detail the current zoom can actually resolve.
 *
 * 110m is right until a coastline starts looking angular; past that the extra
 * 1.1 MB buys real detail. Below the threshold it would just be more segments
 * than the screen has pixels to show.
 */
export function scaleFor(zoom: number, worldFitZoom: number): GeographyScale {
  return zoom > worldFitZoom * 2.5 ? "50m" : "110m";
}

export async function loadGeography(scale: GeographyScale): Promise<Geography | null> {
  const hit = cache.get(scale);
  if (hit) return hit;
  const pending = inflight.get(scale);
  if (pending) return pending;

  const task = (async () => {
    try {
      const res = await fetch(`/geography-${scale}.json`);
      if (!res.ok) return null;
      const geo = (await res.json()) as Geography;
      cache.set(scale, geo);
      return geo;
    } catch {
      // The map is entirely usable without it; the field is the subject.
      return null;
    } finally {
      inflight.delete(scale);
    }
  })();
  inflight.set(scale, task);
  return task;
}

function strokeLines(
  ctx: CanvasRenderingContext2D,
  lines: number[][],
  t: MapTransform,
  shift: number,
): void {
  const { width, height } = ctx.canvas;
  // A line that jumps most of the frame in one step has crossed the
  // antimeridian; drawing it would put a stripe straight across the map.
  const tear = width * 0.5;

  for (const line of lines) {
    let pen = false;
    let prevX = 0;
    for (let i = 0; i < line.length; i += 2) {
      const x = t.lonToX(line[i]! + shift);
      const y = t.latToY(line[i + 1]!);

      // Cheap reject: both this point and the last off the same edge.
      const outside = x < -40 || x > width + 40 || y < -40 || y > height + 40;
      if (outside && (!pen || (prevX < -40 && x < -40) || (prevX > width + 40 && x > width + 40))) {
        pen = false;
        prevX = x;
        continue;
      }
      if (pen && Math.abs(x - prevX) > tear) {
        pen = false;
      }
      if (pen) {
        ctx.lineTo(x, y);
      } else {
        ctx.moveTo(x, y);
        pen = true;
      }
      prevX = x;
    }
  }
}

export interface GeographyStyle {
  /** Coastline: the boundary between the field and the land it stops at. */
  coast: string;
  /**
   * A dark sheath drawn under the coastline, one step wider.
   *
   * This is §5.1 Principle 8's casing, inverted. There the problem was a dark
   * data mark lost against dark water, so the casing was `foam`. Here it is a
   * light line lost against the bright end of a cmocean ramp — the tropics are
   * near-yellow, and a 46% white stroke disappears into them while reading
   * perfectly against the poles. A dark sheath separates the line from bright
   * ocean; the light core separates it from near-black land. Together they hold
   * on every background the field can produce.
   *
   * The casing encodes nothing, and it never tints the field: it is drawn on the
   * basemap canvas, under the data, not over it.
   */
  coastCasing: string;
  /** National borders: fainter, so they never compete with the coast. */
  border: string;
  coastWidth: number;
  borderWidth: number;
}

export function drawGeography(
  ctx: CanvasRenderingContext2D,
  geo: Geography,
  t: MapTransform,
  style: GeographyStyle,
): void {
  // The world repeats every 360 degrees, so each set is drawn three times; the
  // copies that fall outside the frame are rejected per-point above.
  const shifts = t.showsWholeWorld() ? [0] : [-360, 0, 360];

  // Borders first, so a coastline is never overdrawn by a boundary that runs
  // along it — many national borders follow rivers to the sea.
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  ctx.beginPath();
  for (const shift of shifts) strokeLines(ctx, geo.borders, t, shift);
  ctx.strokeStyle = style.border;
  ctx.lineWidth = style.borderWidth;
  ctx.setLineDash([4, 3.5]);
  ctx.stroke();

  // The coast is stroked twice over one path: casing first, then core.
  ctx.beginPath();
  for (const shift of shifts) strokeLines(ctx, geo.coast, t, shift);
  ctx.setLineDash([]);
  ctx.strokeStyle = style.coastCasing;
  ctx.lineWidth = style.coastWidth + 1.8;
  ctx.stroke();
  ctx.strokeStyle = style.coast;
  ctx.lineWidth = style.coastWidth;
  ctx.stroke();

  ctx.restore();
}
