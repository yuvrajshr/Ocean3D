/**
 * Map state, as a pure reducer.
 *
 * A reducer rather than a dozen more `useState` calls in App.tsx for one
 * concrete reason: the hard part of this view is not storage, it is deciding
 * what three layers on three different time axes should each display. That
 * decision belongs in functions that can be tested in Node, not in JSX.
 *
 * The single most important invariant: **there is exactly one clock.**
 * `MapState.time` is one ISO instant, and every layer resolves itself against
 * it. Storing a per-layer index instead is how a stack silently ends up showing
 * three different dates while claiming to show one.
 */

import type { ColormapName } from "../viz/colormaps";
import type { MapLayerInfo, MapTimeAxis } from "../api/client";
import type { Viewport } from "./projection";

export const MAX_LAYERS = 3;

export interface MapLayer {
  /** Stable across reorder: React key and fetch key. */
  id: string;
  datasetId: string;
  visible: boolean;
  opacity: number;
  colormap: ColormapName;
  /** Index into the dataset's depth_levels. Always 0 for a surface field. */
  depthIndex: number;
  /** null means "use the range the server measured for this slice". */
  range: [number, number] | null;
  log: boolean;
  /** Only meaningful when the dataset has vector components. */
  streamlines: boolean;
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface AreaSelection {
  latRange: [number, number];
  lonRange: [number, number];
  /** Provisional until pointerup; the 3D bridge only offers on a committed box. */
  dragging: boolean;
}

export interface MapState {
  catalogue: MapLayerInfo[];
  /** Time axes, keyed by dataset id. Fetched lazily as layers are added. */
  axes: Record<string, MapTimeAxis>;
  /** Draw order: index 0 is the TOP of the list and is drawn LAST, i.e. on top. */
  layers: MapLayer[];
  /** Drives the timeline cadence, the depth ruler and the point readout. */
  activeLayerId: string | null;
  /** THE clock. One instant; every layer resolves against it. */
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
  | { type: "time/set"; time: string }
  | { type: "time/step"; steps: number }
  | { type: "time/play"; playing: boolean }
  | { type: "viewport/set"; viewport: Viewport }
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
    // Opens on the whole world, per the locked decision. worldFitZoom refines
    // this the moment the canvas reports a real size.
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

/** The depth levels the ruler should offer, or null when there is no depth.
 *
 *  null removes the ruler from the DOM entirely rather than disabling it. A
 *  surface field has no depth to slice, and a greyed-out ruler still asserts
 *  that one exists (context.md §10). */
export function activeDepthLevels(state: MapState): number[] | null {
  const layer = activeLayer(state);
  if (!layer) return null;
  const info = datasetOf(state, layer);
  if (!info || info.depth_levels.length === 0) return null;
  return info.depth_levels;
}

export interface ResolvedTime {
  time: string;
  /** Signed days from state.time. Surfaced when it exceeds half a step. */
  offsetDays: number;
  /** True when the clock is outside this layer's coverage entirely. */
  outOfCoverage: boolean;
}

const DAY_MS = 86_400_000;

/**
 * The timestep a layer will actually display.
 *
 * Nearest, not previous — matching the nearest-neighbour convention already used
 * by `erddap_grid.sample_column`. The offset is returned rather than hidden so
 * the layer card can state it: a monthly field and a daily field stacked
 * together are not the same instant, and the reader must be able to see that.
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
  // A truncated axis is a sample for drawing tick marks, NOT the real steps.
  // Snapping to it invents an offset the product does not have: CMEMS is daily
  // over 12,227 days, sent as every 7th stamp, which read as "-4 d".
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

/** Layers with nothing to draw at the current clock. Their fetch is skipped. */
export function layersOutOfCoverage(state: MapState): ReadonlySet<string> {
  const out = new Set<string>();
  for (const layer of state.layers) {
    const resolved = resolveLayerTime(state, layer);
    if (resolved?.outOfCoverage) out.add(layer.id);
  }
  return out;
}

/** The timeline rail spans the union of every visible layer's coverage. */
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

function makeLayer(info: MapLayerInfo): MapLayer {
  return {
    id: nextId(),
    datasetId: info.id,
    visible: true,
    opacity: 1,
    colormap: info.colormap,
    depthIndex: 0,
    range: null,
    log: info.id === "viirs_chlorophyll", // strongly right-skewed by nature
    streamlines: info.has_vectors,
  };
}

export function mapReducer(state: MapState, action: MapAction): MapState {
  switch (action.type) {
    case "catalogue/loaded": {
      const next: MapState = { ...state, catalogue: action.datasets, error: null };
      if (next.layers.length === 0 && action.datasets.length > 0) {
        // Prefer Copernicus: it is the only source here with depth that reaches
        // the present day, and depth is what distinguishes this from a flat
        // satellite map. Falls back through HYCOM to whatever exists, so the map
        // still opens when there are no Copernicus credentials.
        const first =
          action.datasets.find((d) => d.id === "cmems_temperature") ??
          action.datasets.find((d) => d.id === "hycom_temperature") ??
          action.datasets[0]!;
        const layer = makeLayer(first);
        next.layers = [layer];
        next.activeLayerId = layer.id;
        // "Latest available data" for the opening layer.
        next.time = state.time || `${first.time_end}T00:00:00Z`;
      }
      return next;
    }

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

    case "time/set":
      return { ...state, time: action.time };

    case "time/step": {
      const layer = activeLayer(state);
      const info = layer ? datasetOf(state, layer) : undefined;
      if (!info || !state.time) return state;
      // Step in the ACTIVE layer's cadence, and say so on the button.
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
