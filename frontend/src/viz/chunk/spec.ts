/**
 * The scene spec: the single source of truth for the chunk view.
 *
 * Everything drawn comes from this object (extent, camera preset, colour range,
 * time index and an ordered list of layers). The view keeps no scene state of its
 * own, so the inspector can round-trip the whole scene as JSON.
 *
 * ``type`` is a plain string on purpose: a spec may name a layer this build
 * doesn't have, and we render the rest instead of failing to parse.
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
  /** Old specs had three booleans; applySpec migrates them. */
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
    {
      id: "instruments",
      type: "instruments",
      label: "Instrument traces",
      visible: true,
      opacity: 1,
      props: {},
    },
    { id: "bathy", type: "bathymetry", label: "Bathymetry", visible: true, opacity: 1, props: { palette: "deep" } },
  ],
  field: { variable: "temperature" },
};

/**
 * The chunk opens on thirty daily steps around Cyclone Phailin (inside HYCOM's
 * 1994-2015 range, and where the Argo floats are). Exported so the assistant
 * can describe the chunk before it's opened.
 */
export const CHUNK_FOCUS_DATE = "2013-10-10";
export const CHUNK_WINDOW_STEPS = 30;

/** Depths with a tick on the box frame and a label on the ruler. */
export const RULER: number[] = [0, 50, 100, 200, 500, 1000, 2000];

/**
 * Camera presets: ``corner`` shows the box as a volume, ``top`` as a map,
 * ``section`` as a near-flat slice through the column.
 */
export const PRESETS: Record<PresetName, { theta: number; phi: number; radius: number }> = {
  corner: { theta: 0.82, phi: 1.1, radius: 26 },
  top: { theta: 0.0, phi: 0.045, radius: 26 },
  section: { theta: 0.0, phi: 1.545, radius: 20 },
};

/**
 * Depth in metres to 0 (surface) .. 1 (2000 m).
 *
 * ``stretched`` gives the top 200 m half the height, where the mixed layer and
 * thermocline are. ``linear`` shows true proportions. Ticks always show real metres.
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
 * World height of the column for a given exaggeration. The box is 10 units
 * across (5° ≈ 550 km), so at 150× the column is 150 times taller than reality.
 */
export function columnHeight(exaggeration: number): number {
  return 10 * (2 / 550) * exaggeration;
}
