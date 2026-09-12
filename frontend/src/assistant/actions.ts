/**
 * Actions the assistant can take, and their shapes.
 *
 * Each action from the backend has already been validated against the view that
 * was on screen and carries it as ``scope``. The bridge routes on it: a chunk
 * action only goes to the chunk view. set_view and open_chunk switch views and
 * are handled first.
 *
 * Layer changes: layerStack in App.tsx is the source of truth (not map.layers),
 * and VariablePanel keeps its own copy. So a layer change has to produce a new
 * stack and reach the panel via externalStack; dispatching layer/add to the map
 * reducer just gets overwritten by the next layers/sync.
 */

import type { GeoPoint } from "../map/state";
import type { Bbox } from "../viz/chunk/loader";
import type { ChunkAssistantAction, ChunkSnapshot } from "./chunkActions";

export type AssistantScope = "map" | "globe" | "chunk";

export interface LayerStack {
  keys: string[];
  visibility: Record<string, boolean>;
  opacity: Record<string, number>;
}

export type MapAssistantAction =
  | {
      type: "set_layers";
      add: string[];
      remove: string[];
      show: string[];
      hide: string[];
      opacity: Record<string, number>;
    }
  | { type: "set_time"; time: string }
  /** ``depth_index`` indexes the active layer's own levels, like the ruler. */
  | { type: "set_depth"; depth_m: number; depth_index: number; requested_m: number }
  | {
      type: "zoom_to_region";
      label: string;
      lat_range: [number, number];
      lon_range: [number, number];
    }
  | { type: "set_pin"; lat: number; lon: number }
  | { type: "set_area"; lat_range: [number, number]; lon_range: [number, number] };

export type GlobeAssistantAction =
  | { type: "set_time"; time: string }
  | { type: "select_float"; platform_id: string }
  | { type: "clear_selection" };

export type AppAssistantAction =
  | { type: "set_view"; view: AssistantScope }
  /**
   * Open the chunk over a named region or given coordinates. The tile is snapped
   * the same way a globe click is.
   */
  | { type: "open_chunk"; label: string; lat: number; lon: number };

export type AssistantAction =
  | (AppAssistantAction & { scope: AssistantScope })
  | (MapAssistantAction & { scope: "map" })
  | (GlobeAssistantAction & { scope: "globe" })
  | (ChunkAssistantAction & { scope: "chunk" });

/**
 * Source for one claim. "data" is one of our datasets, "web" is a Google Search
 * result; the panel shows them differently.
 */
export interface Citation {
  kind?: "data" | "web";
  tool?: string;
  dataset?: string | null;
  label?: string | null;
  provider?: string | null;
  time?: string | null;
  depth_m?: number | null;
  units?: string | null;
  /** Web only. */
  url?: string | null;
  title?: string | null;
}

/**
 * The layer stack after one set_layers action. Removals happen first so a swap
 * stays under the three-layer limit. New layers go on top (index 0).
 */
export function applyLayerAction(
  stack: LayerStack,
  action: Extract<MapAssistantAction, { type: "set_layers" }>,
): LayerStack {
  const visibility = { ...stack.visibility };
  const opacity = { ...stack.opacity };

  let keys = stack.keys.filter((k) => !action.remove.includes(k));
  for (const key of action.remove) {
    delete visibility[key];
    delete opacity[key];
  }

  for (const key of action.add) {
    if (keys.includes(key)) continue;
    keys = [key, ...keys];
    visibility[key] = true;
    if (opacity[key] === undefined) opacity[key] = 1;
  }

  for (const key of action.show) visibility[key] = true;
  for (const key of action.hide) visibility[key] = false;
  for (const [key, value] of Object.entries(action.opacity)) opacity[key] = value;

  return { keys, visibility, opacity };
}

/** Everything a batch of actions can change, so Undo can put it all back. */
export interface AppSnapshot {
  view: string;
  map: {
    stack: LayerStack;
    time: string;
    pin: GeoPoint | null;
    /** Active layer and its depth index, if any. */
    active: { id: string; depthIndex: number } | null;
  };
  globe: { timeIndex: number; selectedId: string | null };
  chunk: { bbox: Bbox; spec: ChunkSnapshot | null };
}
