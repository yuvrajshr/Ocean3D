/**
 * The assistant's bridge into app state: what it is told, and where its actions go.
 *
 * Three jobs, moved out of App.tsx so they sit in one place with one reason to
 * change:
 *
 *   1. **State out.** Every turn the backend receives all three views — map,
 *      globe and chunk — so it can validate an action against the view on screen
 *      and, after a switch mid-turn, against the next one.
 *   2. **Actions in, routed by scope.** A validated action carries the view it
 *      was validated for. Map actions reach the map reducer and the layer stack,
 *      globe actions the scenario clock and the float selection, chunk actions
 *      the chunk view's own controller — and never anywhere else.
 *   3. **Undo.** A snapshot of every view, taken before a batch is applied.
 *
 * Everything reads the latest app state through a ref. The panel calls these
 * after an answer has streamed in, seconds after the render that created them;
 * a closure over that render's state would apply an action to a stale layer
 * stack and quietly undo whatever the reader changed while they waited.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, type Dispatch } from "react";

import type { InstrumentList, PlatformSummary, Scenario } from "../api/client";
import type { AppView } from "../components/CommandPill";
import { activeLayer, datasetOf, type MapAction, type MapState } from "../map/state";
import { dailyWindow, type Bbox } from "../viz/chunk/loader";
import { dateLabel } from "../viz/chunk/model";
import { CHUNK_FOCUS_DATE, CHUNK_WINDOW_STEPS, DEFAULT_SPEC } from "../viz/chunk/spec";
import {
  applyLayerAction,
  type AppSnapshot,
  type AssistantAction,
  type LayerStack,
  type MapAssistantAction,
} from "./actions";
import {
  ChunkActionQueue,
  describeChunkSpec,
  nearestStep,
  type ChunkController,
  type ChunkStatePayload,
} from "./chunkActions";

/** What the backend is told each turn. Mirrors ScreenState in assistant/tools.py. */
export interface ScreenStatePayload {
  view: "map" | "globe" | "chunk";
  map: {
    layers: {
      key: string;
      visible: boolean;
      opacity: number;
      provider?: string;
      time_start?: string;
      time_end?: string;
    }[];
    time: string;
    active: { key: string; depth_m: number | null; depth_levels: number[] | null } | null;
    pin: { lat: number; lon: number } | null;
  };
  globe: { time: string; window: string[]; selected: string | null; floats: string[] };
  chunk: ChunkStatePayload;
}

/** The label and readout in the panel header: which view the assistant acts on. */
export interface AssistantScopeLabel {
  view: string;
  detail: string;
}

export interface AssistantBridgeDeps {
  view: AppView;
  handleView: (next: AppView) => void;
  map: MapState;
  dispatchMap: Dispatch<MapAction>;
  /** The map's CSS-pixel size, for fitting a region to it. */
  mapSize: () => { width: number; height: number };
  layerStack: LayerStack;
  /** Sets the mirror AND hands the side panel the stack (the §1c trap-1 seam). */
  pushLayerStack: (stack: LayerStack) => void;
  scenario: Scenario | null;
  timeIndex: number;
  setTimeIndex: (index: number) => void;
  selected: PlatformSummary | null;
  setSelected: (platform: PlatformSummary | null) => void;
  /** Floats reporting at the globe's date — what the reader can see and pick. */
  reportingFloats: PlatformSummary[];
  instruments: InstrumentList | null;
  chunkBbox: Bbox;
  openChunkAt: (lat: number, lon: number) => void;
}

const CHUNK_TIMES = dailyWindow(CHUNK_FOCUS_DATE, CHUNK_WINDOW_STEPS);

const hemisphere = (value: number, positive: string, negative: string): string =>
  `${Math.abs(value)}°${value >= 0 ? positive : negative}`;

export function chunkExtent([lon0, lat0, lon1, lat1]: Bbox): string {
  return (
    `${hemisphere(lat0, "N", "S")}–${hemisphere(lat1, "N", "S")}, ` +
    `${hemisphere(lon0, "E", "W")}–${hemisphere(lon1, "E", "W")}`
  );
}

export function useAssistantBridge(deps: AssistantBridgeDeps) {
  const depsRef = useRef(deps);
  useLayoutEffect(() => {
    depsRef.current = deps;
  });

  const chunkRef = useRef<ChunkController | null>(null);
  const queueRef = useRef(new ChunkActionQueue());

  /** ChunkView registers itself once its engine is ready, and unregisters on unmount. */
  const registerChunk = useCallback((controller: ChunkController | null) => {
    chunkRef.current = controller;
    if (controller) queueRef.current.drain(controller);
  }, []);

  const getState = useCallback((): ScreenStatePayload => {
    const d = depsRef.current;
    const byKey = new Map(
      d.map.layers.map((layer) => {
        const info = datasetOf(d.map, layer);
        return [info?.variable_key, info] as const;
      }),
    );
    const active = activeLayer(d.map);
    const activeInfo = active ? datasetOf(d.map, active) : undefined;
    const floats = [...new Set(d.reportingFloats.map((p) => p.platform_id))];

    return {
      // The water column is unreachable (next_session.md §0); a stray "column"
      // is answered as the map rather than as a view the backend does not know.
      view: d.view === "globe" || d.view === "chunk" ? d.view : "map",
      map: {
        layers: d.layerStack.keys.map((key) => {
          const info = byKey.get(key);
          return {
            key,
            visible: d.layerStack.visibility[key] ?? true,
            opacity: d.layerStack.opacity[key] ?? 1,
            provider: info?.provider,
            time_start: info?.time_start,
            time_end: info?.time_end,
          };
        }),
        time: d.map.time,
        active:
          active && activeInfo
            ? {
                key: activeInfo.variable_key,
                depth_m: activeInfo.depth_levels[active.depthIndex] ?? null,
                depth_levels: activeInfo.depth_levels.length ? activeInfo.depth_levels : null,
              }
            : null,
        pin: d.map.pin,
      },
      globe: {
        time: d.scenario?.timesteps[d.timeIndex] ?? "",
        window: d.scenario ? [d.scenario.time_start, d.scenario.time_end] : [],
        selected: d.selected?.platform_id ?? null,
        floats,
      },
      chunk:
        chunkRef.current?.getState() ??
        // Not open: describe the chunk as it would open, so a switch mid-turn
        // is validated against the view the reader is about to see.
        describeChunkSpec(DEFAULT_SPEC, CHUNK_TIMES, d.chunkBbox, false),
    };
  }, []);

  const snapshot = useCallback((): AppSnapshot => {
    const d = depsRef.current;
    const active = activeLayer(d.map);
    return {
      view: d.view,
      map: {
        stack: d.layerStack,
        time: d.map.time,
        pin: d.map.pin,
        active: active ? { id: active.id, depthIndex: active.depthIndex } : null,
      },
      globe: { timeIndex: d.timeIndex, selectedId: d.selected?.platform_id ?? null },
      chunk: { bbox: d.chunkBbox, spec: chunkRef.current?.snapshot() ?? null },
    };
  }, []);

  const findFloat = (id: string | null): PlatformSummary | null => {
    if (!id) return null;
    const d = depsRef.current;
    return (
      d.reportingFloats.find((p) => p.platform_id === id) ??
      d.instruments?.platforms.find((p) => p.platform_id === id) ??
      null
    );
  };

  const applyMap = (action: MapAssistantAction, stack: LayerStack): LayerStack => {
    const d = depsRef.current;
    switch (action.type) {
      case "set_layers": {
        const next = applyLayerAction(stack, action);
        d.pushLayerStack(next);
        return next;
      }
      case "set_time":
        d.dispatchMap({ type: "time/set", time: action.time });
        return stack;
      case "set_depth": {
        // The index into the active layer's own levels — the same thing the
        // map's depth ruler dispatches — not the hidden water column's ruler.
        const active = activeLayer(d.map);
        if (active) {
          d.dispatchMap({ type: "layer/patch", id: active.id, patch: { depthIndex: action.depth_index } });
        }
        return stack;
      }
      case "zoom_to_region": {
        // Fit the region to the map: zoom is CSS pixels per degree.
        const [south, north] = action.lat_range;
        const [west, east] = action.lon_range;
        const { width, height } = d.mapSize();
        const zoom = 0.92 * Math.min(width / Math.max(east - west, 1e-3), height / Math.max(north - south, 1e-3));
        d.dispatchMap({
          type: "viewport/set",
          viewport: { lonCentre: (west + east) / 2, latCentre: (south + north) / 2, zoom },
        });
        return stack;
      }
      case "set_pin":
        d.dispatchMap({ type: "pin/set", point: { lat: action.lat, lon: action.lon } });
        return stack;
      case "set_area":
        d.dispatchMap({ type: "area/begin", corner: { lat: action.lat_range[0], lon: action.lon_range[0] } });
        d.dispatchMap({ type: "area/update", corner: { lat: action.lat_range[1], lon: action.lon_range[1] } });
        d.dispatchMap({ type: "area/commit" });
        return stack;
    }
  };

  /** Apply a batch of actions, returning the state as it was immediately before. */
  const applyActions = useCallback((actions: AssistantAction[]): AppSnapshot | undefined => {
    if (actions.length === 0) return undefined;
    const before = snapshot();
    let stack = depsRef.current.layerStack;

    for (const action of actions) {
      const d = depsRef.current;
      if (action.type === "set_view") {
        d.handleView(action.view);
        continue;
      }
      if (action.type === "open_chunk") {
        d.openChunkAt(action.lat, action.lon);
        continue;
      }
      switch (action.scope) {
        case "map":
          stack = applyMap(action, stack);
          break;
        case "globe":
          if (action.type === "set_time") {
            if (d.scenario) d.setTimeIndex(nearestStep(d.scenario.timesteps, action.time));
          } else if (action.type === "select_float") {
            d.setSelected(findFloat(action.platform_id));
          } else {
            d.setSelected(null);
          }
          break;
        case "chunk":
          // Straight to the chunk if it is open; otherwise it waits for the
          // chunk this same batch just opened to register.
          if (chunkRef.current) chunkRef.current.apply(action);
          else queueRef.current.push(action);
          break;
      }
    }
    return before;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  const undo = useCallback((before: AppSnapshot) => {
    const d = depsRef.current;
    const [lon0, lat0, lon1, lat1] = before.chunk.bbox;
    const chunkMoved = lon0 !== d.chunkBbox[0] || lat0 !== d.chunkBbox[1];

    if (before.view === "chunk" && (chunkMoved || d.view !== "chunk")) {
      d.openChunkAt((lat0 + lat1) / 2, (lon0 + lon1) / 2);
    } else if (before.view !== d.view) {
      d.handleView(before.view as AppView);
    }

    d.pushLayerStack(before.map.stack);
    if (before.map.time) d.dispatchMap({ type: "time/set", time: before.map.time });
    d.dispatchMap({ type: "pin/set", point: before.map.pin });
    if (before.map.active) {
      d.dispatchMap({
        type: "layer/patch",
        id: before.map.active.id,
        patch: { depthIndex: before.map.active.depthIndex },
      });
    }
    d.setTimeIndex(before.globe.timeIndex);
    d.setSelected(findFloat(before.globe.selectedId));

    if (before.chunk.spec) {
      if (chunkRef.current && !chunkMoved) chunkRef.current.restore(before.chunk.spec);
      else queueRef.current.pushRestore(before.chunk.spec);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scope = useMemo<AssistantScopeLabel>(() => {
    if (deps.view === "chunk") return { view: "Chunk view", detail: chunkExtent(deps.chunkBbox) };
    if (deps.view === "globe") {
      const t = deps.scenario?.timesteps[deps.timeIndex];
      return { view: "Globe", detail: t ? dateLabel(t) : "" };
    }
    return { view: "Map", detail: deps.map.time ? dateLabel(deps.map.time) : "" };
  }, [deps.view, deps.chunkBbox, deps.scenario, deps.timeIndex, deps.map.time]);

  return { getState, applyActions, undo, registerChunk, scope };
}
