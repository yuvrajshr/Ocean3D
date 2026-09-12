/**
 * Static info for the chunk view: variables, names, units, colour ramps and a
 * fixed range per variable. The actual data comes from source.ts (HYCOM, ETOPO
 * and Argo through the backend).
 *
 * The fixed range is what the colour scale starts on, so the same field uses the
 * same scale everywhere; "Auto" switches to the chunk's own 2-98th percentile.
 * There's no fake fallback data: if a fetch fails, the view says so.
 */

export type VariableKey = "temperature" | "salinity" | "chlorophyll" | "speed";
export type CmapName = "thermal" | "haline" | "deep" | "delta" | "algae";

export interface VariableInfo {
  label: string;
  short: string;
  /** Fallback only; the real units come with the data. */
  unit: string;
  palette: CmapName;
  /** Fixed range the colour scale starts on. */
  range: [number, number];
  dec: number;
}

export const VARIABLES: Record<VariableKey, VariableInfo> = {
  temperature: { label: "Temperature", short: "temp", unit: "°C", palette: "thermal", range: [4, 30], dec: 2 },
  salinity: { label: "Salinity", short: "sal", unit: "PSU", palette: "haline", range: [31.4, 35.4], dec: 2 },
  chlorophyll: { label: "Chlorophyll", short: "chl", unit: "mg m⁻³", palette: "algae", range: [0, 0.9], dec: 3 },
  speed: { label: "Current speed", short: "spd", unit: "m s⁻¹", palette: "delta", range: [0, 0.9], dec: 3 },
};

/**
 * cmocean ramps as hex stops. Separate from viz/colormaps.ts because the chunk
 * view also needs ``deep`` for bathymetry, and these are used for CSS swatches as
 * well as GPU textures. Data only, never UI colours.
 */
export const CMAPS: Record<CmapName, string[]> = {
  thermal: ["#042333", "#2c3395", "#744992", "#b15f82", "#eb7958", "#fbb43d", "#e8fa5b"],
  haline: ["#2a186c", "#14439c", "#00808c", "#26a26a", "#8dc03c", "#ecf75b"],
  deep: ["#fdfdcf", "#a5dfa7", "#4ec5a5", "#2a9ab0", "#3d6ba6", "#40439a", "#3b2b6b"],
  delta: ["#112040", "#3373a3", "#8fc9d5", "#fbfbc7", "#79bf7a", "#2b6b3c", "#17301f"],
  algae: ["#d7f9d0", "#8ed58c", "#4bab5e", "#1f7a45", "#12522f", "#0b2e1c"],
};

/** An observed profile next to the model column at the same place and time. */
export interface Profile {
  /** [value, depth] pairs, surface first. */
  model: [number, number][];
  obs: [number, number][];
  lon: number;
  lat: number;
  /** Deepest level both have, in metres. */
  top: number;
  id: string;
  /** Platform type from the upstream, e.g. "argo_float". */
  type: string;
  cycle: number | null;
  /** When the profile was actually taken (usually not exactly the model time). */
  observedTime: string;
}

/** Format a date the way the view shows dates. */
export function dateLabel(iso: string): string {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
