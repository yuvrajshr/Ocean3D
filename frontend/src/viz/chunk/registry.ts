/**
 * Layer registry: a scene-spec `type` resolves to a renderer module.
 *
 * A new sensor or model variable is a descriptor in the spec plus a factory
 * here. The view never changes — it only iterates the spec, asks the registry
 * for a module per descriptor, and calls `update` with the global context. A
 * type with no module is reported, not fatal.
 *
 * Each factory returns a handle owning exactly one THREE.Group, and is
 * responsible for disposing every geometry, material and texture it made. The
 * view rebuilds a handle whenever its type or the depth axis changes, so a
 * factory may bake the axis into its geometry.
 */

import * as THREE from "three";

import {
  CMAPS,
  GRID,
  LEVELS,
  bathymetry as bathymetryAt,
  instrumentAt,
  instruments as instrumentList,
  isoDepthField,
  latAt,
  levelTexture,
  lonAt,
  profileSamples,
  sectionTexture,
  velocity,
  type CmapName,
  type VariableKey,
} from "./model";
import type { DepthAxis, LayerDesc, ScalarMode } from "./spec";

/* ---------------- colormaps ---------------- */

/** A cmocean ramp as a 256×1 GPU lookup texture. */
export function makeCmapTexture(stops: string[]): THREE.DataTexture {
  const n = 256;
  const data = new Uint8Array(n * 4);
  const rgb = stops.map((h) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ]);
  for (let i = 0; i < n; i++) {
    const f = (i / (n - 1)) * (rgb.length - 1);
    const a = rgb[Math.floor(f)]!;
    const b = rgb[Math.min(rgb.length - 1, Math.floor(f) + 1)]!;
    const m = f - Math.floor(f);
    data[i * 4] = a[0]! + (b[0]! - a[0]!) * m;
    data[i * 4 + 1] = a[1]! + (b[1]! - a[1]!) * m;
    data[i * 4 + 2] = a[2]! + (b[2]! - a[2]!) * m;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** The same ramp on the CPU, for the histogram bars and the swatches. */
export function sampleCmap(stops: string[], t: number): [number, number, number] {
  const rgb = stops.map((h) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ]);
  const f = Math.max(0, Math.min(1, t)) * (rgb.length - 1);
  const a = rgb[Math.floor(f)]!;
  const b = rgb[Math.min(rgb.length - 1, Math.floor(f) + 1)]!;
  const m = f - Math.floor(f);
  return [
    a[0]! + (b[0]! - a[0]!) * m,
    a[1]! + (b[1]! - a[1]!) * m,
    a[2]! + (b[2]! - a[2]!) * m,
  ];
}

/* ---------------- context and handles ---------------- */

/** Grid fraction (0..1) to world position, and depth to normalized height. */
export interface GeoMap {
  x(f: number): number;
  z(f: number): number;
  yn(d: number): number;
}

export interface GlobalContext {
  variable: VariableKey;
  sliceDepth: number;
  timeIndex: number;
  colorMin: number;
  colorMax: number;
  scale: "linear" | "log";
  cmapTex: THREE.DataTexture;
  palette: CmapName;
  height: number;
  depthAxis: DepthAxis;
}

export interface LayerContext {
  geo: GeoMap;
  global: GlobalContext;
}

/** A descriptor with its optional fields resolved, as the view passes it down. */
export type ResolvedDesc = LayerDesc & { opacity: number };

export interface LayerHandle {
  group: THREE.Group;
  pickables?: THREE.Object3D[];
  update(ctx: LayerContext, desc: ResolvedDesc): void;
  /** Per-frame advance. Only the currents module has one. */
  tick?(dt: number, ctx: LayerContext): void;
  dispose(): void;
}

export type LayerFactory = (ctx: LayerContext) => LayerHandle;
export type Registry = Record<string, LayerFactory>;

/* ---------------- field shading ---------------- */

const FIELD_VERT = `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;

// Colormap lookup, range clamp and log scaling, all on the GPU. The G channel
// is the water mask: discarding on it stops the field exactly at the seabed
// instead of smearing the last wet value through rock.
const FIELD_FRAG = `
precision highp float;
uniform sampler2D uData, uCmap;
uniform float uMin, uMax, uOpacity, uLog, uShade, uLift;
varying vec2 vUv;
void main(){
  vec4 s = texture2D(uData, vUv);
  if (s.g < 0.5) discard;
  float t;
  if (uLog > 0.5) {
    float lo = log(max(uMin, 1.0e-3)), hi = log(max(uMax, 1.0e-2));
    t = (log(max(s.r, 1.0e-3)) - lo) / max(hi - lo, 1.0e-4);
  } else {
    t = (s.r - uMin) / max(uMax - uMin, 1.0e-6);
  }
  vec3 c = texture2D(uCmap, vec2(clamp(t,0.0,1.0), 0.5)).rgb;
  c = c * uShade + uLift * vec3(0.42, 0.78, 0.92);
  gl_FragColor = vec4(c, uOpacity);
}`;

type FieldMaterial = THREE.ShaderMaterial & {
  uniforms: {
    uData: { value: THREE.DataTexture };
    uCmap: { value: THREE.DataTexture };
    uMin: { value: number };
    uMax: { value: number };
    uOpacity: { value: number };
    uLog: { value: number };
    uShade: { value: number };
    uLift: { value: number };
  };
};

type FieldMesh = THREE.Mesh<THREE.BufferGeometry, FieldMaterial>;
type VertexColorMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

function fieldTexture(data: Float32Array, w: number, h: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function fieldMaterial(tex: THREE.DataTexture, cmap: THREE.DataTexture, shade = 1): FieldMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uData: { value: tex },
      uCmap: { value: cmap },
      uMin: { value: 0 },
      uMax: { value: 1 },
      uOpacity: { value: 1 },
      uLog: { value: 0 },
      uShade: { value: shade },
      uLift: { value: 0 },
    },
    vertexShader: FIELD_VERT,
    fragmentShader: FIELD_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  }) as FieldMaterial;
}

/** The payload behind a data texture, for in-place refills. */
const texData = (tex: THREE.DataTexture): Float32Array =>
  tex.image.data as unknown as Float32Array;

/** Explicit quad so the uv ↔ (lon, lat) mapping is unambiguous for picking. */
function horizontalQuad(geo: GeoMap): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const p: number[] = [];
  const uv: number[] = [];
  for (const fy of [0, 1]) {
    for (const fx of [0, 1]) {
      p.push(geo.x(fx), 0, geo.z(fy));
      uv.push(fx, fy);
    }
  }
  g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex([0, 1, 3, 0, 3, 2]);
  return g;
}

/**
 * Section quad, built at position 0 along its fixed axis; the mesh is then
 * translated. 2 columns × nz rows, with vertical positions following the depth
 * axis mapping — so a stretched axis bends the section's rows, not its texture.
 */
function sectionQuad(geo: GeoMap, levels: number[], axis: "lon" | "lat"): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const p: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const nz = levels.length;
  for (let k = 0; k < nz; k++) {
    const y = -geo.yn(levels[k]!);
    for (let c = 0; c < 2; c++) {
      if (axis === "lon") p.push(geo.x(0), y, geo.z(c));
      else p.push(geo.x(c), y, geo.z(0));
      uv.push(c, k / (nz - 1));
    }
  }
  for (let k = 0; k < nz - 1; k++) {
    const a = k * 2;
    idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/* ================================================================= registry */

export function createRegistry(): Registry {
  const applyRange = (mat: FieldMaterial, g: GlobalContext): void => {
    mat.uniforms.uMin.value = g.colorMin;
    mat.uniforms.uMax.value = g.colorMax;
    mat.uniforms.uLog.value = g.scale === "log" ? 1 : 0;
    mat.uniforms.uCmap.value = g.cmapTex;
  };

  /* ---------------- scalar-field ---------------- */

  function scalarField(ctx: LayerContext): LayerHandle {
    const geo = ctx.geo;
    const group = new THREE.Group();
    const pickables: THREE.Object3D[] = [];

    let built: ScalarMode | null = null;
    let sig = "";
    let parts: THREE.Mesh[] = [];
    let sliced: { secLon: FieldMesh; secLat: FieldMesh; slice: FieldMesh } | null = null;
    let stack: FieldMesh[] = [];
    let iso: VertexColorMesh | null = null;

    const clear = (): void => {
      for (const m of parts) {
        group.remove(m);
        m.geometry.dispose();
        const mat = m.material as THREE.Material & {
          uniforms?: Record<string, THREE.IUniform>;
        };
        const data = mat.uniforms?.uData?.value as THREE.Texture | undefined;
        if (data) data.dispose();
        mat.dispose();
      }
      parts = [];
      sliced = null;
      stack = [];
      iso = null;
      pickables.length = 0;
    };

    function build(mode: ScalarMode): void {
      clear();
      built = mode;
      sig = "";

      if (mode === "slices") {
        const slice: FieldMesh = new THREE.Mesh(
          horizontalQuad(geo),
          fieldMaterial(
            fieldTexture(new Float32Array(GRID.nx * GRID.ny * 4), GRID.nx, GRID.ny),
            ctx.global.cmapTex,
          ),
        );
        slice.userData.pick = "depth";
        const secLon: FieldMesh = new THREE.Mesh(
          sectionQuad(geo, LEVELS, "lon"),
          fieldMaterial(
            fieldTexture(new Float32Array(GRID.ny * GRID.nz * 4), GRID.ny, GRID.nz),
            ctx.global.cmapTex,
            1.0,
          ),
        );
        secLon.userData.pick = "sec-lon";
        const secLat: FieldMesh = new THREE.Mesh(
          sectionQuad(geo, LEVELS, "lat"),
          fieldMaterial(
            fieldTexture(new Float32Array(GRID.nx * GRID.nz * 4), GRID.nx, GRID.nz),
            ctx.global.cmapTex,
            1.0,
          ),
        );
        secLat.userData.pick = "sec-lat";
        for (const m of [slice, secLon, secLat]) {
          const e = new THREE.LineSegments(
            new THREE.EdgesGeometry(m.geometry, 1),
            new THREE.LineBasicMaterial({ color: 0x9fe8f4, transparent: true, opacity: 0.42 }),
          );
          m.add(e);
          m.userData.edge = e;
        }
        sliced = { secLon, secLat, slice };
        parts = [secLon, secLat, slice];
        pickables.push(slice, secLon, secLat);
      } else if (mode === "volume") {
        const idxs: number[] = [];
        for (let k = 0; k < GRID.nz; k += 2) idxs.push(k);
        stack = idxs.map((k) => {
          const m: FieldMesh = new THREE.Mesh(
            horizontalQuad(geo),
            fieldMaterial(
              fieldTexture(new Float32Array(GRID.nx * GRID.ny * 4), GRID.nx, GRID.ny),
              ctx.global.cmapTex,
            ),
          );
          m.position.y = -geo.yn(LEVELS[k]!);
          m.userData.level = k;
          m.renderOrder = 2;
          return m;
        });
        parts = stack;
        const top = stack[0]!;
        pickables.push(top);
        top.userData.pick = "volume-top";
        top.userData.depth = LEVELS[0]!;
      } else {
        const g = new THREE.BufferGeometry();
        g.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(new Float32Array(GRID.nx * GRID.ny * 3), 3),
        );
        g.setAttribute(
          "color",
          new THREE.Float32BufferAttribute(new Float32Array(GRID.nx * GRID.ny * 3), 3),
        );
        g.setIndex([]);
        iso = new THREE.Mesh(
          g,
          new THREE.MeshBasicMaterial({
            vertexColors: true,
            transparent: true,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        );
        parts = [iso];
      }
      for (const m of parts) group.add(m);
    }

    return {
      group,
      pickables,
      update(ctx, desc) {
        const p = desc.props ?? {};
        const g = ctx.global;
        const mode: ScalarMode = p.mode ?? "slices";
        if (mode !== built) build(mode);

        const key = [
          mode,
          g.variable,
          g.timeIndex,
          p.activeAxis,
          p.sliceDepth,
          p.sliceLon,
          p.sliceLat,
          p.isoValue,
        ].join("|");
        const dirty = key !== sig;
        sig = key;

        if (mode === "slices" && sliced) {
          const { secLon, secLat, slice } = sliced;
          const active = p.activeAxis ?? "depth";
          const ctxOn = p.contextWalls !== false;
          // Inactive planes retreat to the box faces and read as context.
          const depth = active === "depth" ? p.sliceDepth ?? 0 : 0;
          const fLon = active === "lon" ? ((p.sliceLon ?? GRID.lon0) - GRID.lon0) / 5 : 0;
          const fLat = active === "lat" ? ((p.sliceLat ?? GRID.lat0) - GRID.lat0) / 5 : 1;
          slice.position.y = -geo.yn(depth);
          secLon.position.x = 10 * fLon;
          secLat.position.z = -10 * fLat;
          slice.visible = active === "depth" || ctxOn;
          secLon.visible = active === "lon" || ctxOn;
          secLat.visible = active === "lat" || ctxOn;

          if (dirty) {
            texData(secLon.material.uniforms.uData.value).set(
              sectionTexture(g.variable, "lon", fLon, g.timeIndex).data,
            );
            secLon.material.uniforms.uData.value.needsUpdate = true;
            texData(secLat.material.uniforms.uData.value).set(
              sectionTexture(g.variable, "lat", fLat, g.timeIndex).data,
            );
            secLat.material.uniforms.uData.value.needsUpdate = true;
            texData(slice.material.uniforms.uData.value).set(
              levelTexture(g.variable, depth, g.timeIndex),
            );
            slice.material.uniforms.uData.value.needsUpdate = true;
          }

          const activeMesh = active === "lon" ? secLon : active === "lat" ? secLat : slice;
          for (const m of [secLon, secLat, slice]) {
            const isActive = m === activeMesh;
            applyRange(m.material, g);
            // The depth wall faces the camera broadside, so it needs less than
            // the edge-on sections. Deep water is near-black in most palettes,
            // so context planes get a small ambient lift or the box reads empty.
            const ctxMul = m === slice ? 0.3 : 0.62;
            m.material.uniforms.uOpacity.value = desc.opacity * (isActive ? 1 : ctxMul);
            m.material.uniforms.uLift.value = isActive ? 0 : 0.16;
            m.userData.active = isActive;
            const edge = m.userData.edge as THREE.LineSegments<
              THREE.BufferGeometry,
              THREE.LineBasicMaterial
            > | undefined;
            if (edge) edge.material.opacity = isActive ? 0.42 * desc.opacity : 0;
          }
          pickables.length = 0;
          pickables.push(activeMesh);
        } else if (mode === "volume") {
          for (const m of stack) {
            if (dirty) {
              texData(m.material.uniforms.uData.value).set(
                levelTexture(g.variable, LEVELS[m.userData.level as number]!, g.timeIndex),
              );
              m.material.uniforms.uData.value.needsUpdate = true;
            }
            applyRange(m.material, g);
            m.material.uniforms.uOpacity.value = desc.opacity * 0.085;
          }
        } else if (iso) {
          const m = iso;
          m.material.opacity = desc.opacity * 0.62;
          if (!dirty) return;
          const field = isoDepthField(g.variable, p.isoValue ?? 20, g.timeIndex);
          const pos = m.geometry.attributes.position!.array as Float32Array;
          const col = m.geometry.attributes.color!.array as Float32Array;
          const idx: number[] = [];
          for (let j = 0; j < GRID.ny; j++) {
            for (let i = 0; i < GRID.nx; i++) {
              const n = j * GRID.nx + i;
              const d = field[n]!;
              pos[n * 3] = geo.x(i / (GRID.nx - 1));
              pos[n * 3 + 1] = d < 0 ? 0 : -geo.yn(d);
              pos[n * 3 + 2] = geo.z(j / (GRID.ny - 1));
              const f = d < 0 ? 0 : Math.min(1, d / 260);
              const shade = d < 0 ? 0 : 1;
              col[n * 3] = (0.52 - 0.42 * f) * shade;
              col[n * 3 + 1] = (0.92 - 0.55 * f) * shade;
              col[n * 3 + 2] = (0.96 - 0.3 * f) * shade;
            }
          }
          // A cell is only meshed where all four corners carry the surface;
          // elsewhere the isovalue genuinely does not occur in the column.
          for (let j = 0; j < GRID.ny - 1; j++) {
            for (let i = 0; i < GRID.nx - 1; i++) {
              const a = j * GRID.nx + i;
              const b = a + 1;
              const c = a + GRID.nx;
              const e = c + 1;
              if (field[a]! < 0 || field[b]! < 0 || field[c]! < 0 || field[e]! < 0) continue;
              idx.push(a, c, e, a, e, b);
            }
          }
          m.geometry.setIndex(idx);
          m.geometry.attributes.position!.needsUpdate = true;
          m.geometry.attributes.color!.needsUpdate = true;
          m.geometry.computeBoundingSphere();
        }
      },
      dispose() {
        clear();
      },
    };
  }

  /* ---------------- currents ---------------- */

  const PART_VERT = `
attribute float aAlpha;
attribute float aSpeed;
varying float vAlpha;
varying float vSpeed;
void main(){ vAlpha = aAlpha; vSpeed = aSpeed; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;

  const PART_FRAG = `
precision highp float;
uniform float uOpacity;
varying float vAlpha;
varying float vSpeed;
void main(){
  vec3 cool = vec3(0.24,0.55,0.72);
  vec3 hot  = vec3(0.78,0.98,1.0);
  vec3 c = mix(cool, hot, clamp(vSpeed,0.0,1.0));
  gl_FragColor = vec4(c, vAlpha * uOpacity);
}`;

  type PartMaterial = THREE.ShaderMaterial & { uniforms: { uOpacity: { value: number } } };

  function currents(_ctx: LayerContext): LayerHandle {
    const group = new THREE.Group();
    let N = 0;
    let TRAIL = 0;
    let hist = new Float32Array(0);
    let life = new Float32Array(0);
    let mesh: THREE.LineSegments<THREE.BufferGeometry, PartMaterial> | null = null;
    let seedDepth = -1;
    let pspeed = 1;

    function seed(i: number, spread: boolean): void {
      const lon = GRID.lon0 + Math.random() * 5;
      const lat = GRID.lat0 + Math.random() * 5;
      for (let k = 0; k < TRAIL; k++) {
        const o = (i * TRAIL + k) * 3;
        hist[o] = lon;
        hist[o + 1] = lat;
        hist[o + 2] = 0;
      }
      life[i] = spread ? Math.random() * 5 : 0;
    }

    function alloc(count: number, trail: number): void {
      if (mesh) {
        group.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      N = count;
      TRAIL = trail;
      hist = new Float32Array(N * TRAIL * 3); // lon, lat, speed
      life = new Float32Array(N);
      const g = new THREE.BufferGeometry();
      const segs = N * (TRAIL - 1) * 2;
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(segs * 3), 3));
      g.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(segs), 1));
      g.setAttribute("aSpeed", new THREE.BufferAttribute(new Float32Array(segs), 1));
      mesh = new THREE.LineSegments(
        g,
        new THREE.ShaderMaterial({
          uniforms: { uOpacity: { value: 1 } },
          vertexShader: PART_VERT,
          fragmentShader: PART_FRAG,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }) as PartMaterial,
      );
      // The trails move every frame and their bounds are the whole box anyway.
      mesh.frustumCulled = false;
      group.add(mesh);
      for (let i = 0; i < N; i++) seed(i, true);
    }

    return {
      group,
      update(ctx, desc) {
        const p = desc.props ?? {};
        const count = Math.max(50, Math.min(2400, (p.count ?? 0) | 0 || 900));
        const trail = Math.max(3, Math.min(24, (p.trail ?? 0) | 0 || 10));
        if (count !== N || trail !== TRAIL) alloc(count, trail);
        seedDepth = ctx.global.sliceDepth;
        if (mesh) mesh.material.uniforms.uOpacity.value = desc.opacity;
        pspeed = p.speed ?? 1;
      },
      tick(dt, ctx) {
        if (!mesh) return;
        const geoX = ctx.geo.x;
        const geoZ = ctx.geo.z;
        const depth = seedDepth < 0 ? 50 : seedDepth;
        const y = -ctx.geo.yn(depth);
        const t = ctx.global.timeIndex;
        const k = pspeed * dt * 0.55;
        const pos = mesh.geometry.attributes.position!.array as Float32Array;
        const al = mesh.geometry.attributes.aAlpha!.array as Float32Array;
        const sp = mesh.geometry.attributes.aSpeed!.array as Float32Array;
        let w = 0;
        let wa = 0;
        for (let i = 0; i < N; i++) {
          // Shift the trail history back one slot, newest first.
          const base = i * TRAIL * 3;
          for (let s = TRAIL - 1; s > 0; s--) {
            hist[base + s * 3] = hist[base + (s - 1) * 3]!;
            hist[base + s * 3 + 1] = hist[base + (s - 1) * 3 + 1]!;
            hist[base + s * 3 + 2] = hist[base + (s - 1) * 3 + 2]!;
          }
          let lon = hist[base]!;
          let lat = hist[base + 1]!;
          const [u, v] = velocity(lon, lat, depth, t);
          const spd = Math.hypot(u, v);
          // m/s to degrees: one degree of latitude is ~111 km.
          lon += u * k * 0.009;
          lat += v * k * 0.009;
          hist[base] = lon;
          hist[base + 1] = lat;
          hist[base + 2] = spd / 0.9;
          life[i] = life[i]! + dt;
          const floor = bathymetryAt(lon, lat);
          if (
            life[i]! > 9 ||
            lon < GRID.lon0 ||
            lon > GRID.lon1 ||
            lat < GRID.lat0 ||
            lat > GRID.lat1 ||
            depth > floor
          ) {
            seed(i, false);
          }
          for (let s = 0; s < TRAIL - 1; s++) {
            const o0 = base + s * 3;
            const o1 = base + (s + 1) * 3;
            const fade = 1 - s / (TRAIL - 1);
            const grow = Math.min(1, life[i]! * 2.5);
            pos[w++] = geoX((hist[o0]! - GRID.lon0) / 5);
            pos[w++] = y;
            pos[w++] = geoZ((hist[o0 + 1]! - GRID.lat0) / 5);
            pos[w++] = geoX((hist[o1]! - GRID.lon0) / 5);
            pos[w++] = y;
            pos[w++] = geoZ((hist[o1 + 1]! - GRID.lat0) / 5);
            al[wa] = fade * grow;
            sp[wa++] = hist[o0 + 2]!;
            al[wa] = fade * 0.75 * grow;
            sp[wa++] = hist[o1 + 2]!;
          }
        }
        mesh.geometry.attributes.position!.needsUpdate = true;
        mesh.geometry.attributes.aAlpha!.needsUpdate = true;
        mesh.geometry.attributes.aSpeed!.needsUpdate = true;
      },
      dispose() {
        if (mesh) {
          mesh.geometry.dispose();
          mesh.material.dispose();
          group.remove(mesh);
        }
      },
    };
  }

  /* ---------------- bathymetry ---------------- */

  function bathymetry(ctx: LayerContext): LayerHandle {
    const geo = ctx.geo;
    const group = new THREE.Group();
    const nx = GRID.nx;
    const ny = GRID.ny;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(nx * ny * 3);
    const depths = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const n = j * nx + i;
        const lon = lonAt(i);
        const lat = latAt(j);
        const d = bathymetryAt(lon, lat);
        depths[n] = d;
        pos[n * 3] = geo.x(i / (nx - 1));
        pos[n * 3 + 1] = -geo.yn(d);
        pos[n * 3 + 2] = geo.z(j / (ny - 1));
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        const b = a + 1;
        const c = a + nx;
        const e = c + 1;
        idx.push(a, c, e, a, e, b);
      }
    }
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(nx * ny * 3), 3));
    g.setIndex(idx);
    // Float32BufferAttribute copies the array it is handed, so recolouring has
    // to write through the attribute's own buffer. Writing to the array it was
    // built from leaves the seabed at its initial black and makes the colormap
    // picker below do nothing at all — which looks exactly like a design choice.
    const col = g.attributes.color!.array as Float32Array;
    const mesh = new THREE.Mesh(
      g,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide }),
    );
    group.add(mesh);
    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(g),
      new THREE.LineBasicMaterial({ color: 0x8fd6e6, transparent: true, opacity: 0.05 }),
    );
    group.add(wire);

    // Sediment skirt: extrude the four boundary runs down to the box floor, so
    // the chunk reads as a solid block cut out of the basin rather than a sheet
    // of terrain floating in an empty box.
    const runs: number[][] = [
      Array.from({ length: nx }, (_, i) => i), // j = 0
      Array.from({ length: nx }, (_, i) => (ny - 1) * nx + i), // j = ny-1
      Array.from({ length: ny }, (_, j) => j * nx), // i = 0
      Array.from({ length: ny }, (_, j) => j * nx + (nx - 1)), // i = nx-1
    ];
    const sPos: number[] = [];
    const sCol: number[] = [];
    const sIdx: number[] = [];
    const yFloor = -geo.yn(GRID.maxDepth);
    let v = 0;
    for (const run of runs) {
      for (const n of run) {
        sPos.push(pos[n * 3]!, pos[n * 3 + 1]!, pos[n * 3 + 2]!);
        sPos.push(pos[n * 3]!, yFloor, pos[n * 3 + 2]!);
        sCol.push(0, 0, 0, 0, 0, 0);
      }
      for (let q = 0; q < run.length - 1; q++) {
        const a = v + q * 2;
        sIdx.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
      v += run.length * 2;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.Float32BufferAttribute(sPos, 3));
    sg.setAttribute("color", new THREE.Float32BufferAttribute(sCol, 3));
    sg.setIndex(sIdx);
    const skirt = new THREE.Mesh(
      sg,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide }),
    );
    group.add(skirt);

    const paintSkirt = (): void => {
      const c = sg.attributes.color!.array as Float32Array;
      let w = 0;
      for (const run of runs) {
        for (const n of run) {
          // A fixed sediment ramp — never keyed to the bathymetry colormap,
          // which goes near-white at the shallow end and would outshine the data.
          const t = Math.min(1, depths[n]! / GRID.maxDepth);
          c[w++] = 0.15 - 0.075 * t;
          c[w++] = 0.138 - 0.062 * t;
          c[w++] = 0.118 - 0.03 * t;
          c[w++] = 0.035;
          c[w++] = 0.055;
          c[w++] = 0.085;
        }
      }
      sg.attributes.color!.needsUpdate = true;
    };

    let lastPal = "";
    return {
      group,
      update(_ctx, desc) {
        const pal: CmapName = desc.props?.palette ?? "deep";
        mesh.material.opacity = desc.opacity;
        wire.material.opacity = desc.opacity * 0.07;
        skirt.material.opacity = desc.opacity;
        if (pal === lastPal) return;
        lastPal = pal;
        const stops = CMAPS[pal] ?? CMAPS.deep;
        paintSkirt();
        for (let j = 0; j < ny; j++) {
          for (let i = 0; i < nx; i++) {
            const n = j * nx + i;
            const t = depths[n]! / GRID.maxDepth;
            const c = shadeAt(stops, t, depths, i, j, nx, ny);
            col[n * 3] = c[0];
            col[n * 3 + 1] = c[1];
            col[n * 3 + 2] = c[2];
          }
        }
        g.attributes.color!.needsUpdate = true;
      },
      dispose() {
        g.dispose();
        mesh.material.dispose();
        wire.geometry.dispose();
        wire.material.dispose();
        sg.dispose();
        skirt.material.dispose();
      },
    };
  }

  /**
   * Colormap sample darkened by the local slope, so the shelf break and the
   * seamount read as relief. There is no light in this scene — this is the only
   * thing giving the seabed a form.
   */
  function shadeAt(
    stops: string[],
    t: number,
    depths: Float32Array,
    i: number,
    j: number,
    nx: number,
    ny: number,
  ): [number, number, number] {
    const rgb = sampleCmap(stops, t);
    const il = Math.max(0, i - 1);
    const ir = Math.min(nx - 1, i + 1);
    const jd = Math.max(0, j - 1);
    const ju = Math.min(ny - 1, j + 1);
    const gx = depths[j * nx + ir]! - depths[j * nx + il]!;
    const gy = depths[ju * nx + i]! - depths[jd * nx + i]!;
    const s = 0.78 + 0.5 * Math.max(-0.45, Math.min(0.45, (gx * 0.6 + gy * 0.4) / 420));
    return [(rgb[0] / 255) * s, (rgb[1] / 255) * s, (rgb[2] / 255) * s];
  }

  /* ---------------- instruments ---------------- */

  function instrumentsLayer(ctx: LayerContext): LayerHandle {
    const geo = ctx.geo;
    const group = new THREE.Group();
    const pickables: THREE.Object3D[] = [];
    const insts = instrumentList();

    const built = insts.map((inst) => {
      const sub = new THREE.Group();
      const isArgo = inst.type === "argo";
      const color = isArgo ? 0x6fe3f0 : 0xf2b45c;
      const pts: number[] = [];
      for (const [lon, lat, d] of inst.points) {
        pts.push(geo.x((lon - GRID.lon0) / 5), -geo.yn(d), geo.z((lat - GRID.lat0) / 5));
      }
      const lg = new THREE.BufferGeometry();
      lg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      const line = new THREE.Line(
        lg,
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.72 }),
      );
      sub.add(line);

      const dg = new THREE.BufferGeometry();
      dg.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(3 * 400), 3));
      dg.setDrawRange(0, 0);
      const dots = new THREE.Points(
        dg,
        new THREE.PointsMaterial({
          color,
          size: 2.6,
          sizeAttenuation: false,
          transparent: true,
          opacity: 0.9,
        }),
      );
      sub.add(dots);

      const marker = new THREE.Mesh(
        isArgo ? new THREE.SphereGeometry(0.11, 20, 14) : new THREE.ConeGeometry(0.12, 0.3, 18),
        new THREE.MeshBasicMaterial({ color }),
      );
      marker.userData.instrument = inst.id;
      marker.userData.type = inst.type;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.17, 0.21, 32),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.55,
          side: THREE.DoubleSide,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      const dropGeom = new THREE.BufferGeometry();
      dropGeom.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3));
      const drop = new THREE.Line(
        dropGeom,
        new THREE.LineDashedMaterial({
          color,
          transparent: true,
          opacity: 0.35,
          dashSize: 0.06,
          gapSize: 0.05,
        }),
      );
      sub.add(marker);
      sub.add(ring);
      sub.add(drop);
      pickables.push(marker, ring);
      return { inst, sub, line, dots, marker, ring, drop };
    });
    for (const b of built) group.add(b.sub);

    return {
      group,
      pickables,
      update(ctx, desc) {
        const day = ctx.global.timeIndex;
        const H = ctx.global.height;
        for (const b of built) {
          const p = instrumentAt(b.inst.id, day);
          const x = geo.x((p.lon - GRID.lon0) / 5);
          const z = geo.z((p.lat - GRID.lat0) / 5);
          // The group is scaled by the column height; the marker undoes that so
          // it stays a sphere rather than a stretched egg at 200× exaggeration.
          b.marker.position.set(x, 0.02 / H, z);
          b.marker.scale.set(1, 1 / H, 1);
          b.ring.position.set(x, 0.001, z);
          const dp = b.drop.geometry.attributes.position!.array as Float32Array;
          dp[0] = x;
          dp[1] = 0;
          dp[2] = z;
          dp[3] = x;
          dp[4] = -ctx.geo.yn(b.inst.maxDepth);
          dp[5] = z;
          b.drop.geometry.attributes.position!.needsUpdate = true;
          b.drop.computeLineDistances();
          b.line.material.opacity = 0.72 * desc.opacity;
          b.dots.material.opacity = 0.9 * desc.opacity;
          b.ring.material.opacity = 0.55 * desc.opacity;

          const samples = profileSamples(b.inst.id, day);
          const arr = b.dots.geometry.attributes.position!.array as Float32Array;
          const n = Math.min(samples.length, 400);
          for (let i = 0; i < n; i++) {
            const [lo, la, d] = samples[i]!;
            arr[i * 3] = geo.x((lo - GRID.lon0) / 5);
            arr[i * 3 + 1] = -geo.yn(d);
            arr[i * 3 + 2] = geo.z((la - GRID.lat0) / 5);
          }
          b.dots.geometry.setDrawRange(0, n);
          b.dots.geometry.attributes.position!.needsUpdate = true;
          b.dots.geometry.computeBoundingSphere();
        }
      },
      dispose() {
        for (const b of built) {
          group.remove(b.sub);
          b.line.geometry.dispose();
          b.line.material.dispose();
          b.dots.geometry.dispose();
          b.dots.material.dispose();
          b.marker.geometry.dispose();
          b.marker.material.dispose();
          b.ring.geometry.dispose();
          b.ring.material.dispose();
          b.drop.geometry.dispose();
          b.drop.material.dispose();
        }
      },
    };
  }

  /* ---------------- sea-surface ---------------- */

  function seaSurface(ctx: LayerContext): LayerHandle {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(
      horizontalQuad(ctx.geo),
      new THREE.MeshBasicMaterial({
        color: 0x86d8ee,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    mesh.renderOrder = 5;
    group.add(mesh);
    return {
      group,
      update(_ctx, desc) {
        mesh.material.opacity = desc.opacity;
      },
      dispose() {
        mesh.geometry.dispose();
        mesh.material.dispose();
      },
    };
  }

  return {
    "scalar-field": scalarField,
    currents,
    bathymetry,
    instruments: instrumentsLayer,
    "sea-surface": seaSurface,
  };
}
