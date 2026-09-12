/**
 * Map state as a pure reducer.
 *
 * Kept out of App.tsx because the tricky part is working out what each layer
 * shows when they have different time axes, and that's easier to test as plain
 * functions. Key rule: there is one clock. MapState.time is a single instant and
 * every layer resolves against it.
 */

import type { ColormapName } from "../viz/colormaps";
import type { MapLayerInfo, MapTimeAxis } from "../api/client";
import type { Viewport } from "./projection";

export const MAX_LAYERS = 3;

export interface MapLayer {
  /** Stable across reorder (React key and fetch key). */
  id: string;
  datasetId: string;
  visible: boolean;
  opacity: number;
  colormap: ColormapName;
  /** Index into the dataset's depth_levels. Always 0 for surface fields. */
  depthIndex: number;
  /** null = use the range the server computed for this slice. */
  range: [number, number] | null;
  log: boolean;
  /** Only used if the dataset has vector components. */
  streamlines: boolean;
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface AreaSelection {
  latRange: [number, number];
  lonRange: [number, number];
  /** Provisional until pointerup. */
  dragging: boolean;
}

export interface MapState {
  catalogue: MapLayerInfo[];
  /** Time axes by dataset id, fetched as layers are added. */
  axes: Record<string, MapTimeAxis>;
  /** Index 0 is the top of the list and is drawn last (on top). */
  layers: MapLayer[];
  /** Controls the timeline cadence, depth ruler and point readout. */
  activeLayerId: string | null;
  /** The one clock; every layer resolves against it. */
  time: string;
  playing: boolean;
  viewport: Viewport;
  pin: GeoPoint | null;
  area: AreaSelection | null;
  tool: "inspect" | "area";
  error: string | null;
}

export type MapAction =
  | { type: "catalogue/loaded"; datasets: MapLayerInfo[] }
  | { type: "catalogue/failed"; message: string }
  | { type: "axis/loaded"; dataset: string; axis: MapTimeAxis }
  | { type: "layer/add"; datasetId: string }
  | { type: "layer/remove"; id: string }
  | { type: "layer/move"; id: string; delta: number }
  | { type: "layer/patch"; id: string; patch: Partial<Omit<MapLayer, "id" | "datasetId">> }
  | { type: "layer/activate"; id: string }
  | {
      /**
       * Take the layer stack from the side panel.
       *
       * A UI layer is a variable, not a dataset. Each one is resolved to the best map
       * dataset for it (by preference) and the map's layers are rebuilt to match.
       */
      type: "layers/sync";
      stack: {
        keys: string[];
        visibility: Record<string, boolean>;
        opacity: Record<string, number>;
      };
    }
  | { type: "time/set"; time: string }
  | { type: "time/step"; steps: number }
  | { type: "time/play"; playing: boolean }
  | { type: "viewport/set"; viewport: Viewport }
  | { type: "viewport/zoom"; factor: number }
  | { type: "viewport/reset" }
  | { type: "pin/set"; point: GeoPoint | null }
  | { type: "area/begin"; corner: GeoPoint }
  | { type: "area/update"; corner: GeoPoint }
  | { type: "area/commit" }
  | { type: "area/clear" }
  | { type: "tool/set"; tool: MapState["tool"] };

let seq = 0;
const nextId = () => `layer-${++seq}`;

export function createInitialMapState(): MapState {
  return {
    catalogue: [],
    axes: {},
    layers: [],
    activeLayerId: null,
    time: "",
    playing: false,
    // Start on the whole world; worldFitZoom adjusts once the canvas has a size.
    viewport: { lonCentre: 0, latCentre: 0, zoom: 3 },
    pin: null,
    area: null,
    tool: "inspect",
    error: null,
  };
}

export function datasetOf(state: MapState, layer: MapLayer): MapLayerInfo | undefined {
  return state.catalogue.find((d) => d.id === layer.datasetId);
}

export function activeLayer(state: MapState): MapLayer | null {
  return state.layers.find((l) => l.id === state.activeLayerId) ?? null;
}

/**
 * Depth levels for the ruler, or null if the field has no depth (the ruler is
 * then removed).
 */
export function activeDepthLevels(state: MapState): number[] | null {
  const layer = activeLayer(state);
  if (!layer) return null;
  const info = datasetOf(state, layer);
  if (!info || info.depth_levels.length === 0) return null;
  return info.depth_levels;
}

export interface ResolvedTime {
  time: string;
  /** Signed days from state.time. Shown when it's more than half a step. */
  offsetDays: number;
  /** True when the clock is outside this layer's coverage. */
  outOfCoverage: boolean;
}

const DAY_MS = 86_400_000;

/**
 * The time step a layer will actually show: the nearest one, with the offset
 * returned so the layer card can show it.
 */
export function resolveLayerTime(state: MapState, layer: MapLayer): ResolvedTime | null {
  const info = datasetOf(state, layer);
  if (!info || !state.time) return null;
  const wanted = Date.parse(state.time);
  const start = Date.parse(`${info.time_start}T00:00:00Z`);
  const end = Date.parse(`${info.time_end}T00:00:00Z`);
  if (!Number.isFinite(wanted)) return null;

  if (wanted < start || wanted > end) {
    return { time: wanted < start ? info.time_start : info.time_end, offsetDays: 0, outOfCoverage: true };
  }

  const axis = state.axes[layer.datasetId];
  // A truncated axis is only a sample for tick marks, not the real steps. Snapping
  // to it would invent offsets (CMEMS is daily but sent every 7th day).
  if (!axis || axis.times.length === 0 || axis.truncated) {
    return { time: state.time, offsetDays: 0, outOfCoverage: false };
  }

  let best = axis.times[0]!;
  let bestGap = Infinity;
  for (const t of axis.times) {
    const gap = Math.abs(Date.parse(t) - wanted);
    if (gap < bestGap) {
      bestGap = gap;
      best = t;
    }
  }
  return {
    time: best,
    offsetDays: (Date.parse(best) - wanted) / DAY_MS,
    outOfCoverage: false,
  };
}

/** Layers with nothing to show at the current time. Their fetch is skipped. */
export function layersOutOfCoverage(state: MapState): ReadonlySet<string> {
  const out = new Set<string>();
  for (const layer of state.layers) {
    const resolved = resolveLayerTime(state, layer);
    if (resolved?.outOfCoverage) out.add(layer.id);
  }
  return out;
}

/** The timeline covers all visible layers' ranges combined. */
export function timelineBounds(state: MapState): { start: string; end: string } | null {
  const visible = state.layers.filter((l) => l.visible).map((l) => datasetOf(state, l));
  const infos = visible.filter((d): d is MapLayerInfo => d !== undefined);
  if (infos.length === 0) return null;
  let start = infos[0]!.time_start;
  let end = infos[0]!.time_end;
  for (const info of infos) {
    if (info.time_start < start) start = info.time_start;
    if (info.time_end > end) end = info.time_end;
  }
  return { start, end };
}

/** Best map dataset for a UI variable, or undefined if the map can't draw it. */
export function sourceForVariable(
  catalogue: MapLayerInfo[],
  variableKey: string,
): MapLayerInfo | undefined {
  const candidates = catalogue.filter((d) => d.variable_key === variableKey);
  if (candidates.length === 0) return undefined;
  return candidates.reduce((best, d) => (d.preference < best.preference ? d : best));
}

function makeLayer(info: MapLayerInfo): MapLayer {
  return {
    id: nextId(),
    datasetId: info.id,
    visible: true,
    opacity: 1,
    colormap: info.colormap,
    depthIndex: 0,
    range: null,
    log: info.id === "viirs_chlorophyll", // chlorophyll is heavily skewed
    streamlines: info.has_vectors,
  };
}

export function mapReducer(state: MapState, action: MapAction): MapState {
  switch (action.type) {
    case "catalogue/loaded":
      // Don't add a layer here; the side panel owns the stack and sends it via
      // layers/sync. Adding one here would briefly show a layer the panel doesn't have.
      return { ...state, catalogue: action.datasets, error: null };

    case "catalogue/failed":
      return { ...state, error: action.message };

    case "axis/loaded":
      return { ...state, axes: { ...state.axes, [action.dataset]: action.axis } };

    case "layer/add": {
      if (state.layers.length >= MAX_LAYERS) return state;
      const info = state.catalogue.find((d) => d.id === action.datasetId);
      if (!info) return state;
      if (state.layers.some((l) => l.datasetId === action.datasetId)) return state;
      const layer = makeLayer(info);
      return { ...state, layers: [layer, ...state.layers], activeLayerId: layer.id };
    }

    case "layer/remove": {
      const layers = state.layers.filter((l) => l.id !== action.id);
      const activeLayerId =
        state.activeLayerId === action.id ? layers[0]?.id ?? null : state.activeLayerId;
      return { ...state, layers, activeLayerId };
    }

    case "layer/move": {
      const i = state.layers.findIndex((l) => l.id === action.id);
      const j = i + action.delta;
      if (i < 0 || j < 0 || j >= state.layers.length) return state;
      const layers = [...state.layers];
      const [moved] = layers.splice(i, 1);
      layers.splice(j, 0, moved!);
      return { ...state, layers };
    }

    case "layer/patch":
      return {
        ...state,
        layers: state.layers.map((l) => (l.id === action.id ? { ...l, ...action.patch } : l)),
      };

    case "layer/activate":
      return { ...state, activeLayerId: action.id };

    case "layers/sync": {
      if (state.catalogue.length === 0) return state;
      const { keys, visibility, opacity } = action.stack;
      const layers: MapLayer[] = [];
      for (const key of keys) {
        const info = sourceForVariable(state.catalogue, key);
        if (!info) continue; // no map source for this variable
        // Reuse the existing layer so its settings survive a visibility toggle.
        const existing = state.layers.find((l) => l.datasetId === info.id);
        layers.push({
          ...(existing ?? makeLayer(info)),
          visible: visibility[key] !== false,
          opacity: opacity[key] ?? 1,
        });
      }
      if (layers.length === 0) {
        return { ...state, layers: [], activeLayerId: null };
      }
      const stillActive = layers.some((l) => l.id === state.activeLayerId);
      const topVisible = layers.find((l) => l.visible) ?? layers[0]!;
      const topInfo = datasetOf({ ...state, layers } as MapState, topVisible);
      let nextTime = state.time;
      if (!nextTime || (topInfo && nextTime > `${topInfo.time_end}T00:00:00Z`)) {
        nextTime = `${topInfo?.time_end ?? ""}T00:00:00Z`;
      } else if (topInfo && nextTime < `${topInfo.time_start}T00:00:00Z`) {
        nextTime = `${topInfo?.time_start ?? ""}T00:00:00Z`;
      }
      return {
        ...state,
        layers,
        activeLayerId: stillActive ? state.activeLayerId : topVisible.id,
        time: nextTime,
      };
    }

    case "time/set":
      return { ...state, time: action.time };

    case "time/step": {
      const layer = activeLayer(state);
      const info = layer ? datasetOf(state, layer) : undefined;
      if (!info || !state.time) return state;
      // Step by the active layer's cadence.
      const ms = action.steps * info.cadence_days * DAY_MS;
      const start = Date.parse(`${info.time_start}T00:00:00Z`);
      const end = Date.parse(`${info.time_end}T00:00:00Z`);
      const next = Math.max(start, Math.min(end, Date.parse(state.time) + ms));
      return { ...state, time: new Date(next).toISOString().replace(/\.\d{3}Z$/, "Z") };
    }

    case "time/play":
      return { ...state, playing: action.playing };

    case "viewport/set":
      return { ...state, viewport: action.viewport };

    case "viewport/zoom": {
      const zoom = Math.max(1, Math.min(5000, state.viewport.zoom * action.factor));
      return { ...state, viewport: { ...state.viewport, zoom } };
    }

    case "viewport/reset":
      return {
        ...state,
        viewport: { lonCentre: 0, latCentre: 0, zoom: 3 },
      };

    case "pin/set":
      return { ...state, pin: action.point };

    case "area/begin":
      return {
        ...state,
        area: {
          latRange: [action.corner.lat, action.corner.lat],
          lonRange: [action.corner.lon, action.corner.lon],
          dragging: true,
        },
      };

    case "area/update": {
      if (!state.area) return state;
      return {
        ...state,
        area: {
          ...state.area,
          latRange: [state.area.latRange[0], action.corner.lat],
          lonRange: [state.area.lonRange[0], action.corner.lon],
        },
      };
    }

    case "area/commit": {
      if (!state.area) return state;
      const lat = [...state.area.latRange].sort((a, b) => a - b) as [number, number];
      const lon = [...state.area.lonRange].sort((a, b) => a - b) as [number, number];
      return { ...state, area: { latRange: lat, lonRange: lon, dragging: false } };
    }

    case "area/clear":
      return { ...state, area: null };

    case "tool/set":
      return { ...state, tool: action.tool, area: action.tool === "inspect" ? null : state.area };

    default:
      return state;
  }
}
