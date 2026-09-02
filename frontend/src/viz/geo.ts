import { depthToNormUnclamped } from "./depth";

/**
 * One geographic-to-world mapping, shared by everything in the scene.
 *
 * The terrain, the sea surface, the data volume, the float markers and the
 * depth ruler must all agree on where 15°N or 100 m actually is. Previously
 * only the data box existed and it carried its own arithmetic; now that a
 * wider ocean surrounds it, that has to move somewhere both can read.
 *
 * Vertical scale is heavily exaggerated — the box is ~2,750 km wide and the
 * ocean 5.5 km deep, so at true scale the water column would be a film. The
 * exaggeration is stated in the UI rather than hidden, and the depth ruler
 * always carries real metres.
 */

/** Depth at which the ruler and the analysis both end. */
export const ANALYSIS_MAX_DEPTH = 2000;

/**
 * World height given to the analysis's 0–2000 m span.
 *
 * This number is the whole vertical-exaggeration budget, and it came down twice.
 *
 * At 1.15 (~575x) the seafloor plunged nearly two units below a 2.9-unit-wide
 * scene and read as a canyon. At 0.85 (~425x) the continental slope still
 * rendered as a sheer wall, because a slope that drops 2 km over 60 km IS
 * vertical once you stretch the vertical axis 425 times — no amount of
 * smoothing can fix that, only less exaggeration.
 *
 * Dropping to 0.45 (~225x) fixed the wall but cost the column its structure:
 * a slab that thin, seen from above, just shows its warm top face, and the
 * thermocline — the entire point — becomes invisible.
 *
 * 0.85 is the settled value, and it only works because the seafloor was given
 * its own gentle scale (SEAFLOOR_HEIGHT). Once the two axes were decoupled,
 * the column could be tall enough to read without dragging the bathymetry into
 * a canyon behind it. The depth ruler keeps its own resolution regardless,
 * being a CSS element sized independently of the 3D scene.
 */
export const ANALYSIS_HEIGHT = 0.85;

/**
 * Land relief is compressed hard. It is context, not the subject: at the same
 * exaggeration as the ocean the Eastern Ghats would tower over a basin four
 * times their height and pull the eye straight off the data.
 */
export const LAND_HEIGHT = 0.085;
export const LAND_REFERENCE = 3100;

/**
 * The seafloor gets its own, much gentler vertical scale — linear, and about a
 * seventh of the analysis axis.
 *
 * This is a deliberate decoupling, arrived at after three failed attempts to
 * share one axis. The analysis needs heavy exaggeration to be a readable water
 * column; the seafloor needs almost none to be a readable basin. Forcing both
 * onto one axis produced a continental slope rendered as a sheer wall — and
 * crucially that wall sits at 0–700 m, inside the depth band you can actually
 * see, so no amount of fading the abyss below it helped.
 *
 * Linear (not the analysis's power curve) keeps the shelf gradient gentle right
 * at the coastline, which is where the power curve was steepest and worst.
 *
 * The cost is that seafloor height is indicative rather than measurable. That
 * is an acceptable trade for context geometry, and it is stated in the UI —
 * nothing anywhere reads a depth off this surface.
 */
export const SEAFLOOR_REFERENCE_DEPTH = 5500;
/** Kept below ANALYSIS_HEIGHT's reach so the floor never cuts through the data. */
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
    // The analysis box keeps its familiar size; everything else is measured
    // against it, so the surrounding ocean scales correctly around the data.
    const longest = Math.max(Math.abs(lat1 - lat0), Math.abs(lon1 - lon0)) || 1;
    this.scale = 2 / longest;
  }

  /** East is +x. */
  x(lon: number): number {
    return (lon - this.lonMid) * this.scale;
  }

  /** North is -z, matching the right-handed frame with y up. */
  z(lat: number): number {
    return -(lat - this.latMid) * this.scale;
  }

  /**
   * Depth in metres to world y. Sea level is 0, down is negative.
   *
   * Square root, matching viz/depth.ts, so the surface layer keeps the space
   * its structure deserves. Deliberately NOT clamped at 2000 m: the analysis
   * stops there but the sea floor does not, and the gap between them is worth
   * seeing — Argo floats profile to 2000 m, so everything below is genuinely
   * unmeasured by this dataset.
   */
  depthY(depth: number): number {
    return -depthToNormUnclamped(depth, ANALYSIS_MAX_DEPTH) * ANALYSIS_HEIGHT;
  }

  /**
   * ETOPO elevation (positive land, negative seafloor) to world y.
   *
   * Seafloor depth is clamped at TERRAIN_FLOOR_DEPTH. The Bay of Bengal reaches
   * about 3,500 m and the wider box 5,500 m, and at this exaggeration an
   * unclamped basin plunges into a canyon far taller than the scene is wide —
   * which reads as a chasm rather than an ocean, and buries the analysis at the
   * top of it. Clamping puts the floor just below the analysis box: the shelf,
   * the slope and the coastline all still read, which is the part that carries
   * meaning here. The depth ruler and every reported number are unaffected.
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

  /** Vertical exaggeration, for the readout. Honest labelling, not decoration. */
  verticalExaggeration(): number {
    // One degree of latitude is ~111 km. Compare world units per metre
    // vertically against world units per metre horizontally.
    const unitsPerMetreHorizontal = this.scale / 111_000;
    const unitsPerMetreVertical = ANALYSIS_HEIGHT / ANALYSIS_MAX_DEPTH;
    return unitsPerMetreVertical / unitsPerMetreHorizontal;
  }
}
