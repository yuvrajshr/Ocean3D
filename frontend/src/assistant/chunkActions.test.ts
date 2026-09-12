/**
 * The assistant's chunk actions, as pure transforms of the scene spec.
 *
 * The chunk view's panels mutate the spec and call commit; the assistant must
 * reach the same end state by the same rules — a variable change resets the
 * colour range exactly as clicking the variable does, and a surface-only field
 * falls back to slices exactly as the panel's disabled buttons imply. Pure, so
 * it is testable in Node: no engine, no WebGL, no React.
 */

import { describe, expect, it } from "vitest";

import { dailyWindow } from "../viz/chunk/loader";
import { VARIABLES } from "../viz/chunk/model";
import { CHUNK_FOCUS_DATE, CHUNK_WINDOW_STEPS, DEFAULT_SPEC, type SceneSpec } from "../viz/chunk/spec";
import {
  ChunkActionQueue,
  applyChunkAction,
  describeChunkSpec,
  type ChunkAssistantAction,
  type ChunkController,
} from "./chunkActions";

const times = dailyWindow(CHUNK_FOCUS_DATE, CHUNK_WINDOW_STEPS);
const ctx = { times, hist: { lo: 18.2, hi: 29.4 } };
const scalar = (spec: SceneSpec) => spec.layers.find((l) => l.id === "scalar")!;

describe("applyChunkAction", () => {
  it("never mutates the spec it is given", () => {
    const before = JSON.stringify(DEFAULT_SPEC);
    applyChunkAction(DEFAULT_SPEC, { type: "show_variable", variable: "salinity" }, ctx);
    applyChunkAction(DEFAULT_SPEC, { type: "set_display", mode: "volume" }, ctx);
    expect(JSON.stringify(DEFAULT_SPEC)).toBe(before);
  });

  it("changes the variable the way clicking it does", () => {
    const { spec, variableChanged } = applyChunkAction(
      DEFAULT_SPEC,
      { type: "show_variable", variable: "salinity" },
      ctx,
    );
    expect(variableChanged).toBe("salinity");
    expect(spec.field.variable).toBe("salinity");
    expect(spec.colorRange).toMatchObject({
      palette: VARIABLES.salinity.palette,
      min: VARIABLES.salinity.range[0],
      max: VARIABLES.salinity.range[1],
      scale: "linear",
    });
  });

  it("falls back to a depth slice for a surface-only field", () => {
    const volume = applyChunkAction(DEFAULT_SPEC, { type: "set_display", mode: "volume" }, ctx).spec;
    const { spec } = applyChunkAction(volume, { type: "show_variable", variable: "chlorophyll" }, ctx);
    expect(scalar(spec).props).toMatchObject({ mode: "slices", activeAxis: "depth" });
  });

  it("steps to the nearest day in the window", () => {
    const { spec } = applyChunkAction(DEFAULT_SPEC, { type: "set_time", time: "2013-10-11" }, ctx);
    expect(times[spec.time.index]).toBe("2013-10-11");
  });

  it("moves the cut plane along the axis asked for", () => {
    const { spec } = applyChunkAction(DEFAULT_SPEC, { type: "set_cut", axis: "lon", value: 87.5 }, ctx);
    expect(scalar(spec).props).toMatchObject({ activeAxis: "lon", sliceLon: 87.5 });
  });

  it("an isovalue switches the display to the isosurface", () => {
    const { spec } = applyChunkAction(DEFAULT_SPEC, { type: "set_iso_value", value: 20 }, ctx);
    expect(scalar(spec).props).toMatchObject({ mode: "isosurface", isoValue: 20 });
  });

  it("shows, hides and fades one layer", () => {
    const hidden = applyChunkAction(
      DEFAULT_SPEC,
      { type: "set_layer", layer: "currents", visible: false, opacity: 0.4 },
      ctx,
    ).spec;
    expect(hidden.layers.find((l) => l.id === "currents")).toMatchObject({ visible: false, opacity: 0.4 });
  });

  it("auto colour uses the chunk's own histogram", () => {
    const { spec } = applyChunkAction(
      DEFAULT_SPEC,
      { type: "set_colour_scale", auto: true, scale: "log" },
      ctx,
    );
    expect(spec.colorRange).toMatchObject({ min: 18.2, max: 29.4, scale: "log" });
  });

  it("hands camera, exaggeration and movement back as effects the engine runs", () => {
    expect(applyChunkAction(DEFAULT_SPEC, { type: "set_camera", preset: "top" }, ctx).preset).toBe("top");
    const tall = applyChunkAction(DEFAULT_SPEC, { type: "set_exaggeration", value: 100 }, ctx);
    expect(tall.exaggeration).toBe(true);
    expect(tall.spec.view.exaggeration).toBe(100);
    const moved = applyChunkAction(
      DEFAULT_SPEC,
      { type: "move_chunk", direction: "north", lat: 17.5, lon: 87.5 },
      ctx,
    );
    expect(moved.move).toEqual({ lat: 17.5, lon: 87.5 });
    expect(
      applyChunkAction(DEFAULT_SPEC, { type: "open_float", platform_id: "2901335" }, ctx).openFloat,
    ).toBe("2901335");
  });
});

describe("describeChunkSpec", () => {
  it("reports the chunk as it opens", () => {
    const state = describeChunkSpec(DEFAULT_SPEC, times, [85, 10, 90, 15], false);
    expect(state).toMatchObject({
      mounted: false,
      bbox: [85, 10, 90, 15],
      variable: "temperature",
      time: "2013-10-07",
      window: ["2013-09-25", "2013-10-24"],
      mode: "slices",
      cut: { axis: "depth", value: 80 },
      camera: "corner",
    });
    // The instrument traces were restored upstream (77f5583); the sea surface was not.
    expect(Object.keys(state.layers).sort()).toEqual(["bathy", "currents", "instruments", "scalar"]);
    expect(state.platforms).toEqual([]);
    expect(state.open_float).toBeNull();
  });

  it("reports the floats with a track here and the open cast", () => {
    const state = describeChunkSpec(DEFAULT_SPEC, times, [85, 10, 90, 15], true, ["2901335"], "2901335");
    expect(state.platforms).toEqual(["2901335"]);
    expect(state.open_float).toBe("2901335");
  });
});

describe("ChunkActionQueue", () => {
  const recorder = () => {
    const log: string[] = [];
    const controller: ChunkController = {
      getState: () => describeChunkSpec(DEFAULT_SPEC, times, [85, 10, 90, 15], true),
      apply: (a: ChunkAssistantAction) => log.push(`apply:${a.type}`),
      snapshot: () => ({ spec: DEFAULT_SPEC }),
      restore: () => log.push("restore"),
    };
    return { log, controller };
  };

  it("holds actions until a chunk is there to take them, then applies them in order", () => {
    const queue = new ChunkActionQueue();
    queue.push({ type: "show_variable", variable: "salinity" });
    queue.push({ type: "set_display", mode: "volume" });
    expect(queue.drain(null)).toBe(false);
    const { log, controller } = recorder();
    expect(queue.drain(controller)).toBe(true);
    expect(log).toEqual(["apply:show_variable", "apply:set_display"]);
    expect(queue.size).toBe(0);
  });

  it("a restore supersedes whatever was queued before it", () => {
    const queue = new ChunkActionQueue();
    queue.push({ type: "show_variable", variable: "salinity" });
    queue.pushRestore({ spec: DEFAULT_SPEC });
    const { log, controller } = recorder();
    queue.drain(controller);
    expect(log).toEqual(["restore"]);
  });
});
