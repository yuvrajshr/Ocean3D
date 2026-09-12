/**
 * Equirectangular (plate carrée) projection with pan and zoom.
 *
 * No DOM or canvas here. Every dataset on the map is a regular lat/lon grid, and
 * plate carrée maps that linearly to pixels, so a data row is a pixel row. It's
 * the same projection viz/geo.ts uses, just in screen pixels.
 */

/** Degrees of longitude in the whole world. */
const WORLD_LON = 360;
/** Latitude is clamped, not wrapped. */
export const LAT_LIMIT = 90;

export interface Viewport {
  /** Longitude at the canvas centre, in [-180, 180). */
  lonCentre: number;
  /** Latitude at the canvas centre. */
  latCentre: number;
  /** CSS pixels per degree, the same on both axes. */
  zoom: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Wrap a longitude into [-180, 180). */
export function wrapLon(lon: number): number {
  const x = ((lon + 180) % WORLD_LON + WORLD_LON) % WORLD_LON;
  return x - 180;
}

/**
 * Zoom at which the world just covers the canvas.
 *
 * Uses max, not min: longitude is clamped now, so fitting the world inside a
 * wide canvas would leave empty bands on the sides. Covering crops the poles a
 * bit instead, and you can still pan to them.
 */
export function worldFitZoom(size: Size): number {
  return Math.max(size.width / WORLD_LON, size.height / (2 * LAT_LIMIT));
}

export function clampViewport(v: Viewport, size: Size): Viewport {
  const minZoom = worldFitZoom(size);
  const zoom = Math.max(minZoom, Math.min(minZoom * 512, v.zoom));

  // Stop vertical panning when the poles reach the edge; centre if it all fits.
  const halfLat = size.height / 2 / zoom;
  const latCentre =
    halfLat >= LAT_LIMIT ? 0 : Math.max(-LAT_LIMIT + halfLat, Math.min(LAT_LIMIT - halfLat, v.latCentre));

  // Longitude is clamped like latitude, not wrapped. Wrapping let the map scroll
  // sideways forever for no benefit. The downside is the Pacific stays split
  // between the left and right edges.
  const halfLon = size.width / 2 / zoom;
  const lonCentre =
    halfLon >= WORLD_LON / 2
      ? 0
      : Math.max(-WORLD_LON / 2 + halfLon, Math.min(WORLD_LON / 2 - halfLon, v.lonCentre));

  return { lonCentre, latCentre, zoom };
}

export class MapTransform {
  readonly viewport: Viewport;
  readonly size: Size;

  constructor(viewport: Viewport, size: Size) {
    this.viewport = clampViewport(viewport, size);
    this.size = size;
  }

  /**
   * Longitude to canvas x. Not wrapped; use lonToXNearest for the nearest copy
   * across the antimeridian.
   */
  lonToX(lon: number): number {
    return this.size.width / 2 + (lon - this.viewport.lonCentre) * this.viewport.zoom;
  }

  /** Latitude to canvas y. North is up. */
  latToY(lat: number): number {
    return this.size.height / 2 - (lat - this.viewport.latCentre) * this.viewport.zoom;
  }

  xToLon(x: number): number {
    return this.viewport.lonCentre + (x - this.size.width / 2) / this.viewport.zoom;
  }

  yToLat(y: number): number {
    return this.viewport.latCentre - (y - this.size.height / 2) / this.viewport.zoom;
  }

  /**
   * x for the copy of ``lon`` nearest the centre. Without it, a feature at 179E
   * disappears when the view is centred at 179W.
   */
  lonToXNearest(lon: number): number {
    const delta = wrapLon(lon - this.viewport.lonCentre);
    return this.size.width / 2 + delta * this.viewport.zoom;
  }

  /** Visible lat/lon window, latitude clamped to the poles. */
  bounds(): { latRange: [number, number]; lonRange: [number, number] } {
    const halfLon = this.size.width / 2 / this.viewport.zoom;
    const halfLat = this.size.height / 2 / this.viewport.zoom;
    return {
      latRange: [
        Math.max(-LAT_LIMIT, this.viewport.latCentre - halfLat),
        Math.min(LAT_LIMIT, this.viewport.latCentre + halfLat),
      ],
      lonRange: [this.viewport.lonCentre - halfLon, this.viewport.lonCentre + halfLon],
    };
  }

  /** True when the whole world's longitude is visible. */
  showsWholeWorld(): boolean {
    return this.size.width / this.viewport.zoom >= WORLD_LON;
  }

  /** Zoom around a screen point, keeping the spot under the cursor in place. */
  zoomAbout(x: number, y: number, factor: number): MapTransform {
    const lon = this.xToLon(x);
    const lat = this.yToLat(y);
    const zoom = this.viewport.zoom * factor;
    const next = clampViewport({ ...this.viewport, zoom }, this.size);
    const after = new MapTransform(next, this.size);
    // Re-centre so (lon, lat) is back under (x, y).
    return new MapTransform(
      {
        ...next,
        lonCentre: next.lonCentre + (lon - after.xToLon(x)),
        latCentre: next.latCentre + (lat - after.yToLat(y)),
      },
      this.size,
    );
  }

  panBy(dx: number, dy: number): MapTransform {
    return new MapTransform(
      {
        ...this.viewport,
        lonCentre: this.viewport.lonCentre - dx / this.viewport.zoom,
        latCentre: this.viewport.latCentre + dy / this.viewport.zoom,
      },
      this.size,
    );
  }
}

/** Graticule spacing snaps to round values instead of changing smoothly. */
const GRATICULE_STEPS = [30, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1];

export function graticuleStep(zoom: number, targetPx = 110): number {
  const wanted = targetPx / zoom;
  for (const step of GRATICULE_STEPS) {
    if (step <= wanted) return step;
  }
  return GRATICULE_STEPS[GRATICULE_STEPS.length - 1]!;
}

/** Format a lat/lon like a chart label. */
export function formatLat(lat: number, step = 1): string {
  const digits = step < 1 ? 1 : 0;
  if (Math.abs(lat) < 1e-9) return "0°";
  return `${Math.abs(lat).toFixed(digits)}°${lat > 0 ? "N" : "S"}`;
}

export function formatLon(lon: number, step = 1): string {
  const digits = step < 1 ? 1 : 0;
  const wrapped = wrapLon(lon);
  if (Math.abs(wrapped) < 1e-9) return "0°";
  if (Math.abs(Math.abs(wrapped) - 180) < 1e-9) return "180°";
  return `${Math.abs(wrapped).toFixed(digits)}°${wrapped > 0 ? "E" : "W"}`;
}
