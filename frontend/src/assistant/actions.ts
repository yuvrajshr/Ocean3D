/**
 * Actions the assistant may take, and the shapes they reach the app in.
 *
 * Every action the backend returns has been validated against the view that was
 * on screen, and carries that view as `scope` (context.md §5.1 Principle 13,
 * amended 2026-09-10). The bridge routes on it: a `scope: "chunk"` action goes
 * to the chunk view's controller and nowhere else, which is what "changes apply
 * to the view you are on" means in code. `set_view` and `open_chunk` move
 * between views and are handled first, whatever their scope.
 *
 * THE LAYER SEAM, which bit once already: `layerStack` in App.tsx is the source
 * of truth for the map's layers, NOT `map.layers`, and VariablePanel owns the
 * stack in its own state. A layer change must produce a new stack and reach the
 * panel through `externalStack`; dispatching `layer/add` at the reducer appears
 * to work and is silently overwritten by the next `layers/sync`.
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
  /** `depth_index` indexes the active layer's own levels, as the ruler does. */
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
   * Open the chunk over a named region or stated coordinates. The tile is chosen
   * here by the same snap a globe click uses, so the assistant cannot open a
   * chunk that clicking could not.
   */
  | { type: "open_chunk"; label: string; lat: number; lon: number };

export type AssistantAction =
  | (AppAssistantAction & { scope: AssistantScope })
  | (MapAssistantAction & { scope: "map" })
  | (GlobeAssistantAction & { scope: "globe" })
  | (ChunkAssistantAction & { scope: "chunk" });

/**
 * Provenance for one sourced claim.
 *
 * `kind` is the distinction that matters: "data" is a measurement from one of
 * this project's own upstreams, "web" is a page Google Search returned. A reader
 * must never mistake one for the other, so the panel renders them differently.
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
 * The next layer stack after one `set_layers` action.
 *
 * Removals are applied before additions so that swapping a layer stays inside
 * the three-layer cap. A new layer goes on TOP (index 0), because index 0 is
 * drawn last and is what the reader sees.
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

/** Everything a batch of actions can change, captured so one click puts it all back. */
export interface AppSnapshot {
  view: string;
  map: {
    stack: LayerStack;
    time: string;
    pin: GeoPoint | null;
    /** The active layer and its depth index, when there is one. */
    active: { id: string; depthIndex: number } | null;
  };
  globe: { timeIndex: number; selectedId: string | null };
  chunk: { bbox: Bbox; spec: ChunkSnapshot | null };
}
