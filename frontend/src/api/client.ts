/**
 * Typed client for the ocean-viz backend.
 *
 * The browser never calls erddap.incois.gov.in directly — it sends no CORS
 * headers. Everything here goes through the FastAPI translator on /api.
 */

import type { ColormapName } from "../viz/colormaps";

export type Provenance = "live" | "cached" | "fixture";

export interface SourceStatus {
  provenance: Provenance;
  fetched_at: string;
  upstream: string;
  note?: string | null;
}

export interface VariableInfo {
  key: string;
  label: string;
  units: string;
  units_declared_by_us: boolean;
  kind: "volume" | "surface" | "vector";
  colormap: ColormapName;
  caption: string;
  group: "primary" | "hazard";
  available: boolean;
  unavailable_reason: string | null;
}

export interface FieldMeta {
  variable: string;
  label: string;
  time: string;
  depth_levels: number[];
  grid: { lat: number[]; lon: number[] };
  data_url: string;
  units: string;
  units_declared_by_us: boolean;
  /** Range the colour scale spans — percentile-clipped against outliers. */
  value_range: [number, number];
  /** True extremes in the data, before clipping. */
  full_range: [number, number];
  clipped: boolean;
  colormap: ColormapName;
  kind: string;
  shape: number[];
  source: SourceStatus;
}

export interface PlatformSummary {
  platform_id: string;
  platform_type: string;
  lat: number;
  lon: number;
  time: string;
  cycle_number: number | null;
  n_levels: number;
  max_depth: number | null;
  surface_temperature: number | null;
}

export interface InstrumentList {
  platforms: PlatformSummary[];
  source: SourceStatus;
  rejected_by_qc: number;
}

export interface ProfileLevel {
  depth: number;
  temperature: number | null;
  salinity: number | null;
  chlorophyll: number | null;
}

export interface InstrumentProfile {
  platform_id: string;
  platform_type: string;
  cycle_number: number | null;
  lat: number;
  lon: number;
  time: string;
  profile: ProfileLevel[];
  max_depth: number | null;
  source: SourceStatus;
}

export interface Scenario {
  key: string;
  title: string;
  summary: string;
  time_start: string;
  time_end: string;
  focus_time: string;
  lat_range: [number, number];
  lon_range: [number, number];
  featured_platforms: string[];
  /** Which bundled Blue Marble month the globe shows — a key of BASEMAPS in viz/globe. */
  basemap: string;
  timesteps: string[];
}

export interface ComparePoint {
  depth: number;
  value: number;
}

export interface Comparison {
  variable: string;
  units: string;
  platform_id: string;
  cycle_number: number | null;
  observed_time: string;
  model_time: string;
  lat: number;
  lon: number;
  observed: ComparePoint[];
  model: ComparePoint[];
  residual: ComparePoint[];
  grid_point: { lat: number; lon: number; offset_km: number; resolution_deg: number };
  extent: { lat: number[]; lon: number[] };
  source: SourceStatus;
}

export interface TerrainMeta {
  lat_range: [number, number];
  lon_range: [number, number];
  lat: number[];
  lon: number[];
  shape: [number, number];
  stride_arcmin: number;
  units: string;
  data_url: string;
  attribution: string;
  min_elevation: number;
  max_elevation: number;
  land_fraction: number;
  n_lat: number;
  n_lon: number;
  source: SourceStatus;
}

export interface Health {
  status: string;
  upstream_ok: boolean;
  detail: string;
  default_scenario: string;
}

const BASE = "/api";

/** Errors carry the backend's own message, which is written to be shown to a
 *  person: it says what happened and what to do (context.md §5.3). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { signal });
  if (!response.ok) {
    let detail = `Request failed (${response.status}).`;
    try {
      const body = await response.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      /* non-JSON error body; keep the generic message */
    }
    throw new ApiError(detail, response.status);
  }
  return (await response.json()) as T;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) search.set(k, String(v));
  }
  return search.toString();
}

export const api = {
  health: (signal?: AbortSignal) => getJson<Health>("/health", signal),

  variables: (signal?: AbortSignal) => getJson<VariableInfo[]>("/variables", signal),

  scenarios: (signal?: AbortSignal) => getJson<Scenario[]>("/scenarios", signal),

  fieldMeta: (
    params: { variable: string; time: string; lat_min?: number; lat_max?: number; lon_min?: number; lon_max?: number },
    signal?: AbortSignal,
  ) => getJson<FieldMeta>(`/field/meta?${query(params)}`, signal),

  /** Raw Float32 values, C order (depth, lat, lon). NaN marks land / no data. */
  async fieldData(meta: FieldMeta, signal?: AbortSignal): Promise<Float32Array> {
    const response = await fetch(meta.data_url, { signal });
    if (!response.ok) {
      throw new ApiError(`Could not load ${meta.label.toLowerCase()} values.`, response.status);
    }
    const buffer = await response.arrayBuffer();
    return new Float32Array(buffer);
  },

  terrainMeta: (signal?: AbortSignal) => getJson<TerrainMeta>("/terrain/meta", signal),

  /** Raw Float32 elevation in metres, C order (lat, lon); positive is land. */
  async terrainData(meta: TerrainMeta, signal?: AbortSignal): Promise<Float32Array> {
    const response = await fetch(meta.data_url, { signal });
    if (!response.ok) {
      throw new ApiError("Could not load the seafloor relief.", response.status);
    }
    return new Float32Array(await response.arrayBuffer());
  },

  instruments: (
    params: { time_start?: string; time_end?: string; lat_min?: number; lat_max?: number; lon_min?: number; lon_max?: number },
    signal?: AbortSignal,
  ) => getJson<InstrumentList>(`/instruments?${query(params)}`, signal),

  profile: (
    platformId: string,
    params: { cycle?: number; time_start?: string; time_end?: string },
    signal?: AbortSignal,
  ) => getJson<InstrumentProfile>(`/instruments/${platformId}/profile?${query(params)}`, signal),

  compare: (
    params: { platform_id: string; variable?: string; cycle?: number },
    signal?: AbortSignal,
  ) => getJson<Comparison>(`/compare?${query(params)}`, signal),
};
