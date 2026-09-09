/**
 * The chunk view's ocean model.
 *
 * A synthetic but oceanographically plausible Bay of Bengal chunk: 85–90°E,
 * 10–15°N, 0–2000 m, 30 daily steps. Pure analytic — no I/O. Every field is
 * f(lon, lat, depth, timeIndex), so any slice, section, isosurface or histogram
 * the view asks for is computed on demand and nothing has to be fetched,
 * cached or invalidated.
 *
 * This is the chunk view's own model, deliberately separate from the live
 * ERDDAP/Copernicus path the rest of the app uses. It exists so the chunk
 * view's rendering, interaction and layer registry can be developed and
 * verified against a field whose true shape is known exactly — a rendering bug
 * is unmistakable when you already know where the thermocline is. Swapping it
 * for real data is a matter of replacing the accessors below; the registry and
 * the view read only through them.
 */

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

/** Normalized 0..1 ramp between a and b. */
const ramp = (a: number, b: number, x: number): number => clamp((x - a) / (b - a), 0, 1);

/** Smoothstep. Used everywhere a feature has to fade in over a distance. */
const smooth = (a: number, b: number, x: number): number => {
  const t = ramp(a, b, x);
  return t * t * (3 - 2 * t);
};

export interface Grid {
  nx: number;
  ny: number;
  nz: number;
  lon0: number;
  lon1: number;
  lat0: number;
  lat1: number;
  maxDepth: number;
  nt: number;
  start: string;
}

export const GRID: Grid = {
  nx: 60,
  ny: 60,
  nz: 50,
  lon0: 85,
  lon1: 90,
  lat0: 10,
  lat1: 15,
  maxDepth: 2000,
  nt: 30,
  start: "2026-03-01",
};

/**
 * Non-uniform depth levels — finer near the surface, as in an operational
 * model. The exponent puts roughly half the levels in the top 500 m, which is
 * where the mixed layer and thermocline live.
 */
export const LEVELS: number[] = Array.from(
  { length: GRID.nz },
  (_, k) => +(GRID.maxDepth * Math.pow(k / (GRID.nz - 1), 1.9)).toFixed(2),
);

export type VariableKey = "temperature" | "salinity" | "chlorophyll" | "speed";
export type CmapName = "thermal" | "haline" | "deep" | "delta" | "algae";

export interface VariableInfo {
  label: string;
  short: string;
  unit: string;
  palette: CmapName;
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

export const lonAt = (i: number): number =>
  GRID.lon0 + (GRID.lon1 - GRID.lon0) * (i / (GRID.nx - 1));
export const latAt = (j: number): number =>
  GRID.lat0 + (GRID.lat1 - GRID.lat0) * (j / (GRID.ny - 1));

/** Mesoscale eddy, translating slowly westward over the 30-day window. */
export function eddy(t: number): { lon: number; lat: number; r: number } {
  return { lon: 88.35 - 0.018 * t, lat: 12.65 + 0.01 * t, r: 1.3 };
}

/** Shelf weight: 1 on the western shelf, 0 offshore. */
const shelfW = (lon: number): number => 1 - smooth(85.1, 86.6, lon);

export function bathymetry(lon: number, lat: number): number {
  let d = 70 + 1930 * smooth(85.15, 86.55, lon);
  d += 130 * Math.sin((lat - 10) * 1.25) * smooth(85.4, 87, lon);
  d -= 480 * Math.exp(-Math.pow((lon - 88.7) / 0.7, 2) - Math.pow((lat - 11.15) / 0.7, 2)); // seamount
  d -= 90 * Math.cos((lon - 85) * 1.6) * Math.cos((lat - 10) * 1.9);
  return clamp(d, 45, GRID.maxDepth);
}

export function temperature(lon: number, lat: number, d: number, t: number): number {
  let T: number;
  if (d <= 50) T = 29.1 - 0.006 * d;
  else if (d <= 200) T = 12 + 16.8 * Math.exp(-(d - 50) / 62);
  else T = 4 + 9.49 * Math.exp(-(d - 200) / 520);
  const e = eddy(t);
  const r2 = Math.pow((lon - e.lon) / e.r, 2) + Math.pow((lat - e.lat) / e.r, 2);
  const core = Math.exp(-r2);
  T += 3.2 * core * Math.exp(-Math.pow((d - 110) / 95, 2)) + 0.5 * core * Math.exp(-d / 40);
  T -= 2.6 * shelfW(lon) * Math.exp(-d / 160);
  T -= 0.28 * (lat - 12.5) * Math.exp(-d / 130);
  return T;
}

export function salinity(lon: number, lat: number, d: number, t: number): number {
  let S =
    34.95 -
    2.95 * Math.exp(-d / 46) +
    0.34 * Math.exp(-Math.pow((d - 150) / 62, 2)) -
    0.12 * smooth(1200, 2000, d);
  // Ganges–Brahmaputra freshwater plume in the north-east corner.
  const plume = Math.exp(-Math.pow((lon - 89.3) / 1.5, 2) - Math.pow((lat - 14.4) / 1.6, 2));
  S -= 1.5 * plume * Math.exp(-d / 32);
  const e = eddy(t);
  const core = Math.exp(-(Math.pow((lon - e.lon) / e.r, 2) + Math.pow((lat - e.lat) / e.r, 2)));
  S += 0.26 * core * Math.exp(-Math.pow((d - 145) / 85, 2));
  return S;
}

export function chlorophyll(lon: number, _lat: number, d: number, _t: number): number {
  let C = 0.045 + 0.6 * Math.exp(-Math.pow((d - 55) / 38, 2));
  C *= 1 + 2.3 * shelfW(lon) * Math.exp(-d / 90);
  C += 0.02 * Math.exp(-d / 400);
  return C;
}

/** Horizontal velocity (u east, v north) in m/s. */
export function velocity(lon: number, lat: number, d: number, t: number): [number, number] {
  const e = eddy(t);
  const dx = lon - e.lon;
  const dy = lat - e.lat;
  const r = Math.hypot(dx, dy) + 1e-6;
  const g = Math.exp(-Math.pow(r / 1.35, 2)) * Math.min(r / 0.85, 1);
  const amp = 0.9 * Math.exp(-d / 430);
  let u = -amp * g * (dy / r);
  let v = amp * g * (dx / r);
  // Western boundary current, hugging the shelf edge.
  const cb = Math.exp(-Math.pow((lon - 85.65) / 0.55, 2)) * Math.exp(-d / 260);
  v += 0.6 * cb;
  u += 0.055 * Math.exp(-d / 300);
  return [u, v];
}

export function value(name: VariableKey, lon: number, lat: number, d: number, t: number): number {
  switch (name) {
    case "salinity":
      return salinity(lon, lat, d, t);
    case "chlorophyll":
      return chlorophyll(lon, lat, d, t);
    case "speed": {
      const [u, v] = velocity(lon, lat, d, t);
      return Math.hypot(u, v);
    }
    default:
      return temperature(lon, lat, d, t);
  }
}

/* ---------- gridded extraction ---------- */

/**
 * RGBA float payload for a constant-depth slice.
 * R = value (bathymetry-filled), G = 1 inside water, 0 below the seafloor.
 * The shader discards on G, so the field stops exactly at the seabed instead of
 * being smeared through rock.
 */
export function levelTexture(name: VariableKey, depth: number, t: number): Float32Array {
  const { nx, ny } = GRID;
  const a = new Float32Array(nx * ny * 4);
  for (let j = 0; j < ny; j++) {
    const lat = latAt(j);
    for (let i = 0; i < nx; i++) {
      const lon = lonAt(i);
      const floor = bathymetry(lon, lat);
      const dd = Math.min(depth, floor);
      const o = (j * nx + i) * 4;
      a[o] = value(name, lon, lat, dd, t);
      a[o + 1] = depth <= floor ? 1 : 0;
    }
  }
  return a;
}

export interface SectionPayload {
  data: Float32Array;
  width: number;
  height: number;
}

/**
 * axis 'lon' -> constant-longitude section (varies with latitude)
 * axis 'lat' -> constant-latitude section (varies with longitude)
 * f = 0..1 position of the plane along its fixed axis.
 */
export function sectionTexture(
  name: VariableKey,
  axis: "lon" | "lat",
  f: number,
  t: number,
): SectionPayload {
  const { nx, ny, nz } = GRID;
  const n = axis === "lon" ? ny : nx;
  const a = new Float32Array(n * nz * 4);
  for (let k = 0; k < nz; k++) {
    const depth = LEVELS[k]!;
    for (let i = 0; i < n; i++) {
      const lon = axis === "lon" ? GRID.lon0 + 5 * f : lonAt(i);
      const lat = axis === "lon" ? latAt(i) : GRID.lat0 + 5 * f;
      const floor = bathymetry(lon, lat);
      const o = (k * n + i) * 4;
      a[o] = value(name, lon, lat, Math.min(depth, floor), t);
      a[o + 1] = depth <= floor ? 1 : 0;
    }
  }
  return { data: a, width: n, height: nz };
}

/**
 * Depth (m) of an iso-value, per horizontal cell. -1 where the surface does not
 * exist — the shallowest crossing wins, and cells with no crossing are left out
 * of the mesh entirely rather than pinned to the seabed.
 */
export function isoDepthField(name: VariableKey, target: number, t: number): Float32Array {
  const { nx, ny, nz } = GRID;
  const out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const lat = latAt(j);
    for (let i = 0; i < nx; i++) {
      const lon = lonAt(i);
      const floor = bathymetry(lon, lat);
      let found = -1;
      let prevV = value(name, lon, lat, LEVELS[0]!, t);
      let prevD = LEVELS[0]!;
      for (let k = 1; k < nz; k++) {
        const d = LEVELS[k]!;
        if (d > floor) break;
        const v = value(name, lon, lat, d, t);
        if ((prevV - target) * (v - target) <= 0 && prevV !== v) {
          found = prevD + ((target - prevV) / (v - prevV)) * (d - prevD);
          break;
        }
        prevV = v;
        prevD = d;
      }
      out[j * nx + i] = found;
    }
  }
  return out;
}

export interface Histogram {
  counts: number[];
  lo: number;
  hi: number;
  max: number;
}

/**
 * Value distribution over the whole chunk, subsampled. It backs the colour
 * range editor: the range handles sit on the real distribution, so clipping is
 * a visible decision rather than a guess at two numbers.
 */
export function histogram(name: VariableKey, t: number, bins = 48): Histogram {
  const counts: number[] = new Array(bins).fill(0);
  let lo = Infinity;
  let hi = -Infinity;
  const vals: number[] = [];
  for (let k = 0; k < GRID.nz; k += 2) {
    const d = LEVELS[k]!;
    for (let j = 0; j < GRID.ny; j += 3) {
      const lat = latAt(j);
      for (let i = 0; i < GRID.nx; i += 3) {
        const lon = lonAt(i);
        if (d > bathymetry(lon, lat)) continue;
        const v = value(name, lon, lat, d, t);
        vals.push(v);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  if (!vals.length) return { counts, lo: 0, hi: 1, max: 1 };
  const span = hi - lo || 1;
  for (const v of vals) {
    const b = Math.min(bins - 1, Math.floor(((v - lo) / span) * bins));
    counts[b] = counts[b]! + 1;
  }
  return { counts, lo, hi, max: Math.max(...counts) };
}

/* ---------- instruments ---------- */

const hash = (n: number): number => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** p = phase within a 10-day Argo cycle: descent, park at 1000 m, dive, rise. */
function argoDepth(p: number): number {
  if (p < 0.3) return (p / 0.3) * 1000;
  if (p < 8.5) return 1000 + 12 * Math.sin(p * 2.2);
  if (p < 8.85) return 1000 + ((p - 8.5) / 0.35) * 1000;
  if (p < 9.55) return 2000 * (1 - (p - 8.85) / 0.7);
  return 0;
}

/** p = phase within a 0.5-day glider yo. */
function gliderDepth(p: number): number {
  return p < 0.25 ? (p / 0.25) * 700 : 700 * (1 - (p - 0.25) / 0.25);
}

export type PlatformType = "argo" | "glider";

interface Seed {
  id: string;
  type: PlatformType;
  lon: number;
  lat: number;
  phase: number;
  drift: [number, number];
}

const SEEDS: Seed[] = [
  { id: "ARGO-2903471", type: "argo", lon: 87.4, lat: 11.6, phase: 1.2, drift: [0.021, 0.013] },
  { id: "ARGO-2903618", type: "argo", lon: 88.9, lat: 13.4, phase: 5.6, drift: [-0.016, 0.019] },
  { id: "ARGO-5906204", type: "argo", lon: 86.3, lat: 14.1, phase: 8.1, drift: [0.028, -0.022] },
  { id: "SG-INCOIS-04", type: "glider", lon: 86.1, lat: 10.7, phase: 0, drift: [0.048, 0.038] },
];

const seedOf = (id: string): Seed => SEEDS.find((x) => x.id === id) ?? SEEDS[0]!;

export function instrumentAt(inst: string, day: number): { lon: number; lat: number } {
  const s = seedOf(inst);
  const lon = s.lon + s.drift[0] * day + 0.16 * Math.sin(day / 5.5 + s.phase);
  const lat = s.lat + s.drift[1] * day + 0.13 * Math.cos(day / 6.5 + s.phase);
  return { lon: clamp(lon, 85.05, 89.95), lat: clamp(lat, 10.05, 14.95) };
}

export interface Instrument {
  id: string;
  type: PlatformType;
  /** [lon, lat, depth, day] along the whole 30-day track. */
  points: [number, number, number, number][];
  maxDepth: number;
}

export function instruments(): Instrument[] {
  return SEEDS.map((s) => {
    const pts: [number, number, number, number][] = [];
    const step = s.type === "argo" ? 0.04 : 0.008;
    for (let day = 0; day <= GRID.nt; day += step) {
      const { lon, lat } = instrumentAt(s.id, day);
      const depth =
        s.type === "argo" ? argoDepth((day + s.phase) % 10) : gliderDepth((day + s.phase) % 0.5);
      pts.push([lon, lat, Math.min(depth, bathymetry(lon, lat) - 5), day]);
    }
    return { id: s.id, type: s.type, points: pts, maxDepth: s.type === "argo" ? 2000 : 700 };
  });
}

/** Sample points of the most recent profiles before `day`. */
export function profileSamples(inst: string, day: number): [number, number, number][] {
  const s = seedOf(inst);
  const out: [number, number, number][] = [];
  const period = s.type === "argo" ? 10 : 0.5;
  const cycles = s.type === "argo" ? 3 : 12;
  for (let c = 0; c < cycles; c++) {
    const base = day - c * period;
    if (base < 0) break;
    const n = s.type === "argo" ? 22 : 12;
    for (let q = 0; q <= n; q++) {
      const dd = (s.type === "argo" ? 2000 : 700) * Math.pow(q / n, 1.6);
      const p = instrumentAt(s.id, base);
      out.push([p.lon, p.lat, Math.min(dd, bathymetry(p.lon, p.lat) - 5)]);
    }
  }
  return out;
}

export interface Profile {
  /** [value, depth] pairs, surface first. */
  model: [number, number][];
  obs: [number, number][];
  lon: number;
  lat: number;
  top: number;
  id: string;
  type: PlatformType;
}

/**
 * Observation against model at identical lat/lon/time — the comparison the
 * platform exists for. The instrument carries a deliberate bias (a warmer,
 * fresher mixed layer and a thermocline sitting shallower than the model's) so
 * the two curves separate where a real one usually does.
 */
export function profile(inst: string, day: number, name: VariableKey): Profile {
  const s = seedOf(inst);
  const t = clamp(Math.round(day), 0, GRID.nt - 1);
  const p = instrumentAt(s.id, day);
  const floor = bathymetry(p.lon, p.lat);
  const top = Math.min(s.type === "argo" ? 2000 : 700, floor);
  const model: [number, number][] = [];
  const obs: [number, number][] = [];
  const N = 70;
  const seed = s.id.length * 7 + name.length * 13 + t * 3;
  for (let q = 0; q <= N; q++) {
    const d = top * Math.pow(q / N, 1.7);
    const m = value(name, p.lon, p.lat, d, t);
    model.push([m, d]);
    const shifted = value(name, p.lon, p.lat, Math.min(d * 1.22 + 12, floor), t);
    let o = shifted * 0.85 + m * 0.15;
    const scale = name === "salinity" ? 0.16 : name === "chlorophyll" ? 0.05 : 0.9;
    o += scale * (0.55 * Math.exp(-d / 60) + 0.9 * Math.exp(-Math.pow((d - 130) / 90, 2)));
    o += scale * 0.42 * (hash(seed + q * 1.7) - 0.5);
    obs.push([o, d]);
  }
  return { model, obs, lon: p.lon, lat: p.lat, top, id: s.id, type: s.type };
}

export function dateLabel(i: number): string {
  const d = new Date(Date.UTC(2026, 2, 1 + i));
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
