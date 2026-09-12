/**
 * Typed client for the backend. The browser can't call ERDDAP directly (no
 * CORS), so everything goes through /api.
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
  /** Colour scale range (percentile-clipped). */
  value_range: [number, number];
  /** Actual min/max before clipping. */
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
  /** Blue Marble month for the globe (a key of BASEMAPS in viz/globe). */
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

export interface ChunkMeta {
  /** The chunk view's variable key, not the upstream's name. */
  variable: string;
  /** The dataset that actually served it. Shown on screen. */
  dataset: string;
  label: string;
  time: string;
  /** (lon_min, lat_min, lon_max, lat_max), snapped to the tile grid by the server. */
  bbox: [number, number, number, number];
  depth_levels: number[];
  grid: { lat: number[]; lon: number[] };
  /** (depth, lat, lon). Surface fields have a depth axis of 1. */
  shape: [number, number, number];
  stride: number;
  kind: "volume" | "surface" | "vector";
  data_url: string;
  /** Only set when the upstream has 3D current direction. */
  vector_url: string | null;
  units: string;
  units_declared_by_us: boolean;
  colormap: ColormapName;
  value_range: [number, number];
  full_range: [number, number];
  clipped: boolean;
  provider: string;
  attribution: string;
  source: SourceStatus;
}

/** u and v over the whole chunk, on the scalar field's grid. */
export interface ChunkVectorField {
  u: Float32Array;
  v: Float32Array;
  shape: [number, number, number];
}

export type ChunkParams = {
  variable: string;
  time: string;
  lon_min: number;
  lat_min: number;
};

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

/** Errors carry the backend's message, which is written to be shown to users. */
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
      /* body wasn't JSON; keep the generic message */
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


// --- 2D map ---

/**
 * Grid as start, step and count, which can't get out of sync with the data
 * the way two separate axis arrays can.
 */
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
  /** Empty for surface fields (hides the depth ruler). */
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
  /** The UI variable this dataset serves. Each view picks its own best dataset. */
  variable_key: string;
  /** Lower wins when several datasets serve the same variable. */
  preference: number;
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
  /** Flat, (depth, time). null = no data. */
  values: (number | null)[];
  value_range: [number, number];
  full_range: [number, number];
  clipped: boolean;
  source: SourceStatus;
}

/**
 * A type alias, not an interface: only aliases get implicit index signatures,
 * and query() takes a Record.
 */
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

  /** Raw Float32, (depth, lat, lon). NaN = land / no data. */
  async fieldData(meta: FieldMeta, signal?: AbortSignal): Promise<Float32Array> {
    const response = await fetch(meta.data_url, { signal });
    if (!response.ok) {
      throw new ApiError(`Could not load ${meta.label.toLowerCase()} values.`, response.status);
    }
    const buffer = await response.arrayBuffer();
    return new Float32Array(buffer);
  },

  /** All four bounds or none; none gives the default Bay of Bengal box. */
  terrainMeta: (
    params?: { lat_min: number; lat_max: number; lon_min: number; lon_max: number; stride?: number },
    signal?: AbortSignal,
  ) => getJson<TerrainMeta>(params ? `/terrain/meta?${query(params)}` : "/terrain/meta", signal),

  /** Raw Float32 elevation in metres, (lat, lon); positive is land. */
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
    params: {
      cycle?: number;
      time_start?: string;
      time_end?: string;
      lat_min?: number;
      lat_max?: number;
      lon_min?: number;
      lon_max?: number;
    },
    signal?: AbortSignal,
  ) => getJson<InstrumentProfile>(`/instruments/${platformId}/profile?${query(params)}`, signal),

  compare: (
    params: { platform_id: string; variable?: string; cycle?: number },
    signal?: AbortSignal,
  ) => getJson<Comparison>(`/compare?${query(params)}`, signal),
  // --- 2D map ---

  mapCatalogue: (signal?: AbortSignal) => getJson<MapLayerInfo[]>("/map/catalogue", signal),

  mapTimes: (dataset: string, signal?: AbortSignal) =>
    getJson<MapTimeAxis>(`/map/times?${query({ dataset })}`, signal),

  mapSliceMeta: (
    params: MapSliceParams,
    signal?: AbortSignal,
  ) => getJson<MapSliceMeta>(`/map/slice/meta?${query(params)}`, signal),

  /** Raw Float32, (lat, lon), latitude ascending. NaN = land or no data. */
  async mapSliceData(meta: MapSliceMeta, signal?: AbortSignal): Promise<Float32Array> {
    const response = await fetch(meta.data_url, { signal });
    if (!response.ok) {
      throw new ApiError(`Could not load ${meta.label.toLowerCase()} values.`, response.status);
    }
    const values = new Float32Array(await response.arrayBuffer());
    const expected = meta.shape[0] * meta.shape[1];
    if (values.length !== expected) {
      // Fail loudly: a size mismatch would otherwise draw a wrong-shaped map that
      // looks fine.
      throw new ApiError(
        `${meta.label} returned ${values.length} values, expected ${expected}.`,
        502,
      );
    }
    return values;
  },

  /** u then v, two Float32 planes on the same grid. */
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

  chunkMeta: (params: ChunkParams, signal?: AbortSignal) =>
    getJson<ChunkMeta>(`/chunk/meta?${query(params)}`, signal),

  /**
   * Raw Float32, (depth, lat, lon). NaN = land, seabed or no data. Length is checked
   * against the metadata for the same reason as mapSliceData.
   */
  async chunkData(meta: ChunkMeta, signal?: AbortSignal): Promise<Float32Array> {
    const response = await fetch(meta.data_url, { signal });
    if (!response.ok) {
      throw new ApiError(`Could not load ${meta.label.toLowerCase()} for this chunk.`, response.status);
    }
    const values = new Float32Array(await response.arrayBuffer());
    const expected = meta.shape[0] * meta.shape[1] * meta.shape[2];
    if (values.length !== expected) {
      throw new ApiError(
        `${meta.label} returned ${values.length} values, expected ${expected}.`,
        502,
      );
    }
    return values;
  },

  /** Two Float32 volumes, u then v. */
  async chunkVector(meta: ChunkMeta, signal?: AbortSignal): Promise<ChunkVectorField> {
    if (!meta.vector_url) {
      throw new ApiError(`${meta.label} carries no current direction.`, 400);
    }
    const response = await fetch(meta.vector_url, { signal });
    if (!response.ok) {
      throw new ApiError("Could not load current direction for this chunk.", response.status);
    }
    const all = new Float32Array(await response.arrayBuffer());
    const n = meta.shape[0] * meta.shape[1] * meta.shape[2];
    if (all.length !== 2 * n) {
      throw new ApiError(
        `Current direction returned ${all.length} values, expected ${2 * n}.`,
        502,
      );
    }
    return { u: all.subarray(0, n), v: all.subarray(n, 2 * n), shape: meta.shape };
  },

  mapPoint: (
    params: MapPointParams,
    signal?: AbortSignal,
  ) => getJson<MapPointBlock>(`/map/point?${query(params)}`, signal),
};
