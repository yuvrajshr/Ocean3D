/**
 * Applying assistant actions to the layer stack.
 *
 * layerStack in App.tsx is the source of truth; an effect pushes it to the map
 * reducer via layers/sync. So an action has to produce a new stack instead of
 * dispatching to the reducer. Pure, so it's easy to test.
 */

import { describe, expect, it } from "vitest";

import { applyLayerAction, type LayerStack } from "./actions";

const base: LayerStack = {
  keys: ["temperature"],
  visibility: { temperature: true },
  opacity: { temperature: 1 },
};

describe("applyLayerAction", () => {
  it("adds a layer and hides another in one action", () => {
    const next = applyLayerAction(base, {
      type: "set_layers",
      add: ["chlorophyll"],
      remove: [],
      show: [],
      hide: ["temperature"],
      opacity: {},
    });
    expect(next.keys).toContain("chlorophyll");
    expect(next.visibility.temperature).toBe(false);
    expect(next.visibility.chlorophyll).toBe(true);
  });

  it("leaves the original stack untouched", () => {
    applyLayerAction(base, {
      type: "set_layers", add: ["salinity"], remove: [], show: [], hide: [], opacity: {},
    });
    expect(base.keys).toEqual(["temperature"]);
    expect(base.visibility.salinity).toBeUndefined();
  });

  it("puts a newly added layer on top", () => {
    // Index 0 is the top of the stack; a newly requested layer should be visible.
    const next = applyLayerAction(base, {
      type: "set_layers", add: ["chlorophyll"], remove: [], show: [], hide: [], opacity: {},
    });
    expect(next.keys[0]).toBe("chlorophyll");
  });

  it("removes a layer and forgets its visibility and opacity", () => {
    const next = applyLayerAction(base, {
      type: "set_layers", add: [], remove: ["temperature"], show: [], hide: [], opacity: {},
    });
    expect(next.keys).toEqual([]);
    expect(next.visibility.temperature).toBeUndefined();
    expect(next.opacity.temperature).toBeUndefined();
  });

  it("shows a hidden layer again", () => {
    const hidden: LayerStack = {
      keys: ["temperature"],
      visibility: { temperature: false },
      opacity: { temperature: 1 },
    };
    const next = applyLayerAction(hidden, {
      type: "set_layers", add: [], remove: [], show: ["temperature"], hide: [], opacity: {},
    });
    expect(next.visibility.temperature).toBe(true);
  });

  it("sets opacity without disturbing anything else", () => {
    const next = applyLayerAction(base, {
      type: "set_layers", add: [], remove: [], show: [], hide: [], opacity: { temperature: 0.4 },
    });
    expect(next.opacity.temperature).toBe(0.4);
    expect(next.keys).toEqual(["temperature"]);
    expect(next.visibility.temperature).toBe(true);
  });

  it("does not duplicate a layer that is already present", () => {
    const next = applyLayerAction(base, {
      type: "set_layers", add: ["temperature"], remove: [], show: [], hide: [], opacity: {},
    });
    expect(next.keys).toEqual(["temperature"]);
  });

  it("applies removes before adds, so swapping a layer stays within the cap", () => {
    const full: LayerStack = {
      keys: ["temperature", "salinity", "currents"],
      visibility: { temperature: true, salinity: true, currents: true },
      opacity: { temperature: 1, salinity: 1, currents: 1 },
    };
    const next = applyLayerAction(full, {
      type: "set_layers",
      add: ["chlorophyll"],
      remove: ["currents"],
      show: [],
      hide: [],
      opacity: {},
    });
    expect(next.keys).toHaveLength(3);
    expect(next.keys).toContain("chlorophyll");
    expect(next.keys).not.toContain("currents");
  });
});
