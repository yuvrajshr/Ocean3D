/**
 * The 3D scene: the globe, and the water column with the analysis inside it.
 *
 * - Everything is positioned through one GeoFrame (viz/geo.ts) so terrain, sea,
 *   volume and markers agree on where things are.
 * - The globe uses NASA Blue Marble. The move from globe to column is one
 *   continuous animation, skipped under prefers-reduced-motion.
 * - The data volume uses the raw colormap colours, no lighting or fog.
 */

import * as THREE from "three";

import { depthToNorm } from "./depth";
import { OceanEffects } from "./effects";
import { ANALYSIS_HEIGHT, ANALYSIS_MAX_DEPTH, GeoFrame, type Extent } from "./geo";
import {
  buildClouds,
  buildFloatMarkers,
  buildGlobe,
  buildStarfield,
  type CloudLayer,
  CLOUDS_URL,
  DEFAULT_BASEMAP,
  type FloatMarkers,
  type Globe,
  globeToLatLon,
  latLonToGlobe,
  NIGHT_LIGHTS_URL,
  OCEAN_MASK_URL,
  setGlobeOpacity,
} from "./globe";
import {
  BLOOM_LAYER,
  buildLightShafts,
  buildMarineSnow,
  buildSeaSurface,
  buildSky,
  SUN_DIRECTION,
} from "./ocean";
import { buildLattice, ensureLabelFont, type Lattice, RENDER_ORDER } from "./lattice";
import { buildTerrainMesh, type TerrainField } from "./terrain";
import {
  buildLutTexture,
  buildVolumeTexture,
  createProfileMaterial,
  createVolumeMaterial,
  type FieldGeometry,
} from "./volume";
import type { ColormapName } from "./colormaps";

const TOKEN = {
  abyss: 0x050b12,
  thermocline: 0x0d2436,
  current: 0x1c6e8c,
  bioluminescence: 0x4fe8c4,
  advisory: 0xe8a23d,
  foam: 0xeaf3f1,
} as const;

export interface MarkerDatum {
  id: string;
  platformId: string;
  lat: number;
  lon: number;
  maxDepth: number;
  featured: boolean;
}

/** One float's measured profile, to draw next to the model field. */
export interface ProfileTrace {
  lat: number;
  lon: number;
  /** Measured variable. Has to match the displayed field or nothing is drawn. */
  variable: string;
  points: ReadonlyArray<{ depth: number; value: number }>;
}

export type SceneExtent = Extent;

/** The two views the scene knows about. */
export type SceneView = "globe" | "column";

export function isWebGL2Available(): boolean {
  try {
    return Boolean(document.createElement("canvas").getContext("webgl2"));
  } catch {
    return false;
  }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Smootherstep easing (no overshoot). */
function ease(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * c * (c * (c * 6 - 15) + 10);
}

/**
 * Shortest signed angle from ``from`` to ``to``, in (-π, π].
 *
 * azimuth keeps growing across drags while atan2 targets are in [-π, π], so a
 * plain difference could fly the long way round.
 */
function shortestAngleDelta(from: number, to: number): number {
  const twoPi = Math.PI * 2;
  return (((to - from + Math.PI) % twoPi) + twoPi) % twoPi - Math.PI;
}

export class OceanScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly effects: OceanEffects;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly clock = new THREE.Clock();

  private readonly worldGroup = new THREE.Group();
  private readonly volumeGroup = new THREE.Group();
  private readonly markerGroup = new THREE.Group();
  private readonly globeGroup = new THREE.Group();
  // Siblings of volumeGroup, not children, because clearVolume() disposes
  // everything under it.
  private readonly latticeGroup = new THREE.Group();
  private readonly profileGroup = new THREE.Group();

  private sky: THREE.Mesh | null = null;
  private seaSurface: THREE.Mesh | null = null;
  private terrainMesh: THREE.Mesh | null = null;
  private marineSnow: THREE.Points | null = null;
  private lightShafts: THREE.Group | null = null;
  private volumeMesh: THREE.Mesh | null = null;
  private markerMesh: THREE.InstancedMesh | null = null;
  private markerStems: THREE.LineSegments | null = null;
  private lattice: Lattice | null = null;

  // Kept here because ShaderMaterial.dispose() doesn't free textures in uniforms,
  // and the ribbon needs the same LUT.
  private volumeTexture: THREE.Data3DTexture | null = null;
  private lutTexture: THREE.DataTexture | null = null;
  /** Range the texture is encoded against (diverging maps are re-centred on zero). */
  private encodedRange: [number, number] = [0, 1];
  private fieldVariable = "";
  private fieldHasDepth = true;
  private depthWindow: [number, number] = [0, ANALYSIS_MAX_DEPTH];

  private ribbon: THREE.Mesh | null = null;
  private ribbonCasing: THREE.Mesh | null = null;
  private profile: ProfileTrace | null = null;

  private geo = new GeoFrame({ latRange: [5, 22], lonRange: [80, 95] });
  private extent: SceneExtent = { latRange: [5, 22], lonRange: [80, 95] };
  private boxSize = new THREE.Vector3(2, ANALYSIS_HEIGHT, 2);
  private markers: MarkerDatum[] = [];
  private hoveredIndex = -1;
  private selectedIndex = -1;

  private frame = 0;
  private disposed = false;
  private fpsSamples: number[] = [];
  private lastFpsMark = 0;

  private globe: Globe | null = null;
  private clouds: CloudLayer | null = null;
  private globeFloats: FloatMarkers | null = null;
  // Added to the scene, not globeGroup, so it doesn't rotate with the globe.
  // Visibility is synced from globeGroup.visible in tick().
  private readonly starfield: THREE.Group;
  /** Current view. Starts as "column" since that's where the entry animation ends. */
  private view: SceneView = "column";
  private regionHovered = false;
  /** Lat/lon under the cursor on the globe, or null when off the sphere. */
  private hoverLatLon: { lat: number; lon: number } | null = null;
  /**
   * The globe's rotation in globe mode.
   *
   * During the entry, updateEntry() rotates the globe so the study region faces the
   * camera. In globe mode we fix the rotation and orbit the camera instead,
   * otherwise every drag would be cancelled out (and the day/night line stays put).
   */
  private globeRotationY = 0;

  private entryDuration = 4600;
  private entryActive = false;
  private entryProgress = 0;
  private entryLastFrame = 0;
  /**
   * Max entry progress per frame, so the animation is still visible on slow
   * machines instead of finishing in two or three frames.
   */
  private static readonly MAX_ENTRY_STEP = 1 / 45;

  /** Zoom easing rate, using 1 - exp(-k*dt) so it's frame-rate independent. */
  private static readonly ZOOM_DAMPING = 10;

  /**
   * Drag speed smoothing so one jittery last event doesn't cause a wild fling.
   * 0 = none, 1 = never updates.
   */
  private static readonly VELOCITY_SMOOTHING = 0.35;
  /** Coast speed decay per second after release. */
  private static readonly COAST_DAMPING = 2.2;
  /** Coasting stops below this angular speed (rad/s). */
  private static readonly COAST_STOP_SPEED = 0.02;
  /** Minimum release speed (rad/s) to start coasting, so small nudges don't drift. */
  private static readonly COAST_MIN_SPEED = 0.05;
  /** Fly-to easing rate, slower than zoom so it looks like a flight. */
  private static readonly FLYTO_DAMPING = 4.5;
  /** How close a click fly-to gets (the zoom-in limit is 2.0). */
  private static readonly FLYTO_CLOSE_DISTANCE = 2.3;

  /**
   * Idle spin (globe only) starts after this many seconds with no drag, coast
   * or fly-to.
   */
  private static readonly IDLE_SPIN_DELAY = 3.5;
  /** Seconds to ramp the idle spin up to full speed. */
  private static readonly IDLE_SPIN_RAMP = 4;
  /** Idle spin speed in rad/s (~5 minutes per rotation). */
  private static readonly IDLE_SPIN_SPEED = 0.021;

  private azimuth = -0.62;
  // Default camera sits ~86 m below the surface, close enough that the analysis
  // fills most of the frame. Staying above the water at this distance would need a
  // steeper angle, which only shows the top of the column. Dragging up still gets
  // you the overview.
  private elevation = 0.1;
  private distance = 2.35;
  // Zoom target set by onWheel; tick() eases ``distance`` towards it. Anything that
  // sets ``distance`` directly (resetColumnCamera, enterGlobe, end of entry) must
  // update this too, or the next scroll jumps.
  private distanceTarget = 2.35;
  private fitScale = 1;
  private readonly target = new THREE.Vector3(0, -0.44, 0);
  private dragging = false;
  private lastPointer = { x: 0, y: 0 };
  private lastPointerTime = 0;
  private pointerDownPosition = { x: 0, y: 0 };
  // Set on pointerup if the pointer moved more than a few pixels, so onClick can
  // ignore the click the browser fires after a drag.
  private wasDrag = false;
  private static readonly CLICK_DRAG_THRESHOLD = 6;
  // Drag inertia. Reset on pointerdown and on camera resets so momentum doesn't
  // carry across a view switch.
  private azimuthVelocity = 0;
  private elevationVelocity = 0;
  private coasting = false;
  // Idle spin timing. lastInteractionTime resets on any pointer or wheel input;
  // idleSpinRampTime only grows while the spin is easing in.
  private lastInteractionTime = performance.now();
  private idleSpinRampTime = 0;
  // Fly-to targets (globe only), set by flyToOutsidePoint().
  private azimuthTarget = 0;
  private elevationTarget = 0;
  private flyToActive = false;

  onHover: ((marker: MarkerDatum | null) => void) | null = null;
  onSelect: ((marker: MarkerDatum | null) => void) | null = null;
  onEntryComplete: (() => void) | null = null;
  /** Fires when the scene changes view by itself (e.g. clicking into the region). */
  onViewChange: ((view: SceneView) => void) | null = null;
  /**
   * Fires when a globe click lands outside the analysis area, so the UI can say
   * there's no data there.
   */
  onEmptyRegionClick: (() => void) | null = null;

  /** Fires with the lat/lon of a click on the globe (opens the chunk view). */
  onGlobePick: ((lat: number, lon: number) => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(TOKEN.abyss, 1);
    // No tone mapping. It would also shift the data colours away from the colorbar.
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 400);
    this.worldGroup.add(this.volumeGroup, this.markerGroup, this.latticeGroup, this.profileGroup);
    this.scene.add(this.worldGroup, this.globeGroup);
    // Labels live in worldGroup so they hide with it in globe mode.
    void ensureLabelFont();

    this.sky = buildSky();
    this.scene.add(this.sky);
    this.seaSurface = buildSeaSurface();
    this.worldGroup.add(this.seaSurface);

    this.starfield = buildStarfield();
    this.starfield.visible = false;
    this.scene.add(this.starfield);

    this.globe = buildGlobe({
      basemapUrl: DEFAULT_BASEMAP,
      maxAnisotropy: this.renderer.capabilities.getMaxAnisotropy(),
      specularMaskUrl: OCEAN_MASK_URL,
      nightLightsUrl: NIGHT_LIGHTS_URL,
    });
    this.globeGroup.add(this.globe.group);

    // In globeGroup so the clouds rotate with the Earth.
    this.clouds = buildClouds(CLOUDS_URL, this.renderer.capabilities.getMaxAnisotropy());
    this.globeGroup.add(this.clouds.mesh);

    this.globeGroup.visible = false;
    this.buildAtmosphere();

    this.effects = new OceanEffects(this.renderer, this.scene, this.camera);

    this.attachInput();
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  // --- lifecycle ---

  /**
   * Pause or resume rendering.
   *
   * The chunk view is a second full-screen WebGL canvas on top of this one, so we
   * stop drawing while it's open. Nothing is torn down, so coming back is instant.
   */
  setPaused(paused: boolean): void {
    if (this.disposed) return;
    this.renderer.setAnimationLoop(paused ? null : () => this.tick());
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.detachInput();
    this.effects.dispose();
    // The traverse below only reaches geometries and materials, so free the basemap
    // texture (~45 MB on the GPU) explicitly.
    this.globe?.dispose();
    this.globe = null;
    this.lattice?.dispose();
    this.lattice = null;
    this.volumeTexture?.dispose();
    this.volumeTexture = null;
    this.lutTexture?.dispose();
    this.lutTexture = null;
    this.clouds?.dispose();
    this.clouds = null;
    this.scene.traverse((object) => {
      // Sprites share one geometry; don't dispose it.
      if ((object as THREE.Sprite).isSprite) return;
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose?.();
    });
    this.renderer.dispose();
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const { clientWidth: width, clientHeight: height } = parent;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.effects.setSize(width, height);
    // Labels don't use sizeAttenuation, so their scale depends on the projection.
    this.lattice?.setLabelScale(this.camera, height);

    // FOV is vertical, so narrow viewports crop the sides; pull back to compensate.
    // Keep the cap low (1.6): at 2.4 a narrow viewport lifts the camera above the water.
    const TARGET_ASPECT = 1.7;
    this.fitScale = Math.min(1.6, Math.max(1, TARGET_ASPECT / this.camera.aspect));
  }

  // --- globe ---

  /** Switch basemap month. Does nothing if it's already loaded. */
  setBasemap(url: string): void {
    void this.globe?.setBasemap(url);
  }

  /**
   * Redraw the floats on the globe. Rebuilt each time since it's cheap.
   *
   * There's no outline drawn for the analysis area, but isInsideExtent() still
   * uses its bounds for clicks.
   */
  private refreshGlobeMarks(): void {
    if (this.globeFloats) {
      this.globeGroup.remove(this.globeFloats.object);
      this.globeFloats.dispose();
      this.globeFloats = null;
    }

    const floats = buildFloatMarkers(this.markers.map(({ lat, lon }) => ({ lat, lon })));
    if (floats) {
      this.globeFloats = floats;
      this.globeGroup.add(floats.object);
    }
  }

  /** Is a point on the globe inside the analysis area? */
  private isInsideExtent(lat: number, lon: number): boolean {
    const [lat0, lat1] = this.extent.latRange;
    const [lon0, lon1] = this.extent.lonRange;
    return lat >= Math.min(lat0, lat1) && lat <= Math.max(lat0, lat1)
      && lon >= Math.min(lon0, lon1) && lon <= Math.max(lon0, lon1);
  }

  get currentView(): SceneView {
    return this.view;
  }

  /**
   * Switch to the globe. Instant: only going down into the column replays the
   * entry animation.
   */
  enterGlobe(): void {
    if (this.view === "globe") return;
    this.entryActive = false;
    this.view = "globe";

    this.globeGroup.visible = true;
    this.globeGroup.scale.setScalar(1);
    setGlobeOpacity(this.globeGroup, 1);
    this.worldGroup.visible = false;

    // Frame the whole globe. Radius 1.35 at 42° FOV needs ~3.8; 4.05 leaves some margin.
    this.target.set(0, 0, 0);
    this.distance = this.distanceTarget = 4.05;
    this.elevation = 0.22;
    this.coasting = false;
    this.azimuthVelocity = 0;
    this.elevationVelocity = 0;
    this.flyToActive = false;
    // Start the idle timer on arrival.
    this.lastInteractionTime = performance.now();
    this.idleSpinRampTime = 0;

    // Rotate the Earth once so the study region faces the camera; after that only
    // the camera moves.
    const midLon = (this.extent.lonRange[0] + this.extent.lonRange[1]) / 2;
    this.globeRotationY = THREE.MathUtils.degToRad(midLon) - Math.PI / 2 + this.azimuth;
    this.globeGroup.rotation.set(0, this.globeRotationY, 0);

    this.hoveredIndex = -1;
    this.canvas.style.cursor = "grab";
    this.onHover?.(null);
  }

  /** Go back into the water column, replaying the entry animation. */
  enterColumn(): void {
    if (this.view === "column") return;
    this.view = "column";
    this.regionHovered = false;
    this.canvas.style.cursor = "grab";

    if (prefersReducedMotion()) {
      this.globeGroup.visible = false;
      this.worldGroup.visible = true;
      this.resetColumnCamera();
      this.revealMarkers();
      // Call this even with no animation, the caller waits on it to reset its state.
      this.onEntryComplete?.();
      return;
    }
    this.startEntry();
  }

  /** Zoom in, within the current view's limits. */
  zoomIn(factor = 0.75): void {
    this.lastInteractionTime = performance.now();
    this.idleSpinRampTime = 0;
    const next = this.distanceTarget * factor;
    this.distanceTarget = this.view === "globe"
      ? Math.max(2.0, Math.min(9, next))
      : Math.max(1.2, Math.min(11, next));
  }

  /** Zoom out, within the current view's limits. */
  zoomOut(factor = 1.33): void {
    this.lastInteractionTime = performance.now();
    this.idleSpinRampTime = 0;
    const next = this.distanceTarget * factor;
    this.distanceTarget = this.view === "globe"
      ? Math.max(2.0, Math.min(9, next))
      : Math.max(1.2, Math.min(11, next));
  }

  /** Reset the globe camera and rotation. */
  resetGlobeCamera(): void {
    this.lastInteractionTime = performance.now();
    this.idleSpinRampTime = 0;
    this.target.set(0, 0, 0);
    this.distance = this.distanceTarget = 4.05;
    this.elevation = 0.22;
    this.coasting = false;
    this.azimuthVelocity = 0;
    this.elevationVelocity = 0;
    this.flyToActive = false;
    const midLon = (this.extent.lonRange[0] + this.extent.lonRange[1]) / 2;
    this.globeRotationY = THREE.MathUtils.degToRad(midLon) - Math.PI / 2 + this.azimuth;
    this.globeGroup.rotation.set(0, this.globeRotationY, 0);
    this.canvas.style.cursor = "grab";
  }

  /** Must match where the entry animation ends, or a globe round trip jumps. */
  resetColumnCamera(): void {
    this.azimuth = -0.62;
    this.elevation = 0.1;
    // Set both so the eased target matches the actual distance.
    this.distance = this.distanceTarget = 2.35;
    this.target.set(0, -0.44, 0);
    this.coasting = false;
    this.azimuthVelocity = 0;
    this.elevationVelocity = 0;
    this.flyToActive = false;
  }

  /** Reset the camera for the current view. */
  resetCamera(): void {
    if (this.view === "globe") {
      this.resetGlobeCamera();
    } else {
      this.resetColumnCamera();
    }
  }

  // --- atmosphere ---

  private buildAtmosphere(): void {
    const bounds = new THREE.Vector3(7, ANALYSIS_HEIGHT * 1.7, 7);
    this.marineSnow = buildMarineSnow(bounds);
    this.lightShafts = buildLightShafts(bounds);
    this.worldGroup.add(this.marineSnow, this.lightShafts);
  }

  // --- terrain ---

  setTerrain(field: TerrainField): void {
    if (this.terrainMesh) {
      this.worldGroup.remove(this.terrainMesh);
      this.terrainMesh.geometry.dispose();
      (this.terrainMesh.material as THREE.Material).dispose();
    }
    this.terrainMesh = buildTerrainMesh(field, this.geo);
    this.worldGroup.add(this.terrainMesh);
    this.applyTerrainBounds();
  }

  /**
   * The terrain fade depends on the analysis box, so update it from both
   * setTerrain and setExtent (either can come first).
   */
  private applyTerrainBounds(): void {
    const material = this.terrainMesh?.material as THREE.ShaderMaterial | undefined;
    const uniform = material?.uniforms.uBoxHalf;
    if (!uniform) return;
    (uniform.value as THREE.Vector2).set(this.boxSize.x / 2, this.boxSize.z / 2);
  }

  // --- volume ---

  setExtent(extent: SceneExtent): void {
    this.extent = extent;
    this.geo = new GeoFrame(extent);
    const span = this.geo.spanOf(extent);
    this.boxSize = new THREE.Vector3(span.width, ANALYSIS_HEIGHT, span.depth);
    this.refreshGlobeMarks();
    this.rebuildLattice();
    this.applyTerrainBounds();
  }

  /**
   * The lattice depends on the extent, not the field, so it's rebuilt here and
   * not touched by clearVolume().
   */
  private rebuildLattice(): void {
    this.lattice?.dispose();
    this.latticeGroup.clear();
    this.lattice = buildLattice(this.geo, this.extent, this.boxSize);
    this.lattice.setDepthAxisVisible(this.fieldHasDepth);
    this.lattice.setVisible(!this.entryActive);
    this.lattice.setLabelScale(this.camera, this.renderer.domElement.clientHeight || 1);
    this.latticeGroup.add(this.lattice.group);
  }

  /** Vertical exaggeration, so the UI can show it. */
  get verticalExaggeration(): number {
    return this.geo.verticalExaggeration();
  }

  setField(
    values: Float32Array,
    geometry: FieldGeometry,
    valueRange: [number, number],
    colormap: ColormapName,
    variable: string,
  ): void {
    this.clearVolume();

    // Use encodedRange, not valueRange: diverging maps are re-centred on zero.
    const { texture, encodedRange } = buildVolumeTexture(values, geometry, valueRange, colormap);
    this.volumeTexture = texture;
    this.lutTexture = buildLutTexture(colormap);
    this.encodedRange = encodedRange;
    this.fieldVariable = variable;
    this.fieldHasDepth = (geometry.shape[0] ?? 1) > 1;

    const material = createVolumeMaterial({ volume: texture, lut: this.lutTexture });

    // Unit cube scaled to the field's aspect. The raymarch shader works in
    // [-0.5, 0.5] object space, so a pre-sized box would get clipped.
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    mesh.scale.copy(this.boxSize);
    // Top face at y = 0 (sea surface), bottom at 2000 m.
    mesh.position.set(0, -this.boxSize.y / 2, 0);
    mesh.renderOrder = RENDER_ORDER.volume;
    this.volumeMesh = mesh;
    this.volumeGroup.add(mesh);

    this.buildFrame();

    // Surface-only variables have no depth, so hide the depth labels.
    this.lattice?.setDepthAxisVisible(this.fieldHasDepth);
    this.setDepthWindow(this.depthWindow[0], this.depthWindow[1]);
    this.rebuildRibbon();
  }

  /** Thin wireframe showing the analysis extent. */
  private buildFrame(): void {
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(this.boxSize.x, this.boxSize.y, this.boxSize.z)),
      new THREE.LineBasicMaterial({ color: TOKEN.current, transparent: true, opacity: 0.34 }),
    );
    edges.position.set(0, -this.boxSize.y / 2, 0);
    edges.renderOrder = RENDER_ORDER.frame;
    this.volumeGroup.add(edges);
  }

  /**
   * Clears only the field; markers, lattice and ribbon stay. Public so the layer
   * panel can drop a field without refetching.
   */
  clearVolume(): void {
    for (const child of [...this.volumeGroup.children]) {
      this.volumeGroup.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose?.();
      (mesh.material as THREE.Material | undefined)?.dispose?.();
    }
    // ShaderMaterial.dispose() doesn't free textures in uniforms, so do it here.
    this.volumeTexture?.dispose();
    this.volumeTexture = null;
    this.lutTexture?.dispose();
    this.lutTexture = null;
    this.volumeMesh = null;
  }

  setDepthWindow(minDepth: number, maxDepth: number): void {
    this.depthWindow = [minDepth, maxDepth];
    const min = depthToNorm(minDepth);
    const max = depthToNorm(maxDepth);
    for (const object of [this.volumeMesh, this.ribbon, this.ribbonCasing]) {
      const material = object?.material as THREE.ShaderMaterial | undefined;
      if (!material) continue;
      material.uniforms.uDepthMin!.value = min;
      material.uniforms.uDepthMax!.value = max;
    }
  }

  // --- profile ribbon ---

  /**
   * Draw the selected float's profile in place, coloured on the same scale as the
   * water around it.
   */
  setProfile(profile: ProfileTrace | null): void {
    this.profile = profile;
    this.rebuildRibbon();
  }

  private clearRibbon(): void {
    for (const child of [...this.profileGroup.children]) {
      this.profileGroup.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose?.();
      (mesh.material as THREE.Material | undefined)?.dispose?.();
    }
    this.ribbon = null;
    this.ribbonCasing = null;
  }

  private rebuildRibbon(): void {
    this.clearRibbon();

    const profile = this.profile;
    const lut = this.lutTexture;
    if (!profile || !lut) return;

    // Only draw if the float's variable matches the field, otherwise the colours
    // would mean something else.
    if (profile.variable !== this.fieldVariable) return;

    const points = profile.points
      .filter((p) => Number.isFinite(p.value) && p.depth <= ANALYSIS_MAX_DEPTH && p.depth >= 0)
      .slice()
      .sort((a, b) => a.depth - b.depth);
    if (points.length < 2) return;

    const count = points.length;
    const position = new Float32Array(count * 6);
    const side = new Float32Array(count * 2);
    const value = new Float32Array(count * 2);
    const norm = new Float32Array(count * 2);

    points.forEach((point, i) => {
      const world = this.geoToWorld(profile.lat, profile.lon, point.depth);
      for (const half of [0, 1]) {
        const v = i * 2 + half;
        position[v * 3] = world.x;
        position[v * 3 + 1] = world.y;
        position[v * 3 + 2] = world.z;
        side[v] = half === 0 ? -1 : 1;
        value[v] = point.value;
        norm[v] = depthToNorm(point.depth);
      }
    });

    const indices: number[] = [];
    for (let i = 0; i < count - 1; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }

    const build = (halfWidth: number, casingColor: number | undefined, opacity: number) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
      geometry.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
      geometry.setAttribute("aValue", new THREE.BufferAttribute(value, 1));
      geometry.setAttribute("aNorm", new THREE.BufferAttribute(norm, 1));
      geometry.setIndex(indices);
      return new THREE.Mesh(
        geometry,
        createProfileMaterial({ lut, encodedRange: this.encodedRange, halfWidth, casingColor, opacity }),
      );
    };

    // Light casing behind the ribbon. Most of a profile is deep, cold water, which
    // is near-black in every cmocean ramp, so a dark casing wouldn't show up.
    // ~1.4x the width so it doesn't swallow the colour.
    const casing = build(0.027, TOKEN.foam, 0.36);
    casing.renderOrder = RENDER_ORDER.ribbonCasing;
    casing.visible = !this.entryActive;
    this.ribbonCasing = casing;
    this.profileGroup.add(casing);

    const ribbon = build(0.019, undefined, 1);
    ribbon.renderOrder = RENDER_ORDER.ribbon;
    ribbon.visible = !this.entryActive;
    this.ribbon = ribbon;
    this.profileGroup.add(ribbon);

    this.setDepthWindow(this.depthWindow[0], this.depthWindow[1]);
  }

  setSliceMode(enabled: boolean, depth: number): void {
    const material = this.volumeMesh?.material as THREE.ShaderMaterial | undefined;
    if (!material) return;
    material.uniforms.uSlice!.value = enabled ? 1 : 0;
    material.uniforms.uSliceDepth!.value = depthToNorm(depth);
  }

  // --- markers ---

  setMarkers(markers: MarkerDatum[]): void {
    if (this.markerMesh) {
      this.markerGroup.remove(this.markerMesh);
      this.markerMesh.geometry.dispose();
      (this.markerMesh.material as THREE.Material).dispose();
      this.markerMesh = null;
    }
    if (this.markerStems) {
      this.markerGroup.remove(this.markerStems);
      this.markerStems.geometry.dispose();
      (this.markerStems.material as THREE.Material).dispose();
      this.markerStems = null;
    }
    this.markers = markers;
    this.hoveredIndex = -1;
    // Rebuild the globe floats from the same list (before the early return so
    // clearing works too).
    this.refreshGlobeMarks();
    if (markers.length === 0) return;

    // Colour comes from instanceColor. Keep vertexColors off or every marker renders black.
    const mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.011, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
      markers.length,
    );
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(markers.length * 3), 3);

    const stemPoints: number[] = [];
    const matrix = new THREE.Matrix4();

    markers.forEach((marker, index) => {
      const p = this.geoToWorld(marker.lat, marker.lon, 0);
      matrix.makeTranslation(p.x, p.y, p.z);
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(index, this.markerColour(index, marker, new THREE.Color()));

      const bottom = this.geoToWorld(marker.lat, marker.lon, Math.min(marker.maxDepth, ANALYSIS_MAX_DEPTH));
      stemPoints.push(p.x, p.y, p.z, bottom.x, bottom.y, bottom.z);
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.renderOrder = RENDER_ORDER.markers;
    // Only the markers bloom. Anything else on BLOOM_LAYER would glow through the
    // water and the Earth, since the bloom pass renders that layer alone.
    mesh.layers.enable(BLOOM_LAYER);
    mesh.visible = !this.entryActive;
    this.markerMesh = mesh;
    this.markerGroup.add(mesh);

    const stems = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(stemPoints, 3)),
      new THREE.LineBasicMaterial({ color: TOKEN.bioluminescence, transparent: true, opacity: 0.2 }),
    );
    stems.renderOrder = RENDER_ORDER.stems;
    stems.visible = !this.entryActive;
    this.markerStems = stems;
    this.markerGroup.add(stems);
  }

  setSelected(platformId: string | null): void {
    this.selectedIndex = platformId ? this.markers.findIndex((m) => m.platformId === platformId) : -1;
    this.refreshMarkerColors();
  }

  /**
   * Markers are dimmed so they don't outshine the data; only the selected one
   * is at full brightness. Used for both first colouring and refreshes.
   */
  private markerColour(index: number, marker: MarkerDatum, into: THREE.Color): THREE.Color {
    if (index === this.selectedIndex) return into.setHex(TOKEN.advisory);
    if (index === this.hoveredIndex) return into.setHex(TOKEN.bioluminescence);
    if (marker.featured) return into.setHex(TOKEN.bioluminescence).multiplyScalar(0.78);
    return into.setHex(TOKEN.foam).multiplyScalar(0.62);
  }

  private refreshMarkerColors(): void {
    const mesh = this.markerMesh;
    if (!mesh?.instanceColor) return;
    const colour = new THREE.Color();
    this.markers.forEach((marker, index) => {
      mesh.setColorAt(index, this.markerColour(index, marker, colour));
    });
    mesh.instanceColor.needsUpdate = true;
  }

  private geoToWorld(lat: number, lon: number, depth: number): THREE.Vector3 {
    return new THREE.Vector3(this.geo.x(lon), this.geo.depthY(depth), this.geo.z(lat));
  }

  private revealMarkers(): void {
    if (this.markerMesh) this.markerMesh.visible = true;
    if (this.markerStems) this.markerStems.visible = true;
    // Show the lattice once the camera has arrived.
    this.lattice?.setVisible(true);
    if (this.ribbon) this.ribbon.visible = true;
    if (this.ribbonCasing) this.ribbonCasing.visible = true;
  }

  // --- input ---

  /**
   * Clamp elevation: almost to the poles on the globe (the rig breaks at ±π/2);
   * below the horizon is allowed in column view.
   */
  private clampElevation(value: number): number {
    return this.view === "globe"
      ? Math.max(-1.35, Math.min(1.35, value))
      : Math.max(-0.85, Math.min(1.35, value));
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    this.dragging = true;
    // Grabbing the globe cancels any coast or fly-to.
    this.coasting = false;
    this.azimuthVelocity = 0;
    this.elevationVelocity = 0;
    this.flyToActive = false;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.lastPointerTime = performance.now();
    this.lastInteractionTime = this.lastPointerTime;
    this.idleSpinRampTime = 0;
    // Remember where the pointer went down so onClick can tell clicks from drags.
    this.pointerDownPosition = { x: event.clientX, y: event.clientY };
    this.canvas.setPointerCapture(event.pointerId);
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    this.dragging = false;
    // Only a real flick starts a coast.
    this.coasting = Math.hypot(this.azimuthVelocity, this.elevationVelocity)
      > OceanScene.COAST_MIN_SPEED;
    this.wasDrag = Math.hypot(
      event.clientX - this.pointerDownPosition.x,
      event.clientY - this.pointerDownPosition.y,
    ) > OceanScene.CLICK_DRAG_THRESHOLD;
    try { this.canvas.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    if (this.dragging) {
      const dx = event.clientX - this.lastPointer.x;
      const dy = event.clientY - this.lastPointer.y;
      const now = performance.now();
      // Clamp dt so two events in the same frame don't spike the velocity.
      const dt = Math.max((now - this.lastPointerTime) / 1000, 1 / 240);
      this.lastPointer = { x: event.clientX, y: event.clientY };
      this.lastPointerTime = now;
      this.lastInteractionTime = now;

      const azimuthStep = -dx * 0.006;
      const elevationStep = dy * 0.005;
      this.azimuth += azimuthStep;
      this.elevation = this.clampElevation(this.elevation + elevationStep);

      // Smoothed angular speed, used on pointerup to decide whether to coast.
      const k = 1 - OceanScene.VELOCITY_SMOOTHING;
      this.azimuthVelocity += (azimuthStep / dt - this.azimuthVelocity) * k;
      this.elevationVelocity += (elevationStep / dt - this.elevationVelocity) * k;
      return;
    }
    this.updateHover();
  };

  private readonly onWheel = (event: WheelEvent) => {
    event.preventDefault();
    this.lastInteractionTime = performance.now();
    this.idleSpinRampTime = 0;
    const next = this.distanceTarget + event.deltaY * 0.0016;
    // Keep the camera outside the globe (radius 1.35).
    this.distanceTarget = this.view === "globe"
      ? Math.max(2.0, Math.min(9, next))
      : Math.max(1.2, Math.min(11, next));
  };

  private readonly onClick = () => {
    // Ignore the click event that follows a drag.
    if (this.wasDrag) return;

    // On the globe, clicking anywhere opens the chunk for that point. Without a
    // handler we fly the camera there instead.
    if (this.view === "globe") {
      if (this.hoverLatLon) {
        if (this.onGlobePick) this.onGlobePick(this.hoverLatLon.lat, this.hoverLatLon.lon);
        else if (!this.regionHovered) {
          this.flyToOutsidePoint(this.hoverLatLon.lat, this.hoverLatLon.lon);
        }
      }
      return;
    }
    if (this.hoveredIndex >= 0) {
      const marker = this.markers[this.hoveredIndex]!;
      this.selectedIndex = this.hoveredIndex;
      this.refreshMarkerColors();
      this.onSelect?.(marker);
    }
  };

  /**
   * Fly toward a point outside the analysis area and orbit it closely. We only
   * have data inside the area, so this also fires onEmptyRegionClick.
   */
  private flyToOutsidePoint(lat: number, lon: number): void {
    const sphere = this.globe?.sphere;
    if (!sphere) return;

    // Use Three's localToWorld instead of inverting the globe rotation by hand.
    const worldNormal = sphere.localToWorld(latLonToGlobe(lat, lon, 1)).normalize();

    // tick() places the camera along (cosE*sin(az), sinE, cosE*cos(az)) from target,
    // so match that direction to the clicked point's normal.
    this.elevationTarget = this.clampElevation(
      Math.asin(THREE.MathUtils.clamp(worldNormal.y, -1, 1)),
    );
    this.azimuthTarget = Math.atan2(worldNormal.x, worldNormal.z);
    this.distanceTarget = OceanScene.FLYTO_CLOSE_DISTANCE;

    // Fly-to overrides any coast.
    this.coasting = false;
    this.azimuthVelocity = 0;
    this.elevationVelocity = 0;

    if (prefersReducedMotion()) {
      this.azimuth = this.azimuthTarget;
      this.elevation = this.elevationTarget;
      this.distance = this.distanceTarget;
    } else {
      this.flyToActive = true;
    }
    this.onEmptyRegionClick?.();
  }

  private attachInput(): void {
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("click", this.onClick);
  }

  private detachInput(): void {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("click", this.onClick);
  }

  /**
   * Globe hover: is the cursor over the analysis area, and where is it?
   *
   * We raycast the sphere and check the lat/lon against the extent, which makes the
   * whole region clickable. hoverLatLon is updated on every call so clicks always
   * know where they landed.
   */
  private updateGlobeHover(): void {
    const sphere = this.globe?.sphere;
    if (!sphere) return;

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(sphere, false)[0];

    let inside = false;
    if (hit) {
      // Convert to the sphere's local space to undo the globe's rotation.
      const local = sphere.worldToLocal(hit.point.clone());
      this.hoverLatLon = globeToLatLon(local);
      inside = this.isInsideExtent(this.hoverLatLon.lat, this.hoverLatLon.lon);
    } else {
      this.hoverLatLon = null;
    }

    if (inside === this.regionHovered) return;
    this.regionHovered = inside;
    this.canvas.style.cursor = inside ? "pointer" : "grab";
  }

  private updateHover(): void {
    if (this.entryActive) return;
    if (this.view === "globe") {
      this.updateGlobeHover();
      return;
    }
    if (!this.markerMesh) return;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.markerMesh, false);
    const next = hits.length > 0 && hits[0]!.instanceId !== undefined ? hits[0]!.instanceId! : -1;
    if (next === this.hoveredIndex) return;
    this.hoveredIndex = next;
    this.refreshMarkerColors();
    this.canvas.style.cursor = next >= 0 ? "pointer" : "grab";
    this.onHover?.(next >= 0 ? this.markers[next]! : null);
  }

  focusMarker(platformId: string): void {
    const index = this.markers.findIndex((m) => m.platformId === platformId);
    if (index < 0) return;
    this.selectedIndex = index;
    this.refreshMarkerColors();
    this.onSelect?.(this.markers[index]!);
  }

  // --- entry animation ---

  startEntry(): void {
    this.view = "column";
    if (prefersReducedMotion()) {
      this.globeGroup.visible = false;
      this.worldGroup.visible = true;
      this.entryActive = false;
      this.resetColumnCamera();
      this.revealMarkers();
      this.onEntryComplete?.();
      return;
    }
    this.globeGroup.visible = true;
    this.globeGroup.scale.setScalar(1);
    setGlobeOpacity(this.globeGroup, 1);
    this.worldGroup.visible = false;
    this.entryProgress = 0;
    this.entryLastFrame = performance.now();
    this.entryActive = true;
  }

  skipEntry(): void {
    if (!this.entryActive) return;
    this.entryActive = false;
    this.view = "column";
    this.globeGroup.visible = false;
    this.globeGroup.scale.setScalar(1);
    this.worldGroup.visible = true;
    this.resetColumnCamera();
    this.revealMarkers();
    this.onEntryComplete?.();
  }

  private updateEntry(now: number): void {
    const elapsed = now - this.entryLastFrame;
    this.entryLastFrame = now;
    this.entryProgress = Math.min(
      1,
      this.entryProgress + Math.min(elapsed / this.entryDuration, OceanScene.MAX_ENTRY_STEP),
    );
    const t = this.entryProgress;

    if (t < 0.52) {
      // Approach: fall toward the basin.
      const k = ease(t / 0.52);
      this.globeGroup.visible = true;
      this.worldGroup.visible = false;
      this.distance = 9.5 - k * 6.0;
      this.elevation = 0.95 - k * 0.46;
      this.azimuth = -1.15 + k * 0.35;
    } else if (t < 0.72) {
      // Hand-off from the globe to the sea.
      const k = ease((t - 0.52) / 0.2);
      this.globeGroup.visible = true;
      this.worldGroup.visible = true;
      this.globeGroup.scale.setScalar(1 + k * 1.8);
      setGlobeOpacity(this.globeGroup, 1 - k);
      // Ends on 3.3 / 0.40 / -0.70, where the settle phase starts.
      this.distance = 3.5 - k * 0.2;
      this.elevation = 0.49 - k * 0.09;
      this.azimuth = -0.8 + k * 0.1;
    } else {
      // Settle into the working view, going through the surface. These values must
      // match resetColumnCamera() or returning from the globe jumps.
      const k = ease((t - 0.72) / 0.28);
      this.globeGroup.visible = false;
      this.worldGroup.visible = true;
      this.distance = 3.3 - k * 0.95;
      this.elevation = 0.4 - k * 0.3;
      this.azimuth = -0.7 + k * 0.08;
      this.target.y = -0.14 - k * 0.3;
    }

    // Rotate the globe so the study region faces the camera, using this frame's azimuth.
    //
    // The globe shader uses longitude = atan2(n.z, n.x), so rotating by theta moves
    // longitude L to L - theta. The camera at azimuth az looks along (pi/2 - az);
    // setting them equal gives the rotation below.
    const midLon = (this.extent.lonRange[0] + this.extent.lonRange[1]) / 2;
    this.globeGroup.rotation.y =
      THREE.MathUtils.degToRad(midLon) - Math.PI / 2 + this.azimuth;
    this.globeGroup.rotation.x = 0;

    if (t >= 1) {
      this.entryActive = false;
      this.globeGroup.visible = false;
      this.globeGroup.scale.setScalar(1);
      this.revealMarkers();
      // Entry sets distance directly, so sync the zoom target now.
      this.distanceTarget = this.distance;
      // Clear any coast or fly-to that was paused during the entry, so it doesn't
      // resume in the column.
      this.coasting = false;
      this.azimuthVelocity = 0;
      this.elevationVelocity = 0;
      this.flyToActive = false;
      this.onEntryComplete?.();
    }
  }

  // --- render loop ---

  private tick(): void {
    if (this.disposed) return;
    const now = performance.now();
    // getDelta() advances the clock; read elapsedTime after it instead of calling
    // getElapsedTime(), which would call getDelta() again.
    const delta = Math.min(this.clock.getDelta(), 0.1);
    const time = this.clock.elapsedTime;
    if (this.entryActive) {
      this.updateEntry(now);
    } else {
      // Ease towards the zoom target (skipped during the entry animation).
      this.distance += (this.distanceTarget - this.distance)
        * (1 - Math.exp(-OceanScene.ZOOM_DAMPING * delta));

      // Globe fly-to: ease azimuth/elevation to the target. distance is already
      // easing via the zoom code above. Never runs together with coasting.
      if (this.flyToActive) {
        const k = 1 - Math.exp(-OceanScene.FLYTO_DAMPING * delta);
        this.azimuth += shortestAngleDelta(this.azimuth, this.azimuthTarget) * k;
        this.elevation += (this.elevationTarget - this.elevation) * k;
        const azimuthDiff = Math.abs(shortestAngleDelta(this.azimuth, this.azimuthTarget));
        const elevationDiff = Math.abs(this.elevationTarget - this.elevation);
        if (azimuthDiff < 0.002 && elevationDiff < 0.002) {
          this.azimuth = this.azimuthTarget;
          this.elevation = this.elevationTarget;
          this.flyToActive = false;
        }
      } else if (this.coasting) {
        // Drag inertia, decaying until it's too small to notice.
        this.azimuth += this.azimuthVelocity * delta;
        this.elevation = this.clampElevation(this.elevation + this.elevationVelocity * delta);
        const decay = Math.exp(-OceanScene.COAST_DAMPING * delta);
        this.azimuthVelocity *= decay;
        this.elevationVelocity *= decay;
        if (Math.hypot(this.azimuthVelocity, this.elevationVelocity) < OceanScene.COAST_STOP_SPEED) {
          this.coasting = false;
          this.azimuthVelocity = 0;
          this.elevationVelocity = 0;
        }
      }

      // Idle spin (globe only): after IDLE_SPIN_DELAY with no input, slowly ease into
      // an azimuth drift. Any input resets it to zero.
      if (
        this.view === "globe" &&
        !this.flyToActive &&
        !this.coasting &&
        !prefersReducedMotion()
      ) {
        const idleFor = (now - this.lastInteractionTime) / 1000;
        if (idleFor > OceanScene.IDLE_SPIN_DELAY) {
          this.idleSpinRampTime = Math.min(
            this.idleSpinRampTime + delta,
            OceanScene.IDLE_SPIN_RAMP,
          );
          const ramp = ease(this.idleSpinRampTime / OceanScene.IDLE_SPIN_RAMP);
          this.azimuth += OceanScene.IDLE_SPIN_SPEED * ramp * delta;
        } else {
          this.idleSpinRampTime = 0;
        }
      } else {
        this.idleSpinRampTime = 0;
      }
    }

    const cosE = Math.cos(this.elevation);
    const sinA = Math.sin(this.azimuth);
    const cosA = Math.cos(this.azimuth);
    const radius = this.distance * this.fitScale;
    this.camera.position.set(
      this.target.x + radius * cosE * sinA,
      this.target.y + radius * Math.sin(this.elevation),
      this.target.z + radius * cosE * cosA,
    );
    this.camera.lookAt(this.target);

    // Elevation is within ±90°, so the camera's x/z signs come from azimuth, which
    // is all the far-face choice needs.
    if (this.lattice && this.worldGroup.visible) {
      this.lattice.faceCull(sinA, cosA);
      this.lattice.anchorLabels(this.camera);
    }

    // The sky follows the camera and is hidden with the sea, so the globe sits
    // against space.
    this.sky?.position.copy(this.camera.position);
    if (this.sky) this.sky.visible = this.worldGroup.visible;
    // Keep the starfield in sync with the globe.
    this.starfield.visible = this.globeGroup.visible;
    // Globe marker animation (pulse and glow crossfade, see buildFloatMarkers).
    // Uses the eased distance so it matches what's on screen.
    if (this.globeGroup.visible) {
      this.globeFloats?.update({ time, cameraDistance: this.distance });
    }

    const underwater = this.camera.position.y < 0;
    if (this.marineSnow) this.marineSnow.visible = underwater && this.worldGroup.visible;
    if (this.lightShafts) this.lightShafts.visible = underwater && this.worldGroup.visible;

    // --- per-frame uniforms ---
    const setUniform = (material: THREE.Material | undefined, name: string, value: unknown) => {
      const shader = material as THREE.ShaderMaterial | undefined;
      if (shader?.uniforms?.[name]) shader.uniforms[name]!.value = value;
    };

    setUniform(this.seaSurface?.material as THREE.Material, "uTime", time);
    if (this.seaSurface) {
      const uniforms = (this.seaSurface.material as THREE.ShaderMaterial).uniforms;
      uniforms.uCameraPos!.value.copy(this.camera.position);
    }
    if (this.terrainMesh) {
      const uniforms = (this.terrainMesh.material as THREE.ShaderMaterial).uniforms;
      uniforms.uTime!.value = time;
      uniforms.uCameraPos!.value.copy(this.camera.position);
    }
    setUniform(this.marineSnow?.material as THREE.Material, "uTime", time);
    this.lightShafts?.children.forEach((shaft) => {
      setUniform((shaft as THREE.Mesh).material as THREE.Material, "uTime", time);
      // Face the camera, with a small per-shaft offset so they don't all turn together.
      shaft.rotation.y = this.azimuth + ((shaft.userData.jitter as number) ?? 0);
    });

    if (this.volumeMesh) {
      const material = this.volumeMesh.material as THREE.ShaderMaterial;
      // The shader works in the box's local space, so pass the camera position in it.
      material.uniforms.uCameraLocal!.value.copy(
        this.volumeMesh.worldToLocal(this.camera.position.clone()),
      );
    }

    this.effects.render();

    this.frame++;
    // Use performance.now() directly; clock.getDelta() here would reset the clock.
    if (this.frame % 10 === 0) {
      if (this.lastFpsMark > 0) {
        const seconds = (now - this.lastFpsMark) / 1000;
        if (seconds > 0) {
          this.fpsSamples.push(10 / seconds);
          if (this.fpsSamples.length > 12) this.fpsSamples.shift();
        }
      }
      this.lastFpsMark = now;
    }
  }

  get frameCount(): number {
    return this.frame;
  }

  /** Rolling frame rate. */
  get fps(): number {
    if (this.fpsSamples.length === 0) return 0;
    return this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
  }

  get isUnderwater(): boolean {
    return this.camera.position.y < 0;
  }

  /** Whether the globe is visible (used by tests). */
  get isGlobeVisible(): boolean {
    return this.globeGroup.visible;
  }

  /** Number of markers (used by tests to check they survive view switches). */
  get markerCount(): number {
    return this.markers.length;
  }

  set sunDirection(direction: THREE.Vector3) {
    SUN_DIRECTION.copy(direction.normalize());
  }
}
