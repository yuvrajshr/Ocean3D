/**
 * The scene spec — the chunk view's single source of truth.
 *
 * Everything the viewport draws is derived from this object: the chunk's
 * extent, the camera preset, the colour range, the time index and an ordered
 * list of layer descriptors. Nothing in the view holds scene state of its own,
 * which is why the spec inspector can round-trip the whole scene through JSON
 * and why adding a sensor or a model variable is a descriptor plus a module in
 * the registry, with no change to the view.
 *
 * A descriptor's `type` is intentionally a plain string: a spec may name a
 * layer type this build has no module for, and the right response is to render
 * the rest and say so, not to fail to parse.
 */

import type { CmapName, VariableKey } from "./model";

export type DepthAxis = "linear" | "stretched";
export type PresetName = "corner" | "top" | "section";
export type ScalarMode = "slices" | "volume" | "isosurface";
export type CutAxis = "depth" | "lon" | "lat";

export interface LayerProps {
  mode?: ScalarMode;
  sliceDepth?: number;
  sliceLon?: number;
  sliceLat?: number;
  activeAxis?: CutAxis;
  contextWalls?: boolean;
  isoValue?: number;
  count?: number;
  speed?: number;
  trail?: number;
  platforms?: string[];
  palette?: CmapName;
  /** Pre-active-axis specs carried three booleans; applySpec migrates them. */
  showDepth?: boolean;
  showLon?: boolean;
  showLat?: boolean;
}

export interface LayerDesc {
  id: string;
  type: string;
  label?: string;
  visible?: boolean;
  opacity?: number;
  props?: LayerProps;
}

export interface SceneSpec {
  chunk: {
    bbox: [number, number, number, number];
    depthRange: [number, number];
    resolution: [number, number, number];
    source: string;
  };
  view: { exaggeration: number; depthAxis: DepthAxis; preset: PresetName };
  colorRange: { palette: CmapName; scale: "linear" | "log"; min: number; max: number };
  time: { steps: number; index: number; start: string };
  layers: LayerDesc[];
  field: { variable: VariableKey };
}

export const DEFAULT_SPEC: SceneSpec = {
  chunk: {
    bbox: [85, 10, 90, 15],
    depthRange: [0, 2000],
    resolution: [60, 60, 50],
    source: "INCOIS-GODAS/BoB-1-12",
  },
  view: { exaggeration: 150, depthAxis: "stretched", preset: "corner" },
  colorRange: { palette: "thermal", scale: "linear", min: 4, max: 30 },
  time: { steps: 30, index: 12, start: "2026-03-01" },
  layers: [
    { id: "surface", type: "sea-surface", label: "Sea surface", visible: true, opacity: 0.16, props: {} },
    {
      id: "scalar",
      type: "scalar-field",
      label: "Scalar field",
      visible: true,
      opacity: 0.88,
      props: {
        mode: "slices",
        sliceDepth: 80,
        sliceLon: 87.35,
        sliceLat: 12.65,
        activeAxis: "depth",
        contextWalls: true,
        isoValue: 20,
      },
    },
    {
      id: "currents",
      type: "currents",
      label: "Currents",
      visible: true,
      opacity: 0.85,
      props: { count: 900, speed: 1, trail: 10 },
    },
    { id: "bathy", type: "bathymetry", label: "Bathymetry", visible: true, opacity: 1, props: { palette: "deep" } },
  ],
  field: { variable: "temperature" },
};

/** Depths that get a tick on the box frame and a label on the CSS ruler. */
export const RULER: number[] = [0, 50, 100, 200, 500, 1000, 2000];

/**
 * Camera presets. `corner` reads the box as a volume, `top` as a map, and
 * `section` flattens to a near-orthographic slice through the column — the
 * three questions this view actually gets asked.
 */
export const PRESETS: Record<PresetName, { theta: number; phi: number; radius: number }> = {
  corner: { theta: 0.82, phi: 1.1, radius: 26 },
  top: { theta: 0.0, phi: 0.045, radius: 26 },
  section: { theta: 0.0, phi: 1.545, radius: 20 },
};

/**
 * Depth in metres to a normalized 0 (surface) .. 1 (2000 m) position.
 *
 * `stretched` gives the upper 200 m half the vertical extent, because that is
 * where the mixed layer and thermocline live and a linear axis compresses them
 * into a tenth of the column. `linear` is kept because a section read against
 * true proportions is sometimes the honest picture. Ticks always carry real
 * metres either way, so position is never the only thing carrying the value.
 */
export function depthNorm(d: number, axis: DepthAxis): number {
  const D = 2000;
  if (axis === "stretched") {
    return d <= 200
      ? 0.5 * Math.pow(d / 200, 0.85)
      : 0.5 + 0.5 * Math.pow((d - 200) / (D - 200), 0.9);
  }
  return d / D;
}

/** Inverse of depthNorm. */
export function depthNormInv(y: number, axis: DepthAxis): number {
  const D = 2000;
  if (axis === "stretched") {
    return y <= 0.5
      ? 200 * Math.pow(y / 0.5, 1 / 0.85)
      : 200 + (D - 200) * Math.pow((y - 0.5) / 0.5, 1 / 0.9);
  }
  return y * D;
}

/**
 * World height of the column for a given vertical exaggeration.
 *
 * The box is 10 world units across, which is 5° ≈ 550 km; 2000 m of water at
 * true scale would be 0.036 units. The factor below makes the exaggeration
 * readout literal: at 150× the column is 150 times taller than the ocean is.
 */
export function columnHeight(exaggeration: number): number {
  return 10 * (2 / 550) * exaggeration;
}
