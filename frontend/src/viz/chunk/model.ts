/**
 * What the chunk view knows before it has fetched anything.
 *
 * This file used to be a synthetic Bay of Bengal — a complete analytic ocean
 * that stood in for the real thing while the view was built. It is not that any
 * more. Every field, every seabed and every instrument track now comes from
 * `source.ts`, which is backed by HYCOM, ETOPO and Argo through the backend.
 *
 * What is left here is the part that was never data: which variables the view
 * offers, what they are called, what they are measured in, and the cmocean
 * ramps they are drawn with. A published range per variable is kept too, and it
 * is the range the colour scale opens on — deliberately, so the same field
 * reads against the same scale on every chunk and every day. The chunk's own
 * 2nd-98th percentile arrives with the data and is what "Auto" applies.
 *
 * There is no synthetic fallback and there should not be one. If a fetch fails
 * the view says so; a plausible ocean drawn in place of a failed request is the
 * one thing CONTRIBUTING §8 rules out.
 */

export type VariableKey = "temperature" | "salinity" | "chlorophyll" | "speed";
export type CmapName = "thermal" | "haline" | "deep" | "delta" | "algae";

export interface VariableInfo {
  label: string;
  short: string;
  /** Fallback only. The units actually drawn come with the data. */
  unit: string;
  palette: CmapName;
  /** The published range the colour scale opens on, not the chunk's extremes. */
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
 * cmocean family (perceptually uniform, the oceanographic standard).
 *
 * Held here as hex stops rather than reusing src/viz/colormaps.ts because the
 * chunk view needs `deep` for bathymetry, which that module does not carry, and
 * because these ramps are read straight into a CSS gradient for the palette
 * swatches as well as into a GPU lookup texture. They encode values, never
 * chrome — the chrome palette is in styles/chunk-view.css.
 */
export const CMAPS: Record<CmapName, string[]> = {
  thermal: ["#042333", "#2c3395", "#744992", "#b15f82", "#eb7958", "#fbb43d", "#e8fa5b"],
  haline: ["#2a186c", "#14439c", "#00808c", "#26a26a", "#8dc03c", "#ecf75b"],
  deep: ["#fdfdcf", "#a5dfa7", "#4ec5a5", "#2a9ab0", "#3d6ba6", "#40439a", "#3b2b6b"],
  delta: ["#112040", "#3373a3", "#8fc9d5", "#fbfbc7", "#79bf7a", "#2b6b3c", "#17301f"],
  algae: ["#d7f9d0", "#8ed58c", "#4bab5e", "#1f7a45", "#12522f", "#0b2e1c"],
};

/** An observed cast beside the model column at the same place and time. */
export interface Profile {
  /** [value, depth] pairs, surface first. */
  model: [number, number][];
  obs: [number, number][];
  lon: number;
  lat: number;
  /** Deepest level the pair share, in metres. */
  top: number;
  id: string;
  /** Upstream's platform type, e.g. "argo_float". */
  type: string;
  cycle: number | null;
  /** When the cast was actually taken, which is rarely exactly the model step. */
  observedTime: string;
}

/** A date stamp as the view writes dates. */
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
