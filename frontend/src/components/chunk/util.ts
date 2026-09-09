import { CMAPS, type CmapName } from "../../viz/chunk/model";

/** A cmocean ramp as a CSS gradient, for swatches and the colorbar. */
export const gradient = (name: CmapName): string =>
  "linear-gradient(90deg," + CMAPS[name].join(",") + ")";

/** Values are printed at the variable's own precision, never a shared default. */
export const fmt = (v: number, dec = 2): string => v.toFixed(dec);
