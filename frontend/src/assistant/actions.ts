/**
 * Actions the assistant may take, and how they reach app state.
 *
 * THE IMPORTANT PART, and the thing that will bite anyone who skips it:
 * `layerStack` in App.tsx is the source of truth for layers, NOT `map.layers`.
 * The layers panel owns the stack, and an effect pushes it into the map
 * reducer with `layers/sync`, which derives `map.layers` from it. So a layer
 * change must produce a new stack here and go through `setLayerStack`.
 * Dispatching `layer/add` at the reducer appears to work and is then silently
 * overwritten by the next sync — exactly the class of bug next_session.md §6
 * exists to catalogue.
 *
 * Every action arrives already validated by the backend against the state
 * snapshot the client sent, so this file does not re-check bounds. It only
 * applies. What it must get right is the transformation itself, which is why
 * the layer half is a pure function with its own tests.
 */

export interface LayerStack {
  keys: string[];
  visibility: Record<string, boolean>;
  opacity: Record<string, number>;
}

export type AssistantAction =
  | {
      type: "set_layers";
      add: string[];
      remove: string[];
      show: string[];
      hide: string[];
      opacity: Record<string, number>;
    }
  | { type: "set_view"; view: "map" | "globe" | "column" }
  | { type: "set_time"; time: string }
  | { type: "set_depth"; depth_m: number }
  | {
      type: "zoom_to_region";
      label: string;
      lat_range: [number, number];
      lon_range: [number, number];
    }
  | { type: "set_pin"; lat: number; lon: number }
  | { type: "set_area"; lat_range: [number, number]; lon_range: [number, number] };

/**
 * Provenance for one sourced claim.
 *
 * `kind` is the distinction that matters. "data" is a measurement from one of
 * this project's own upstreams — INCOIS, Copernicus, HYCOM, VIIRS. "web" is a
 * page Google Search returned. Both are real sources and neither is a guess,
 * but a reader must never mistake a web page for the ocean analysis, so the
 * panel renders them differently.
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
 * Removals are applied before additions so that swapping a layer ("show me
 * chlorophyll instead of currents") stays inside the three-layer cap rather
 * than briefly exceeding it.
 *
 * A new layer goes on TOP (index 0), because index 0 is drawn last and is what
 * the reader sees — someone who just asked for chlorophyll means the one they
 * can look at, not one buried under two others.
 */
export function applyLayerAction(
  stack: LayerStack,
  action: Extract<AssistantAction, { type: "set_layers" }>,
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

/** Everything an action can change, captured so one click can put it all back. */
export interface AppSnapshot {
  layerStack: LayerStack;
  view: string;
  time: string;
  depthIndex: number;
}
