/**
 * The chunk viewport.
 *
 * Owns the renderer, the camera orbit, the box chrome and the layer handles,
 * and nothing else: every question about *what* to draw is answered by the
 * scene spec, and every answer about *how* comes from the registry. React holds
 * the spec, mutates it, and calls `commit()`; the engine reconciles the scene
 * against it the way a renderer reconciles a tree, creating, updating and
 * disposing handles by descriptor id.
 *
 * Two things are deliberately not React's business: the render loop, which must
 * not re-render a component 60 times a second, and hover picking, which is
 * raycast against the live scene and throttled to one test per frame.
 */

import * as THREE from "three";

import {
  GRID,
  LEVELS,
  CMAPS,
  VARIABLES,
  bathymetry,
  value,
  type VariableKey,
} from "./model";
import {
  createRegistry,
  makeCmapTexture,
  type GeoMap,
  type LayerContext,
  type LayerHandle,
  type Registry,
} from "./registry";
import {
  DEFAULT_SPEC,
  PRESETS,
  RULER,
  columnHeight,
  depthNorm,
  type CutAxis,
  type PresetName,
  type SceneSpec,
} from "./spec";

/** What the cursor is over, in canvas pixels plus real units. */
export interface HoverReadout {
  x: number;
  y: number;
  val: number;
  lon: number;
  lat: number;
  depth: number;
  variable: VariableKey;
}

interface Orbit {
  theta: number;
  phi: number;
  radius: number;
  tx: number;
  ty: number;
  tz: number;
}

interface Tween {
  t0: number;
  dur: number;
  from: Orbit;
  to: Orbit;
}

type MountedHandle = LayerHandle & { _type?: string; _ax?: number };

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export class ChunkEngine {
  spec: SceneSpec = structuredClone(DEFAULT_SPEC);

  /** Fired when the measured frame rate changes, not every frame. */
  onFps: ((fps: number) => void) | null = null;
  /** Null when the cursor leaves the field. */
  onHover: ((hover: HoverReadout | null) => void) | null = null;
  /** A platform id on click, or null when the click hit nothing. */
  onPickInstrument: ((id: string | null) => void) | null = null;

  private readonly registry: Registry = createRegistry();
  private readonly handles = new Map<string, MountedHandle>();
  private readonly cmapCache = new Map<string, THREE.DataTexture>();
  private readonly listeners = new AbortController();

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.05, 400);
  private renderer!: THREE.WebGLRenderer;
  private root!: THREE.Group;
  private chrome!: THREE.Group;
  private resizeObserver: ResizeObserver | null = null;
  private rulerEls: HTMLDivElement[] = [];

  private orbit: Orbit = { theta: 0, phi: 0, radius: 26, tx: 0, ty: 0, tz: 0 };
  private tween: Tween | null = null;
  private raf = 0;
  private axisVersion = 0;
  private lastFrame = 0;
  private frameCount = 0;
  private fpsWindow = 0;
  private fps = 0;
  private pointer: { x: number; y: number } | null = null;
  private hoverDirty = false;
  private hovering = false;
  private raycaster: THREE.Raycaster | null = null;

  /** Grid fraction to world. The box is 10 units across, centred on origin. */
  private readonly geo: GeoMap = {
    x: (f: number) => -5 + 10 * f,
    z: (f: number) => 5 - 10 * f,
    yn: (d: number) => depthNorm(d, this.spec.view.depthAxis),
  };

  constructor(
    private readonly host: HTMLElement,
    private readonly rulerHost: HTMLElement,
  ) {}

  /* ---------------- lifecycle ---------------- */

  start(): void {
    this.initThree();
    // The colour range opens on the variable's published range, not on the
    // chunk's own extremes: a forecaster reads this against the same scale
    // every day, and auto-ranging on load would move it under them.
    const range = VARIABLES[this.spec.field.variable].range;
    this.spec.colorRange.min = range[0];
    this.spec.colorRange.max = range[1];
    this.syncScene();
    this.loop();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.listeners.abort();
    this.resizeObserver?.disconnect();
    for (const h of this.handles.values()) {
      h.dispose();
      this.root.remove(h.group);
    }
    this.handles.clear();
    for (const t of this.cmapCache.values()) t.dispose();
    this.cmapCache.clear();
    this.disposeChrome();
    for (const el of this.rulerEls) el.remove();
    this.rulerEls = [];
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private height(): number {
    return columnHeight(this.spec.view.exaggeration);
  }

  private cmap(name: string): THREE.DataTexture {
    let tex = this.cmapCache.get(name);
    if (!tex) {
      tex = makeCmapTexture(CMAPS[name as keyof typeof CMAPS] ?? CMAPS.thermal);
      this.cmapCache.set(name, tex);
    }
    return tex;
  }

  /* ---------------- three.js ---------------- */

  private initThree(): void {
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    // The CSS behind the canvas paints the water; the renderer only adds to it.
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.domElement.style.display = "block";
    this.host.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.chrome = new THREE.Group();
    this.root.add(this.chrome);
    this.buildChrome();

    const p0 = PRESETS[this.spec.view.preset] ?? PRESETS.corner;
    const home: Orbit = {
      theta: p0.theta,
      phi: p0.phi,
      radius: p0.radius,
      tx: 0,
      ty: -this.height() * 0.45,
      tz: 0,
    };
    // The one orchestrated motion in this view: a descent into the chunk from
    // above and behind. Anyone who asked for reduced motion starts at the end
    // of it instead.
    if (prefersReducedMotion()) {
      this.orbit = { ...home };
    } else {
      this.orbit = { ...home, theta: home.theta - 0.5, phi: 0.42, radius: home.radius * 1.9 };
      this.tween = {
        t0: performance.now() + 220,
        dur: 1500,
        from: { ...this.orbit },
        to: home,
      };
    }

    this.bindPointer();

    const onResize = (): void => {
      const w = this.host.clientWidth || 1;
      const h = this.host.clientHeight || 1;
      renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize, { signal: this.listeners.signal });
    this.resizeObserver = new ResizeObserver(onResize);
    this.resizeObserver.observe(this.host);
    onResize();

    this.rulerEls = RULER.map((d) => {
      const el = document.createElement("div");
      el.className = "chunk-ruler__tick";
      const rule = document.createElement("div");
      rule.className = "chunk-ruler__rule";
      const label = document.createElement("div");
      label.className = "chunk-ruler__label";
      label.textContent = d === 0 ? "0 m" : String(d);
      el.append(rule, label);
      this.rulerHost.appendChild(el);
      return el;
    });
  }

  private disposeChrome(): void {
    while (this.chrome.children.length) {
      const c = this.chrome.children.pop() as THREE.LineSegments<
        THREE.BufferGeometry,
        THREE.Material
      >;
      c.geometry.dispose();
      c.material.dispose();
    }
  }

  /**
   * The box frame and its depth hairlines. Rebuilt whenever the depth axis
   * changes, because the tick heights are baked into the geometry.
   */
  private buildChrome(): void {
    this.disposeChrome();
    const yb = -this.geo.yn(2000);
    const corners: [number, number][] = [
      [-5, 5],
      [5, 5],
      [5, -5],
      [-5, -5],
    ];
    const seg: number[] = [];
    for (let i = 0; i < 4; i++) {
      const a = corners[i]!;
      const b = corners[(i + 1) % 4]!;
      seg.push(a[0], 0, a[1], b[0], 0, b[1]);
      seg.push(a[0], yb, a[1], b[0], yb, b[1]);
      seg.push(a[0], 0, a[1], a[0], yb, a[1]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
    this.chrome.add(
      new THREE.LineSegments(
        g,
        new THREE.LineBasicMaterial({ color: 0x7ea6c4, transparent: true, opacity: 0.45 }),
      ),
    );

    const ticks: number[] = [];
    for (const d of RULER) {
      if (!d) continue;
      const y = -this.geo.yn(d);
      ticks.push(-5, y, 5, -4.7, y, 5);
      ticks.push(-5, y, 5, -5, y, 4.7);
    }
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute("position", new THREE.Float32BufferAttribute(ticks, 3));
    this.chrome.add(
      new THREE.LineSegments(
        g2,
        new THREE.LineBasicMaterial({ color: 0x7ea6c4, transparent: true, opacity: 0.2 }),
      ),
    );
  }

  private bindPointer(): void {
    const el = this.renderer.domElement;
    const signal = this.listeners.signal;
    let px = 0;
    let py = 0;
    let mode: "orbit" | "pan" | null = null;
    let moved = 0;

    el.addEventListener(
      "pointerdown",
      (e) => {
        el.setPointerCapture(e.pointerId);
        px = e.clientX;
        py = e.clientY;
        moved = 0;
        mode = e.button === 2 || e.shiftKey || e.button === 1 ? "pan" : "orbit";
        this.tween = null;
      },
      { signal },
    );
    el.addEventListener("contextmenu", (e) => e.preventDefault(), { signal });
    el.addEventListener(
      "pointermove",
      (e) => {
        const dx = e.clientX - px;
        const dy = e.clientY - py;
        if (mode) {
          moved += Math.abs(dx) + Math.abs(dy);
          const o = this.orbit;
          if (mode === "orbit") {
            o.theta -= dx * 0.006;
            // Never quite top-down or quite edge-on: both degenerate the view.
            o.phi = Math.max(0.04, Math.min(1.55, o.phi - dy * 0.005));
          } else {
            const k = o.radius * 0.0016;
            o.tx = Math.max(
              -6,
              Math.min(6, o.tx - (Math.cos(o.theta) * dx - Math.sin(o.theta) * dy * 0.4) * k),
            );
            o.tz = Math.max(
              -6,
              Math.min(6, o.tz - (Math.sin(o.theta) * dx + Math.cos(o.theta) * dy * 0.4) * k),
            );
            o.ty = Math.max(-this.height() - 1, Math.min(1.5, o.ty - dy * k * 0.6));
          }
          px = e.clientX;
          py = e.clientY;
        } else {
          this.pointer = { x: e.clientX, y: e.clientY };
          this.hoverDirty = true;
        }
      },
      { signal },
    );
    el.addEventListener(
      "pointerup",
      (e) => {
        // A drag that barely moved is a click, and clicks pick instruments.
        if (mode && moved < 6) this.pickInstrument(e);
        mode = null;
      },
      { signal },
    );
    el.addEventListener(
      "pointerleave",
      () => {
        this.pointer = null;
        this.emitHover(null);
      },
      { signal },
    );
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.tween = null;
        this.orbit.radius = Math.max(
          4.5,
          Math.min(46, this.orbit.radius * (1 + Math.sign(e.deltaY) * 0.09)),
        );
      },
      { passive: false, signal },
    );
  }

  private ndc(p: { x: number; y: number }): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((p.x - r.left) / r.width) * 2 - 1,
      -((p.y - r.top) / r.height) * 2 + 1,
    );
  }

  private rc(): THREE.Raycaster {
    if (!this.raycaster) this.raycaster = new THREE.Raycaster();
    return this.raycaster;
  }

  private pickInstrument(e: PointerEvent): void {
    const h = this.handles.get("instruments");
    if (!h || !h.pickables || !h.group.visible) return;
    const rc = this.rc();
    rc.setFromCamera(this.ndc({ x: e.clientX, y: e.clientY }), this.camera);
    const hits = rc.intersectObjects(h.pickables, false);
    if (!hits.length) {
      this.onPickInstrument?.(null);
      return;
    }
    let o: THREE.Object3D | null = hits[0]!.object;
    while (o && !o.userData.instrument) o = o.parent;
    if (o) this.onPickInstrument?.(o.userData.instrument as string);
  }

  private emitHover(h: HoverReadout | null): void {
    if (!h && !this.hovering) return;
    this.hovering = h !== null;
    this.onHover?.(h);
  }

  /**
   * One raycast per frame against the active scalar plane. The uv of the hit
   * carries the grid position directly, which is why the quads are built by
   * hand rather than with PlaneGeometry.
   */
  private updateHover(): void {
    if (!this.pointer) return;
    const h = this.handles.get("scalar");
    if (!h || !h.pickables || !h.pickables.length || !h.group.visible) {
      this.emitHover(null);
      return;
    }
    const rc = this.rc();
    rc.setFromCamera(this.ndc(this.pointer), this.camera);
    const hits = rc.intersectObjects(
      h.pickables.filter((o) => o.visible),
      false,
    );
    if (!hits.length) {
      this.emitHover(null);
      return;
    }
    const hit = hits[0]!;
    const kind = hit.object.userData.pick as string | undefined;
    const uv = hit.uv ?? { x: 0, y: 0 };
    const props = this.spec.layers.find((l) => l.type === "scalar-field")?.props ?? {};
    let lon: number;
    let lat: number;
    let depth: number;
    if (kind === "sec-lon") {
      lon = props.sliceLon ?? GRID.lon0;
      lat = GRID.lat0 + uv.x * 5;
      depth = LEVELS[Math.round(uv.y * (GRID.nz - 1))]!;
    } else if (kind === "sec-lat") {
      lat = props.sliceLat ?? GRID.lat0;
      lon = GRID.lon0 + uv.x * 5;
      depth = LEVELS[Math.round(uv.y * (GRID.nz - 1))]!;
    } else {
      lon = GRID.lon0 + uv.x * 5;
      lat = GRID.lat0 + uv.y * 5;
      const axis: CutAxis = props.activeAxis ?? "depth";
      depth =
        hit.object.userData.depth !== undefined
          ? (hit.object.userData.depth as number)
          : axis === "depth"
            ? props.sliceDepth ?? 0
            : 0;
    }
    const floor = bathymetry(lon, lat);
    const v = this.spec.field.variable;
    const val = value(v, lon, lat, Math.min(depth, floor), this.spec.time.index);
    const r = this.renderer.domElement.getBoundingClientRect();
    this.hovering = true;
    this.onHover?.({
      x: this.pointer.x - r.left + 16,
      y: this.pointer.y - r.top + 14,
      val,
      lon,
      lat,
      depth,
      variable: v,
    });
  }

  /* ---------------- spec to scene ---------------- */

  private ctx(): LayerContext {
    const sc = this.spec.layers.find((l) => l.type === "scalar-field");
    const cr = this.spec.colorRange;
    return {
      geo: this.geo,
      global: {
        variable: this.spec.field.variable,
        sliceDepth: sc ? sc.props?.sliceDepth ?? 0 : 50,
        timeIndex: this.spec.time.index,
        colorMin: cr.min,
        colorMax: cr.max,
        scale: cr.scale,
        cmapTex: this.cmap(cr.palette),
        palette: cr.palette,
        height: this.height(),
        depthAxis: this.spec.view.depthAxis,
      },
    };
  }

  /**
   * Reconcile the scene against the spec: create handles for new descriptors,
   * rebuild those whose type or depth axis changed, update the rest, and drop
   * any whose descriptor has gone.
   */
  syncScene(): void {
    const ctx = this.ctx();
    const seen = new Set<string>();
    for (const desc of this.spec.layers) {
      if (!desc || !desc.id) continue;
      seen.add(desc.id);
      let h = this.handles.get(desc.id);
      if (h && (h._type !== desc.type || h._ax !== this.axisVersion)) {
        h.dispose();
        this.root.remove(h.group);
        h = undefined;
      }
      if (!h) {
        const factory = this.registry[desc.type];
        if (!factory) {
          console.warn('[registry] no module for layer type "' + desc.type + '"');
          continue;
        }
        h = factory(ctx) as MountedHandle;
        h._type = desc.type;
        h._ax = this.axisVersion;
        this.root.add(h.group);
        this.handles.set(desc.id, h);
      }
      h.group.visible = desc.visible !== false;
      h.update(ctx, { ...desc, opacity: desc.opacity ?? 1 });
    }
    for (const [id, h] of [...this.handles]) {
      if (seen.has(id)) continue;
      h.dispose();
      this.root.remove(h.group);
      this.handles.delete(id);
    }
    this.root.scale.y = this.height();
  }

  /** Push spec changes into the scene. `rebuildAxis` re-bakes depth geometry. */
  commit(rebuildAxis = false): void {
    if (rebuildAxis) {
      this.axisVersion++;
      this.buildChrome();
    }
    this.syncScene();
  }

  /** Exaggeration is a group scale, so it needs no geometry rebuild. */
  applyExaggeration(): void {
    this.root.scale.y = this.height();
  }

  /**
   * Replace the whole spec from edited JSON.
   *
   * Unknown layer types are reported rather than rejected: a spec written for a
   * build with more modules than this one should still render everything this
   * build understands.
   */
  applySpec(text: string): { ok: boolean; message: string } {
    let next: SceneSpec;
    try {
      next = JSON.parse(text) as SceneSpec;
    } catch (err) {
      return { ok: false, message: "parse error: " + (err as Error).message };
    }
    if (!next.layers || !Array.isArray(next.layers)) {
      return { ok: false, message: "parse error: layers[] missing" };
    }
    const unknown = next.layers.filter((l) => !this.registry[l.type]).map((l) => l.type);
    for (const l of next.layers) {
      // Migrate pre-active-axis specs, which carried three visibility booleans
      // where there is now one active axis plus context walls.
      const q = l.props;
      if (l.type !== "scalar-field" || !q || q.activeAxis) continue;
      q.activeAxis = q.showLon ? "lon" : q.showLat ? "lat" : "depth";
      q.contextWalls = true;
      delete q.showDepth;
      delete q.showLon;
      delete q.showLat;
    }
    this.spec = next;
    this.axisVersion++;
    this.buildChrome();
    this.syncScene();
    return {
      ok: unknown.length === 0,
      message: unknown.length
        ? "applied — unresolved type(s): " +
          [...new Set(unknown)].join(", ") +
          ". Register a module to render them."
        : "applied — " + next.layers.length + " layers resolved through the registry.",
    };
  }

  goPreset(name: PresetName): void {
    const p = PRESETS[name];
    if (!p) return;
    this.spec.view.preset = name;
    const to: Orbit = {
      theta: p.theta,
      phi: p.phi,
      radius: p.radius,
      tx: 0,
      ty: -this.height() * 0.45,
      tz: 0,
    };
    if (prefersReducedMotion()) {
      this.orbit = to;
      this.tween = null;
      return;
    }
    this.tween = { t0: performance.now(), dur: 950, from: { ...this.orbit }, to };
  }

  /* ---------------- loop ---------------- */

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - (this.lastFrame || now)) / 1000);
    this.lastFrame = now;

    this.frameCount++;
    if (now - this.fpsWindow > 700) {
      const el = (now - this.fpsWindow) / 1000;
      const fps = this.fpsWindow && el > 0 ? Math.min(240, Math.round(this.frameCount / el)) : 60;
      this.fpsWindow = now;
      this.frameCount = 0;
      if (fps !== this.fps) {
        this.fps = fps;
        this.onFps?.(fps);
      }
    }

    if (this.tween) {
      const t = Math.max(0, Math.min(1, (now - this.tween.t0) / this.tween.dur));
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const a = this.tween.from;
      const b = this.tween.to;
      const o = this.orbit;
      o.theta = a.theta + (b.theta - a.theta) * e;
      o.phi = a.phi + (b.phi - a.phi) * e;
      o.radius = a.radius + (b.radius - a.radius) * e;
      o.tx = a.tx + (b.tx - a.tx) * e;
      o.ty = a.ty + (b.ty - a.ty) * e;
      o.tz = a.tz + (b.tz - a.tz) * e;
      if (t >= 1) this.tween = null;
    }

    const o = this.orbit;
    const sp = Math.sin(o.phi);
    const cp = Math.cos(o.phi);
    this.camera.position.set(
      o.tx + o.radius * sp * Math.sin(o.theta),
      o.ty + o.radius * cp,
      o.tz + o.radius * sp * Math.cos(o.theta),
    );
    this.camera.lookAt(o.tx, o.ty, o.tz);

    const cur = this.handles.get("currents");
    if (cur?.tick && cur.group.visible) cur.tick(dt, this.ctx());

    this.renderer.render(this.scene, this.camera);
    this.positionRuler();
    if (this.hoverDirty) {
      this.hoverDirty = false;
      this.updateHover();
    }
  };

  /**
   * The depth ruler is CSS, tracked to the box's near-left edge every frame.
   * It hides itself when the column is too short on screen for the labels to
   * be honest about which depth they mark.
   */
  private positionRuler(): void {
    if (!this.rulerEls.length) return;
    const H = this.height();
    const v = new THREE.Vector3();
    const el = this.renderer.domElement;
    const h = el.clientHeight;
    const yOf = (d: number): number => {
      v.set(-5, -this.geo.yn(d) * H, 5).project(this.camera);
      return (-v.y * 0.5 + 0.5) * h;
    };
    const span = Math.abs(yOf(2000) - yOf(0));
    RULER.forEach((d, i) => {
      v.set(-5, -this.geo.yn(d) * H, 5).project(this.camera);
      const y = (-v.y * 0.5 + 0.5) * h;
      const tick = this.rulerEls[i]!;
      const vis = v.z < 1 && y > 4 && y < h - 4 && span > 90;
      tick.style.opacity = vis ? "1" : "0";
      tick.style.transform = "translate(16px," + (y - 8) + "px)";
    });
  }
}
