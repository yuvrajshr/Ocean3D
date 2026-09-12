import { depthToNormUnclamped } from "./depth";

/**
 * Geographic-to-world mapping shared by everything in the scene (terrain, sea,
 * volume, markers, depth ruler), so they all agree on where a lat/lon/depth is.
 *
 * The vertical scale is heavily exaggerated: the box is ~2,750 km wide but only
 * 5.5 km deep. The depth ruler always shows real metres.
 */

/** Depth where the ruler and the analysis end. */
export const ANALYSIS_MAX_DEPTH = 2000;

/**
 * World height for the 0-2000 m analysis span (~425x exaggeration).
 *
 * Higher made the seafloor look like a canyon; lower flattened the column so the
 * thermocline disappeared. It only works because the seafloor has its own scale
 * (SEAFLOOR_HEIGHT).
 */
export const ANALYSIS_HEIGHT = 0.85;

/** Land relief is squashed a lot so it doesn't pull attention from the data. */
export const LAND_HEIGHT = 0.085;
export const LAND_REFERENCE = 3100;

/**
 * The seafloor has its own, much gentler linear scale (about a seventh of the
 * analysis axis).
 *
 * On a shared axis the continental slope (2 km over 60 km) turns into a vertical
 * wall right in the visible depth band. The trade-off is that seafloor height is
 * only indicative; nothing reads a depth off it.
 */
export const SEAFLOOR_REFERENCE_DEPTH = 5500;
/** Kept below ANALYSIS_HEIGHT so the floor never cuts through the data. */
export const SEAFLOOR_HEIGHT = 1.1;

export interface Extent {
  latRange: [number, number];
  lonRange: [number, number];
}

export class GeoFrame {
  readonly latMid: number;
  readonly lonMid: number;
  readonly scale: number;

  constructor(readonly dataExtent: Extent) {
    const [lat0, lat1] = dataExtent.latRange;
    const [lon0, lon1] = dataExtent.lonRange;
    this.latMid = (lat0 + lat1) / 2;
    this.lonMid = (lon0 + lon1) / 2;
    // The analysis box keeps its size; everything else scales around it.
    const longest = Math.max(Math.abs(lat1 - lat0), Math.abs(lon1 - lon0)) || 1;
    this.scale = 2 / longest;
  }

  /** East is +x. */
  x(lon: number): number {
    return (lon - this.lonMid) * this.scale;
  }

  /** North is -z (right-handed, y up). */
  z(lat: number): number {
    return -(lat - this.latMid) * this.scale;
  }

  /**
   * Depth in metres to world y (sea level 0, down is negative).
   *
   * Same power curve as viz/depth.ts. Not clamped at 2000 m, because the seafloor
   * goes deeper than the analysis.
   */
  depthY(depth: number): number {
    return -depthToNormUnclamped(depth, ANALYSIS_MAX_DEPTH) * ANALYSIS_HEIGHT;
  }

  /**
   * ETOPO elevation (positive land, negative seafloor) to world y.
   *
   * Depth is clamped at TERRAIN_FLOOR_DEPTH so the deep basin doesn't turn into a
   * huge canyon under the analysis. The shelf, slope and coastline still show.
   */
  elevationY(elevation: number): number {
    if (elevation <= 0) {
      const depth = Math.min(-elevation, SEAFLOOR_REFERENCE_DEPTH);
      return -(depth / SEAFLOOR_REFERENCE_DEPTH) * SEAFLOOR_HEIGHT;
    }
    return Math.min(elevation / LAND_REFERENCE, 1) * LAND_HEIGHT;
  }

  /** Horizontal half-extent of a lat/lon box in world units. */
  spanOf(extent: Extent): { width: number; depth: number } {
    return {
      width: Math.abs(extent.lonRange[1] - extent.lonRange[0]) * this.scale,
      depth: Math.abs(extent.latRange[1] - extent.latRange[0]) * this.scale,
    };
  }

  centerOf(extent: Extent): { x: number; z: number } {
    return {
      x: this.x((extent.lonRange[0] + extent.lonRange[1]) / 2),
      z: this.z((extent.latRange[0] + extent.latRange[1]) / 2),
    };
  }

  /** Vertical exaggeration, for display. */
  verticalExaggeration(): number {
    // One degree of latitude is ~111 km; compare units per metre vertically vs horizontally.
    const unitsPerMetreHorizontal = this.scale / 111_000;
    const unitsPerMetreVertical = ANALYSIS_HEIGHT / ANALYSIS_MAX_DEPTH;
    return unitsPerMetreVertical / unitsPerMetreHorizontal;
  }
}
