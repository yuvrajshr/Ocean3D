/**
 * Coastlines and national borders.
 *
 * Only for orientation (so you can say "that warm patch is off Somalia"). They're
 * strokes only; the land fill still comes from the data's no-data mask, so a
 * coastline can never hide or invent an ocean cell.
 *
 * Natural Earth (public domain), bundled in public/ by scripts/fetch-geography.mjs.
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
 * Level of detail for the current zoom: 110m until coastlines start looking
 * angular, then 50m.
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
      // The map works fine without it.
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
  // Use CSS pixels from the transform, not ctx.canvas.width (device pixels). The
  // context is scaled by devicePixelRatio, so mixing them broke the antimeridian
  // check on HiDPI screens and coastlines drew straight across the map.
  const { width, height } = t.size;
  // A jump across most of the frame means it crossed the antimeridian; don't draw it.
  const tear = width * 0.5;

  for (const line of lines) {
    let pen = false;
    let prevX = 0;
    for (let i = 0; i < line.length; i += 2) {
      const x = t.lonToX(line[i]! + shift);
      const y = t.latToY(line[i + 1]!);

      // Skip segments where both points are off the same edge.
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
  /** Coastline colour. */
  coast: string;
  /**
   * Dark casing drawn under the coastline, a bit wider. A light line alone vanishes
   * against the bright (tropical) end of a colormap; with the casing it shows on
   * any background. Drawn on the basemap canvas, under the data.
   */
  coastCasing: string;
  /** National borders, fainter than the coast. */
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
  // Draw each set three times (±360) for the wrapped world; off-screen copies are
  // skipped above.
  const shifts = t.showsWholeWorld() ? [0] : [-360, 0, 360];

  // Borders first so they don't draw over coastlines (many follow rivers to the sea).
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  ctx.beginPath();
  for (const shift of shifts) strokeLines(ctx, geo.borders, t, shift);
  ctx.strokeStyle = style.border;
  ctx.lineWidth = style.borderWidth;
  ctx.setLineDash([4, 3.5]);
  ctx.stroke();

  // Stroke the coast twice: casing, then core.
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
