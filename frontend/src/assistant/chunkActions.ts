/**
 * The assistant's chunk actions: pure transforms of the scene spec.
 *
 * The chunk view's own panels change the scene by mutating the spec and calling
 * `commit`. The assistant has to arrive at the same end state by the same rules,
 * or "show salinity" typed into the panel and "show salinity" clicked would draw
 * two different things. So each rule lives here, as a function from one spec to
 * the next that never mutates its input:
 *
 *   - a variable change resets palette, range and scale exactly as clicking the
 *     variable does, and re-centres an isovalue carried over from another field;
 *   - a surface-only field (chlorophyll) falls back to a depth slice, which is
 *     what the panel's disabled Volume / Iso / Lon / Lat buttons already imply.
 *
 * What the engine must run itself — a camera tween, a group rescale, opening a
 * neighbouring tile — comes back as an effect rather than a spec change.
 */

import type { Bbox } from "../viz/chunk/loader";
import { VARIABLES, type VariableKey } from "../viz/chunk/model";
import type { CutAxis, LayerProps, PresetName, ScalarMode, SceneSpec } from "../viz/chunk/spec";

export type ChunkAssistantAction =
  | { type: "show_variable"; variable: VariableKey }
  | { type: "set_time"; time: string }
  | { type: "set_display"; mode: ScalarMode }
  | { type: "set_cut"; axis: CutAxis; value: number }
  | { type: "set_iso_value"; value: number }
  | { type: "set_exaggeration"; value: number }
  | { type: "set_camera"; preset: PresetName }
  | { type: "set_layer"; layer: string; visible?: boolean; opacity?: number }
  | { type: "set_colour_scale"; auto?: boolean; min?: number; max?: number; scale?: "linear" | "log" }
  | { type: "open_float"; platform_id: string }
  | { type: "move_chunk"; direction: string; lat: number; lon: number };

export interface ChunkEffect {
  spec: SceneSpec;
  /** Set when the field changed, so an open cast can be re-paired against it. */
  variableChanged?: VariableKey;
  /** A camera preset for the engine to tween to. */
  preset?: PresetName;
  /** True when the exaggeration changed; the engine rescales its group. */
  exaggeration?: boolean;
  /** Open the tile containing this point, through the same resolver a click uses. */
  move?: { lat: number; lon: number };
  /** Open this float's cast against the model, as clicking its track does. */
  openFloat?: string;
}

/** What the chunk tells the assistant about itself. Mirrors ChunkState in tools.py. */
export interface ChunkStatePayload {
  mounted: boolean;
  bbox: number[];
  variable: VariableKey;
  time: string;
  window: string[];
  mode: ScalarMode;
  cut: { axis: CutAxis; value: number };
  iso_value: number | null;
  exaggeration: number;
  camera: PresetName;
  layers: Record<string, { visible: boolean; opacity: number }>;
  colour: { min: number; max: number; scale: "linear" | "log" };
  /** Floats with a track in this chunk and window. */
  platforms: string[];
  /** The float whose cast is open against the model. */
  open_float: string | null;
}

export interface ChunkSnapshot {
  spec: SceneSpec;
}

/** What ChunkView registers once its engine is ready. */
export interface ChunkController {
  getState(): ChunkStatePayload;
  apply(action: ChunkAssistantAction): void;
  snapshot(): ChunkSnapshot;
  restore(snapshot: ChunkSnapshot): void;
}

export interface ChunkApplyContext {
  /** The chunk's daily window, one ISO date per step. */
  times: string[];
  /** The loaded field's true extremes — what the panel's Auto applies. */
  hist: { lo: number; hi: number } | null;
}

/** No upstream serves chlorophyll in 3D. Mirrors SURFACE_ONLY_CHUNK_VARIABLES. */
const SURFACE_ONLY = new Set<VariableKey>(["chlorophyll"]);

const CUT_KEY: Record<CutAxis, "sliceDepth" | "sliceLon" | "sliceLat"> = {
  depth: "sliceDepth",
  lon: "sliceLon",
  lat: "sliceLat",
};

/** The step whose date is nearest the one asked for. */
export function nearestStep(times: string[], day: string): number {
  const want = Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
  let best = 0;
  let gap = Infinity;
  times.forEach((t, i) => {
    const d = Math.abs(Date.parse(`${t.slice(0, 10)}T00:00:00Z`) - want);
    if (d < gap) {
      gap = d;
      best = i;
    }
  });
  return best;
}

function scalarProps(spec: SceneSpec): LayerProps | null {
  const layer = spec.layers.find((l) => l.id === "scalar");
  if (!layer) return null;
  layer.props = layer.props ?? {};
  return layer.props;
}

export function applyChunkAction(
  spec: SceneSpec,
  action: ChunkAssistantAction,
  ctx: ChunkApplyContext,
): ChunkEffect {
  const next: SceneSpec = structuredClone(spec);
  const props = scalarProps(next);

  switch (action.type) {
    case "show_variable": {
      const info = VARIABLES[action.variable];
      next.field.variable = action.variable;
      next.colorRange = {
        ...next.colorRange,
        palette: info.palette,
        min: info.range[0],
        max: info.range[1],
        scale: "linear",
      };
      if (props) {
        // An isovalue carried over from another variable is meaningless — 20 °C
        // is not 20 PSU — so it re-centres, as the panel's setVariable does.
        if (props.mode === "isosurface") {
          props.isoValue = info.range[0] + (info.range[1] - info.range[0]) * 0.55;
        }
        if (SURFACE_ONLY.has(action.variable)) {
          props.mode = "slices";
          props.activeAxis = "depth";
        }
      }
      return { spec: next, variableChanged: action.variable };
    }
    case "set_time":
      next.time.index = nearestStep(ctx.times, action.time);
      return { spec: next };
    case "set_display":
      if (props) props.mode = action.mode;
      return { spec: next };
    case "set_cut":
      if (props) {
        props.activeAxis = action.axis;
        props[CUT_KEY[action.axis]] = action.value;
      }
      return { spec: next };
    case "set_iso_value":
      if (props) {
        props.mode = "isosurface";
        props.isoValue = action.value;
      }
      return { spec: next };
    case "set_exaggeration":
      next.view.exaggeration = action.value;
      return { spec: next, exaggeration: true };
    case "set_camera":
      next.view.preset = action.preset;
      return { spec: next, preset: action.preset };
    case "set_layer": {
      const layer = next.layers.find((l) => l.id === action.layer);
      if (layer) {
        if (action.visible !== undefined) layer.visible = action.visible;
        if (action.opacity !== undefined) layer.opacity = action.opacity;
      }
      return { spec: next };
    }
    case "set_colour_scale": {
      const range = next.colorRange;
      if (action.auto && ctx.hist) {
        range.min = ctx.hist.lo;
        range.max = ctx.hist.hi;
      }
      if (action.min !== undefined && action.max !== undefined) {
        range.min = action.min;
        range.max = action.max;
      }
      if (action.scale) range.scale = action.scale;
      return { spec: next };
    }
    case "open_float":
      return { spec: next, openFloat: action.platform_id };
    case "move_chunk":
      return { spec: next, move: { lat: action.lat, lon: action.lon } };
  }
}

/** The chunk as the assistant needs to know it. Pure, so the unmounted case can use it too. */
export function describeChunkSpec(
  spec: SceneSpec,
  times: string[],
  bbox: Bbox,
  mounted: boolean,
  platforms: string[] = [],
  openFloat: string | null = null,
): ChunkStatePayload {
  const props = spec.layers.find((l) => l.id === "scalar")?.props ?? {};
  const axis: CutAxis = props.activeAxis ?? "depth";
  const layers: ChunkStatePayload["layers"] = {};
  for (const layer of spec.layers) {
    layers[layer.id] = { visible: layer.visible !== false, opacity: layer.opacity ?? 1 };
  }
  return {
    mounted,
    bbox: [...bbox],
    variable: spec.field.variable,
    time: times[spec.time.index] ?? "",
    window: times.length ? [times[0]!, times[times.length - 1]!] : [],
    mode: props.mode ?? "slices",
    cut: { axis, value: props[CUT_KEY[axis]] ?? 0 },
    iso_value: props.isoValue ?? null,
    exaggeration: spec.view.exaggeration,
    camera: spec.view.preset,
    layers,
    colour: { min: spec.colorRange.min, max: spec.colorRange.max, scale: spec.colorRange.scale },
    platforms,
    open_float: openFloat,
  };
}

/**
 * Chunk actions that arrive before a chunk is there to take them.
 *
 * "Open the chunk over the Bay of Bengal and show salinity" arrives as two
 * actions in one batch; the second targets an engine that does not exist until
 * the view has mounted. It waits here and is applied when ChunkView registers.
 */
export class ChunkActionQueue {
  private actions: ChunkAssistantAction[] = [];
  private restoreTo: ChunkSnapshot | null = null;

  push(action: ChunkAssistantAction): void {
    this.actions.push(action);
  }

  /** An undo supersedes anything still waiting: the reader asked for the old state. */
  pushRestore(snapshot: ChunkSnapshot): void {
    this.restoreTo = snapshot;
    this.actions = [];
  }

  get size(): number {
    return this.actions.length + (this.restoreTo ? 1 : 0);
  }

  /** Apply everything waiting. Returns false, keeping it all, when there is no chunk yet. */
  drain(controller: ChunkController | null): boolean {
    if (!controller) return false;
    if (this.restoreTo) controller.restore(this.restoreTo);
    for (const action of this.actions) controller.apply(action);
    this.actions = [];
    this.restoreTo = null;
    return true;
  }
}
