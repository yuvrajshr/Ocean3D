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

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) search.set(k, String(v));
  }
  return search.toString();
}


// --------------------------------------------------------------- 2D map view

/** A grid described analytically. Four numbers and a count cannot drift out of
 *  step with the payload the way two parallel axis arrays can. */
export interface GridDescriptor {
  lat0: number;
  dlat: number;
  n_lat: number;
  lon0: number;
  dlon: number;
  n_lon: number;
}

export interface MapLayerInfo {
  id: string;
  label: string;
  provider: string;
  attribution: string;
  units: string;
  units_declared_by_us: boolean;
  kind: "volume" | "surface" | "vector";
  colormap: ColormapName;
  caption: string;
  /** Empty for a surface field. Emptiness is what removes the depth ruler. */
  depth_levels: number[];
  lat_range: [number, number];
  lon_range: [number, number];
  native_shape: [number, number];
  time_start: string;
  time_end: string;
  cadence: string;
  cadence_days: number;
  has_vectors: boolean;
  regional: boolean;
}

export interface MapTimeAxis {
  dataset: string;
  cadence: string;
  cadence_days: number;
  count: number;
  start: string;
  end: string;
  times: string[];
  truncated: boolean;
  source: SourceStatus;
}

export interface MapSliceMeta {
  dataset: string;
  label: string;
  time: string;
  depth: number | null;
  grid: GridDescriptor;
  shape: [number, number];
  stride: number;
  data_url: string;
  units: string;
  units_declared_by_us: boolean;
  colormap: ColormapName;
  value_range: [number, number];
  full_range: [number, number];
  clipped: boolean;
  attribution: string;
  source: SourceStatus;
}

export interface MapVectorField {
  u: Float32Array;
  v: Float32Array;
  nLat: number;
  nLon: number;
  stride: number;
}

export interface MapPointBlock {
  dataset: string;
  label: string;
  units: string;
  units_declared_by_us: boolean;
  colormap: ColormapName;
  lat: number;
  lon: number;
  grid_lat: number;
  grid_lon: number;
  offset_km: number;
  depths: number[];
  times: string[];
  /** Flat, C order (depth, time). null is no data. */
  values: (number | null)[];
  value_range: [number, number];
  full_range: [number, number];
  clipped: boolean;
  source: SourceStatus;
}

/** Declared as a type alias, not an interface, on purpose: TypeScript only
 *  gives implicit index signatures to aliases, and these are passed to
 *  `query()` which takes a Record. */
export type MapSliceBounds = {
  lat_min?: number;
  lat_max?: number;
  lon_min?: number;
  lon_max?: number;
  stride?: number;
};

export type MapSliceParams = { dataset: string; time: string; depth?: number } & MapSliceBounds;

export type MapPointParams = {
  dataset: string;
  lat: number;
  lon: number;
  time_start: string;
  time_end: string;
  surface_only?: boolean;
};

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
  // ------------------------------------------------------------- 2D map view

  mapCatalogue: (signal?: AbortSignal) => getJson<MapLayerInfo[]>("/map/catalogue", signal),

  mapTimes: (dataset: string, signal?: AbortSignal) =>
    getJson<MapTimeAxis>(`/map/times?${query({ dataset })}`, signal),

  mapSliceMeta: (
    params: MapSliceParams,
    signal?: AbortSignal,
  ) => getJson<MapSliceMeta>(`/map/slice/meta?${query(params)}`, signal),

  /** Raw Float32, C order (lat, lon), latitude ascending. NaN is land or no data. */
  async mapSliceData(meta: MapSliceMeta, signal?: AbortSignal): Promise<Float32Array> {
    const response = await fetch(meta.data_url, { signal });
    if (!response.ok) {
      throw new ApiError(`Could not load ${meta.label.toLowerCase()} values.`, response.status);
    }
    const values = new Float32Array(await response.arrayBuffer());
    const expected = meta.shape[0] * meta.shape[1];
    if (values.length !== expected) {
      // Worth failing loudly: a mismatch here draws a plausible-looking map of
      // the wrong shape rather than an obvious error.
      throw new ApiError(
        `${meta.label} returned ${values.length} values, expected ${expected}.`,
        502,
      );
    }
    return values;
  },

  /** u then v, two Float32 planes on one grid. Direction is the payload. */
  async mapVectorData(
    params: MapSliceParams,
    signal?: AbortSignal,
  ): Promise<MapVectorField> {
    const response = await fetch(`${BASE}/map/vector/data?${query(params)}`, { signal });
    if (!response.ok) {
      throw new ApiError("Could not load current direction.", response.status);
    }
    const shape = (response.headers.get("X-Map-Shape") ?? "0,0").split(",").map(Number);
    const stride = Number(response.headers.get("X-Map-Stride") ?? 1);
    const all = new Float32Array(await response.arrayBuffer());
    const n = (shape[0] ?? 0) * (shape[1] ?? 0);
    return {
      u: all.subarray(0, n),
      v: all.subarray(n, 2 * n),
      nLat: shape[0] ?? 0,
      nLon: shape[1] ?? 0,
      stride,
    };
  },

  mapPoint: (
    params: MapPointParams,
    signal?: AbortSignal,
  ) => getJson<MapPointBlock>(`/map/point?${query(params)}`, signal),
};
