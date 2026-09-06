/**
 * Equirectangular (plate carrée) projection with pan and zoom.
 *
 * Pure geometry — no DOM, no canvas, no React. Every upstream this map draws is
 * a regular lat/lon grid, and plate carrée maps such a grid to pixels with a
 * linear scale on both axes, so a data row is a pixel row. That is the whole
 * reason the raster path can be a memcpy-shaped loop instead of a resampler.
 *
 * `viz/geo.ts` already does the same thing for the 3D scene (`x(lon)`, `z(lat)`
 * are a plate carrée pair). This is not a second projection, it is the same one
 * expressed in screen pixels rather than world units.
 */

/** Degrees of longitude spanned by the whole world. */
const WORLD_LON = 360;
/** Latitude is clamped rather than wrapped: there is no pole to pan past. */
export const LAT_LIMIT = 90;

export interface Viewport {
  /** Longitude at the centre of the canvas, in [-180, 180). */
  lonCentre: number;
  /** Latitude at the centre of the canvas. */
  latCentre: number;
  /** CSS pixels per degree. Equal on both axes — that is what makes it plate carrée. */
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

/** The zoom at which the world just COVERS the canvas — never smaller than it.
 *
 * `max`, not `min`. Fitting the world *inside* the frame was only safe while
 * longitude wrapped: on a canvas wider than 2:1 the world is narrower than the
 * frame at that zoom, and the repeated copies filled what was left over. Now
 * that longitude is clamped (see `clampViewport`) nothing fills it, so fitting
 * would leave real empty bands either side. Covering crops the far polar caps
 * instead on such a canvas, and vertical panning still reaches them. */
export function worldFitZoom(size: Size): number {
  return Math.max(size.width / WORLD_LON, size.height / (2 * LAT_LIMIT));
}

export function clampViewport(v: Viewport, size: Size): Viewport {
  const minZoom = worldFitZoom(size);
  const zoom = Math.max(minZoom, Math.min(minZoom * 512, v.zoom));

  // Vertical panning stops where the poles reach the frame edge, so the map
  // never floats in empty space. When the whole height fits, it stays centred.
  const halfLat = size.height / 2 / zoom;
  const latCentre =
    halfLat >= LAT_LIMIT ? 0 : Math.max(-LAT_LIMIT + halfLat, Math.min(LAT_LIMIT - halfLat, v.latCentre));

  // Longitude is clamped exactly like latitude, NOT wrapped. Wrapping let the
  // map slide sideways for ever, redrawing the same ocean past the date line;
  // at world zoom that moved the seam around the frame and bought nothing,
  // because every degree was already on screen.
  //
  // The cost is stated rather than hidden: the antimeridian can no longer be
  // brought to the centre, so the Pacific stays split between the left and
  // right edges. That is the honest trade for an Earth that ends where it
  // really ends.
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

  /** Longitude to canvas x. Not wrapped — callers that need the nearest copy of
   *  a feature across the antimeridian use `lonToXNearest`. */
  lonToX(lon: number): number {
    return this.size.width / 2 + (lon - this.viewport.lonCentre) * this.viewport.zoom;
  }

  /** Latitude to canvas y. North is up, so y decreases as latitude increases. */
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
   * x for the copy of `lon` nearest the centre of the frame.
   *
   * The world repeats every 360 degrees. Without this a feature at 179E vanishes
   * when the view is centred at 179W, even though it is one pixel away.
   */
  lonToXNearest(lon: number): number {
    const delta = wrapLon(lon - this.viewport.lonCentre);
    return this.size.width / 2 + delta * this.viewport.zoom;
  }

  /** The geographic window currently visible, latitude clamped to the poles. */
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

  /** True when the visible longitude span covers the whole world. */
  showsWholeWorld(): boolean {
    return this.size.width / this.viewport.zoom >= WORLD_LON;
  }

  /** Zoom about a fixed screen point, so the geography under the cursor stays put. */
  zoomAbout(x: number, y: number, factor: number): MapTransform {
    const lon = this.xToLon(x);
    const lat = this.yToLat(y);
    const zoom = this.viewport.zoom * factor;
    const next = clampViewport({ ...this.viewport, zoom }, this.size);
    const after = new MapTransform(next, this.size);
    // Re-centre so (lon, lat) lands back under (x, y).
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

/** Graticule spacing that steps at real breakpoints rather than sliding.
 *
 *  A grid whose spacing changes continuously is a texture; one that holds a
 *  round interval until it must change is a ruler. §5.1 makes the same argument
 *  for the depth ruler and the colorbar. */
const GRATICULE_STEPS = [30, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1];

export function graticuleStep(zoom: number, targetPx = 110): number {
  const wanted = targetPx / zoom;
  for (const step of GRATICULE_STEPS) {
    if (step <= wanted) return step;
  }
  return GRATICULE_STEPS[GRATICULE_STEPS.length - 1]!;
}

/** Format a latitude or longitude the way a chart labels it. */
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
