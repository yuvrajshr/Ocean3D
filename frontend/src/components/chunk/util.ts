import { CMAPS, type CmapName } from "../../viz/chunk/model";
import type { ChunkSource } from "../../viz/chunk/source";
import type { CutAxis, LayerDesc } from "../../viz/chunk/spec";

/** A cmocean ramp as a CSS gradient, for swatches and the colorbar. */
export const gradient = (name: CmapName): string =>
  "linear-gradient(90deg," + CMAPS[name].join(",") + ")";

/** Values are printed at the variable's own precision, never a shared default. */
export const fmt = (v: number, dec = 2): string => v.toFixed(dec);

/** The cut the active axis exposes: which prop it writes, and in what units. */
export function cutFor(axis: CutAxis, props: LayerDesc["props"], source: ChunkSource) {
  const p = props ?? {};
  const G = source.grid;
  if (axis === "lon") {
    const value = p.sliceLon ?? (G.lon0 + G.lon1) / 2;
    return {
      key: "sliceLon" as const,
      name: "Longitude",
      min: G.lon0,
      max: G.lon1,
      step: 0.05,
      value,
      label: value.toFixed(2) + "°E",
      note: "",
    };
  }
  if (axis === "lat") {
    const value = p.sliceLat ?? (G.lat0 + G.lat1) / 2;
    return {
      key: "sliceLat" as const,
      name: "Latitude",
      min: G.lat0,
      max: G.lat1,
      step: 0.05,
      value,
      label: value.toFixed(2) + "°N",
      note: "",
    };
  }
  // The slider is continuous but the analysis is not: it has levels, and the
  // plane drawn is the nearest one. The readout names that level rather than
  // the number under the handle, so the two can never disagree on screen.
  const value = p.sliceDepth ?? 0;
  const level = G.levels[source.levelIndex(value)] ?? value;
  return {
    key: "sliceDepth" as const,
    name: "Depth",
    min: 0,
    max: G.maxDepth,
    step: 5,
    value,
    label: Math.round(level) + " m",
    note: Math.abs(level - value) > 1 ? "nearest level" : "",
  };
}
