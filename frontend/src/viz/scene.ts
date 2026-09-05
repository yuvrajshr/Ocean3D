/**
 * The 3D scene: an ocean, with the analysis inside it.
 *
 * Design notes that are decisions, not incidentals:
 *
 * - Everything is positioned through one GeoFrame (viz/geo.ts). The terrain,
 *   the sea, the volume and the markers must agree on where 15 N is, and the
 *   only way to guarantee that is to give them one mapping to share.
 * - The globe carries NASA Blue Marble imagery and is a place you can return to
 *   (context.md §5.1 Principle 7, and the two §10 entries that reverse the
 *   earlier "graticule, never a destination" decisions). What survives those
 *   reversals: the app still opens by diving, so the globe is never the default
 *   view, and the globe never rotates on its own.
 * - The globe and the descent are ONE continuous gesture (context.md §5.1,
 *   Principle 3), skipped entirely under prefers-reduced-motion.
 * - The data volume is drawn in true colormap colour with no lighting or fog.
 *   Every atmospheric effect belongs to the water around it.
 */

import * as THREE from "three";

import { depthToNorm } from "./depth";
import { OceanEffects } from "./effects";
import { ANALYSIS_HEIGHT, ANALYSIS_MAX_DEPTH, GeoFrame, type Extent } from "./geo";
import {
  buildClouds,
  buildGlobe,
  buildStarfield,
  type CloudLayer,
  CLOUDS_URL,
  DEFAULT_BASEMAP,
  type Globe,
  globeFloatMarkers,
  globeToLatLon,
  latLonToGlobe,
  NIGHT_LIGHTS_URL,
  OCEAN_MASK_URL,
  regionOutline,
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
import { TOKEN_RGB } from "./water";
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

/** One float's measured profile, ready to draw beside the model field. */
export interface ProfileTrace {
  lat: number;
  lon: number;
  /** Which variable was measured. Must match the displayed field, or nothing draws. */
  variable: string;
  points: ReadonlyArray<{ depth: number; value: number }>;
}

export type SceneExtent = Extent;

/** The two views. "column" is where the app opens and where the data lives. */
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

/** Smootherstep — no overshoot, and it settles rather than snapping. */
function ease(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * c * (c * (c * 6 - 15) + 10);
}

/**
 * Shortest signed distance from `from` to `to`, wrapped to (-π, π].
 *
 * `azimuth` accumulates unbounded across repeated drags (it is never wrapped
 * back into a fixed range), while a fly-to target comes from `atan2`, which
 * always returns a value in [-π, π]. Lerping the raw difference could send
 * the camera the long way around the globe once azimuth has wound past ±π;
 * this picks the short way regardless of how far azimuth has drifted.
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
  // Siblings of volumeGroup, never children: clearVolume() disposes everything
  // under it on every field load, which is how markers once silently vanished.
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

  // Held on the scene rather than only inside the volume material, because
  // ShaderMaterial.dispose() does not reach textures in uniforms (they leaked
  // once per timestep) and because the ribbon has to share the very same LUT.
  private volumeTexture: THREE.Data3DTexture | null = null;
  private lutTexture: THREE.DataTexture | null = null;
  /** What the texture is actually encoded against — diverging maps re-centre on zero. */
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
  private globeOutline: THREE.LineLoop | null = null;
  private globeFloats: THREE.Points | null = null;
  // Lives directly in `scene`, not `globeGroup` — it must never move with
  // the globe's fixed rotation. Visibility is synced from
  // `globeGroup.visible` once per frame in tick() rather than duplicated
  // across the several places that already toggle that flag (the pattern
  // next_session.md §6.9 warns caused markers to silently vanish before).
  private readonly starfield: THREE.Group;
  /**
   * Which of the two views is showing.
   *
   * The globe is a destination now, but never the default one — this starts on "column"
   * because the entry gesture ends there, and a forecaster's data is in the water column.
   */
  private view: SceneView = "column";
  private regionHovered = false;
  /** The lat/lon under the cursor on the globe, or null off the sphere entirely.
   * Refreshed every hover, independent of `regionHovered` — a click reads
   * this to fly toward wherever was actually clicked, not just the box. */
  private hoverLatLon: { lat: number; lon: number } | null = null;
  /**
   * The globe's own rotation, held separately from the entry's.
   *
   * `updateEntry()` writes `globeGroup.rotation.y` every frame from the camera azimuth, so
   * that the study region keeps facing the camera as it flies in. In globe mode that
   * formula must NOT run: it would counter-rotate the Earth against every drag and pin the
   * same face toward the viewer forever. So globe mode fixes the rotation once and orbits
   * the camera instead — which is also the physically honest choice, since the terminator
   * is anchored in the sphere's object space and should stay put on the Earth as the
   * viewer moves around it.
   */
  private globeRotationY = 0;

  private entryDuration = 4600;
  private entryActive = false;
  private entryProgress = 0;
  private entryLastFrame = 0;
  /**
   * Never advance the entry more than this much in a single frame.
   *
   * The gesture used to run on wall-clock time, which meant that on slow
   * hardware the whole thing elapsed across two or three rendered frames and
   * the viewer simply never saw it — the one orchestrated moment in the
   * product, invisible precisely on the machines least able to spare it. Capping
   * the per-frame step guarantees the gesture is always *seen*, taking longer in
   * wall-clock time when the machine is slow. The skip control remains.
   */
  private static readonly MAX_ENTRY_STEP = 1 / 45;

  /**
   * How quickly `distance` eases toward `distanceTarget` each frame — a
   * frame-rate-independent exponential lerp (`1 - exp(-k*dt)`), not a fixed
   * per-frame step, so zoom feels the same at 30fps and 120fps.
   */
  private static readonly ZOOM_DAMPING = 10;

  /** Smooths instantaneous drag speed into `*Velocity`, so one jittery final
   * pointer event can't produce a wild fling on release. 0 = no smoothing
   * (raw instantaneous speed), 1 = never updates. */
  private static readonly VELOCITY_SMOOTHING = 0.35;
  /** Coast angular velocity decays exponentially, per second, after release. */
  private static readonly COAST_DAMPING = 2.2;
  /** Below this angular speed (rad/s) coasting stops rather than crawling forever. */
  private static readonly COAST_STOP_SPEED = 0.02;
  /** Release must exceed this angular speed (rad/s) to start coasting at all —
   * otherwise a deliberate small nudge or a click-without-moving would drift. */
  private static readonly COAST_MIN_SPEED = 0.05;
  /** How quickly azimuth/elevation ease toward a fly-to target — slower than
   * ZOOM_DAMPING so the swoop reads as a deliberate flight, not a snap. */
  private static readonly FLYTO_DAMPING = 4.5;
  /** How close a click-anywhere fly-to swoops in — just above the globe's own
   * zoom-in floor (2.0), close enough to read as "look here" without the
   * camera clipping into the sphere. */
  private static readonly FLYTO_CLOSE_DISTANCE = 2.3;

  private azimuth = -0.62;
  // BELOW the waterline, by about 86 m, and close enough that the analysis
  // fills ~58% of frame height instead of 25%.
  //
  // This reverses §10's "elevated 3/4 view above the waterline". The geometry
  // left no third option: eye height is target.y + distance*sin(elevation), so
  // getting the box large enough to read means a smaller distance, and staying
  // dry at that distance would need a HIGHER angle — which shows the column's
  // warm lid and hides the thermocline, the exact thing §10 lowered the
  // elevation to avoid. Closer and lower is underwater.
  //
  // What survives the reversal: dragging up still returns to the basin
  // overview, so a forecaster keeps the whole-box view on demand. What it buys:
  // the light shafts and marine snow, which are gated on being underwater and
  // so had never once been visible in the default frame.
  private elevation = 0.1;
  private distance = 2.35;
  // The value `onWheel` writes; `tick()` eases the rendered `distance`
  // toward this every frame instead of snapping to it directly. Every call
  // site that hard-sets `distance` (resetColumnCamera, enterGlobe, the
  // entry gesture's completion) must also sync this, or the next scroll
  // will lurch back from a stale target.
  //
  // Seeded from `distance` above, not from the 4.4 this arrived with: the
  // globe branch predates the submerged default, and a target that disagrees
  // with the rendered distance would ease the camera back up through the
  // surface on the first frame — undoing the reversal above without a single
  // line of it changing.
  private distanceTarget = 2.35;
  private fitScale = 1;
  private readonly target = new THREE.Vector3(0, -0.44, 0);
  private dragging = false;
  private lastPointer = { x: 0, y: 0 };
  private lastPointerTime = 0;
  private pointerDownPosition = { x: 0, y: 0 };
  // Set on pointerup: did this gesture move more than a few pixels? The
  // browser fires a native "click" after a drag-release too, not just a
  // real click, and onClick uses this to ignore the former — otherwise
  // every rotate gesture ends by (mis)reading its release point as a click.
  private wasDrag = false;
  private static readonly CLICK_DRAG_THRESHOLD = 6;
  // Drag inertia: the smoothed angular speed carried into a coast after
  // release, and whether that coast is currently running. Reset to 0/false
  // on every new pointerdown and on every hard camera reset (enterGlobe,
  // resetColumnCamera) so no leftover momentum bleeds across a view switch.
  private azimuthVelocity = 0;
  private elevationVelocity = 0;
  private coasting = false;
  // Click-anywhere fly-to (globe only): the targets `tick()` eases azimuth/
  // elevation toward while `flyToActive`, set by `flyToOutsidePoint()`.
  private azimuthTarget = 0;
  private elevationTarget = 0;
  private flyToActive = false;

  onHover: ((marker: MarkerDatum | null) => void) | null = null;
  onSelect: ((marker: MarkerDatum | null) => void) | null = null;
  onEntryComplete: (() => void) | null = null;
  /** Fires when the scene changes view on its own — clicking into the region, say. */
  onViewChange: ((view: SceneView) => void) | null = null;
  /** Fires when a globe click flies toward a point outside the analysis extent —
   * there's real data to dive into only inside it, so this is the signal for the
   * "no measurement here" callout rather than pretending there's detail to find. */
  onEmptyRegionClick: (() => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(TOKEN.abyss, 1);
    // NO tone mapping. A filmic curve looks better on the water but it also
    // remaps every colour in the frame, including the data volume's — which
    // would quietly shift a reader's sense of a temperature away from what the
    // colorbar states. context.md §5.1 forbids exactly that.
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 400);
    this.worldGroup.add(this.volumeGroup, this.markerGroup, this.latticeGroup, this.profileGroup);
    this.scene.add(this.worldGroup, this.globeGroup);
    // Parented to worldGroup, not scene, so globe mode hides them with everything
    // else — depth labels have no meaning floating beside the Earth.
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

    // In globeGroup (not scene), so it shares the group's fixed rotation and
    // stays static relative to the surface rather than drifting on its own.
    this.clouds = buildClouds(CLOUDS_URL, this.renderer.capabilities.getMaxAnisotropy());
    this.globeGroup.add(this.clouds.mesh);

    this.globeGroup.visible = false;
    this.buildAtmosphere();

    this.effects = new OceanEffects(this.renderer, this.scene, this.camera);

    this.attachInput();
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  // ---------------------------------------------------------------- lifecycle

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.detachInput();
    this.effects.dispose();
    // Explicit, because the traverse below only reaches geometries and materials — it
    // would leave the basemap texture (4096×2048, ~45 MB on the GPU with mipmaps)
    // allocated on every hot reload.
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
      // Every Sprite in the process shares one module-level geometry. Disposing
      // it here would yank it out from under every other sprite on the page.
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
    // sizeAttenuation is off, so a label's world scale depends on the projection.
    this.lattice?.setLabelScale(this.camera, height);

    // Field of view is vertical, so a tall narrow viewport crops horizontally
    // and the basin runs off the sides. Pull further out to compensate.
    // The cap MUST stay low now the default view is submerged. fitScale
    // multiplies distance, and eye height is target.y + distance*fitScale*
    // sin(elevation): at the old 2.4 cap that reaches +0.12 on a narrow
    // viewport — above the water — and the whole design silently flips regime.
    // At 1.6 the worst case is -0.065, still under.
    const TARGET_ASPECT = 1.7;
    this.fitScale = Math.min(1.6, Math.max(1, TARGET_ASPECT / this.camera.aspect));
  }

  // ------------------------------------------------------------------- globe

  /** A scenario picks its own season; no-op when the basemap is already loaded. */
  setBasemap(url: string): void {
    void this.globe?.setBasemap(url);
  }

  /**
   * (Re)draw the marks on the sphere: the analysis extent, and the floats inside it.
   *
   * Rebuilt rather than mutated because both depend on the extent and the marker list,
   * and both are cheap. Kept as fields so repeated calls replace rather than accumulate —
   * the outline used to be added inside startEntry(), which leaked one loop per entry.
   */
  private refreshGlobeMarks(): void {
    if (this.globeOutline) {
      this.globeGroup.remove(this.globeOutline);
      this.globeOutline.geometry.dispose();
      (this.globeOutline.material as THREE.Material).dispose();
      this.globeOutline = null;
    }
    if (this.globeFloats) {
      this.globeGroup.remove(this.globeFloats);
      this.globeFloats.geometry.dispose();
      (this.globeFloats.material as THREE.Material).dispose();
      this.globeFloats = null;
    }

    this.globeOutline = regionOutline(this.extent.latRange, this.extent.lonRange);
    this.globeGroup.add(this.globeOutline);

    const floats = globeFloatMarkers(
      this.markers.map(({ lat, lon }) => ({ lat, lon })),
    );
    if (floats) {
      this.globeFloats = floats;
      this.globeGroup.add(floats);
    }

    this.applyRegionHighlight();
  }

  /**
   * The outline is the click target, so it has to show that it is one.
   *
   * Brightness, not opacity: 0.95 -> 1.0 is invisible, and `linewidth` does nothing in
   * WebGL, so neither of the obvious levers actually reads. Scaling the colour past 1.0
   * drives it toward white while staying `bioluminescence` — a state change, not a change
   * of meaning.
   */
  private applyRegionHighlight(): void {
    const material = this.globeOutline?.material as THREE.LineBasicMaterial | undefined;
    if (!material) return;
    material.color.setRGB(...TOKEN_RGB.bioluminescence);
    if (this.regionHovered) material.color.multiplyScalar(2.1);
    material.opacity = this.regionHovered ? 1 : 0.9;
  }

  /** Is a point on the sphere inside the analysis extent? */
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
   * Go back to the globe.
   *
   * Instant in both directions — the descent is the *entry*, and replaying a 4.6 s
   * cinematic every time someone checks where they are would turn the product's one
   * orchestrated moment into a toll. Returning to the column replays it (see
   * enterColumn) because that direction is the gesture; coming back up is navigation.
   */
  enterGlobe(): void {
    if (this.view === "globe") return;
    this.entryActive = false;
    this.view = "globe";

    this.globeGroup.visible = true;
    this.globeGroup.scale.setScalar(1);
    setGlobeOpacity(this.globeGroup, 1);
    this.worldGroup.visible = false;

    // Frame the whole sphere, centred. Radius 1.35 at a 42° vertical FOV needs ~3.8 to
    // fit; 4.05 leaves the margin of space the reference frames have around the limb.
    this.target.set(0, 0, 0);
    this.distance = this.distanceTarget = 4.05;
    this.elevation = 0.22;
    this.coasting = false;
    this.azimuthVelocity = 0;
    this.elevationVelocity = 0;
    this.flyToActive = false;

    // Fix the Earth's rotation so the study region faces the camera on arrival, then
    // leave it alone — from here the camera orbits and the Earth stays put.
    const midLon = (this.extent.lonRange[0] + this.extent.lonRange[1]) / 2;
    this.globeRotationY = THREE.MathUtils.degToRad(midLon) - Math.PI / 2 + this.azimuth;
    this.globeGroup.rotation.set(0, this.globeRotationY, 0);

    this.hoveredIndex = -1;
    this.canvas.style.cursor = "grab";
    this.onHover?.(null);
  }

  /** Dive back into the water column, replaying the entry descent. */
  enterColumn(): void {
    if (this.view === "column") return;
    this.view = "column";
    this.regionHovered = false;
    this.applyRegionHighlight();
    this.canvas.style.cursor = "grab";

    if (prefersReducedMotion()) {
      this.globeGroup.visible = false;
      this.worldGroup.visible = true;
      this.resetColumnCamera();
      this.revealMarkers();
      // Reported even though nothing was animated: the caller resets its "entry running"
      // state before calling this, and without the callback it would never clear.
      this.onEntryComplete?.();
      return;
    }
    this.startEntry();
  }

  /** Must land exactly where the entry gesture ends, or a globe round trip jumps. */
  private resetColumnCamera(): void {
    this.azimuth = -0.62;
    this.elevation = 0.1;
    // Assigned together so the eased target can never disagree with the
    // rendered distance — the docstring's "exactly" is what makes a globe
    // round trip land where the entry gesture ended.
    this.distance = this.distanceTarget = 2.35;
    this.target.set(0, -0.44, 0);
    this.coasting = false;
    this.azimuthVelocity = 0;
    this.elevationVelocity = 0;
    this.flyToActive = false;
  }

  // -------------------------------------------------------------- atmosphere

  private buildAtmosphere(): void {
    const bounds = new THREE.Vector3(7, ANALYSIS_HEIGHT * 1.7, 7);
    this.marineSnow = buildMarineSnow(bounds);
    this.lightShafts = buildLightShafts(bounds);
    this.worldGroup.add(this.marineSnow, this.lightShafts);
  }

  // ----------------------------------------------------------------- terrain

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
   * The relief dissolves in the analysis box's own half-widths, so the uniform
   * has to follow the extent rather than being baked at build time. Called from
   * both setTerrain and setExtent, because either can arrive first.
   */
  private applyTerrainBounds(): void {
    const material = this.terrainMesh?.material as THREE.ShaderMaterial | undefined;
    const uniform = material?.uniforms.uBoxHalf;
    if (!uniform) return;
    (uniform.value as THREE.Vector2).set(this.boxSize.x / 2, this.boxSize.z / 2);
  }

  // ------------------------------------------------------------------ volume

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
   * The lattice belongs to the extent, not the field: it states where the box
   * is, which does not change when the variable does. Rebuilding it here rather
   * than in setField also keeps it clear of clearVolume().
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

  /** Vertical exaggeration, so the UI can state it rather than imply it. */
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

    // encodedRange, not valueRange: a diverging map re-centres on zero, so the
    // texture is encoded against a different span than the metadata reports.
    // Anything colouring alongside the volume has to use what it actually used.
    const { texture, encodedRange } = buildVolumeTexture(values, geometry, valueRange, colormap);
    this.volumeTexture = texture;
    this.lutTexture = buildLutTexture(colormap);
    this.encodedRange = encodedRange;
    this.fieldVariable = variable;
    this.fieldHasDepth = (geometry.shape[0] ?? 1) > 1;

    const material = createVolumeMaterial({ volume: texture, lut: this.lutTexture });

    // A UNIT cube scaled to the field's aspect. The raymarch shader intersects
    // against [-0.5, 0.5] in object space, so a pre-sized geometry would leave
    // it marching only the central unit cube and clipping the field away.
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    mesh.scale.copy(this.boxSize);
    // Hung from the sea surface: top face at y = 0, bottom at the 2000 m mark.
    mesh.position.set(0, -this.boxSize.y / 2, 0);
    mesh.renderOrder = RENDER_ORDER.volume;
    this.volumeMesh = mesh;
    this.volumeGroup.add(mesh);

    this.buildFrame();

    // A surface variable carries one level smeared down the whole box. Marking
    // depths on it would assert a measurement at 500 m that does not exist.
    this.lattice?.setDepthAxisVisible(this.fieldHasDepth);
    this.setDepthWindow(this.depthWindow[0], this.depthWindow[1]);
    this.rebuildRibbon();
  }

  /** A hairline cage stating the analysis extent, now that the data fades out. */
  private buildFrame(): void {
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(this.boxSize.x, this.boxSize.y, this.boxSize.z)),
      new THREE.LineBasicMaterial({ color: TOKEN.current, transparent: true, opacity: 0.34 }),
    );
    edges.position.set(0, -this.boxSize.y / 2, 0);
    edges.renderOrder = RENDER_ORDER.frame;
    this.volumeGroup.add(edges);
  }

  /** Clears only the field. Markers, lattice and ribbon are siblings and survive.
   *
   *  Public because the layer panel calls it directly to drop a field when a
   *  layer is switched off, rather than round-tripping through a re-fetch. */
  clearVolume(): void {
    for (const child of [...this.volumeGroup.children]) {
      this.volumeGroup.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose?.();
      (mesh.material as THREE.Material | undefined)?.dispose?.();
    }
    // ShaderMaterial.dispose() does not reach textures held in uniforms, so
    // without this every variable or timestep change orphaned a 3D texture.
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

  // --------------------------------------------------------- profile ribbon

  /**
   * The selected float's measured profile, drawn where it was measured and
   * coloured on the same scale as the water around it. This is the co-display
   * the problem statement asks for, happening in the viewport rather than only
   * in a side panel.
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

    // Colouring an observed temperature through the current-speed ramp would be
    // a lie the reader cannot see. When the float and the field disagree, draw
    // nothing — the marker's own stem already says where the float is.
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

    // Figure/ground separation, drawn behind — never a wash on top.
    //
    // `foam`, not `abyss`, and the reason is worth keeping: most of a profile's
    // length is deep water, which sits at the COLD end of every cmocean ramp and
    // is therefore nearly black. A dark casing cannot separate dark from dark, so
    // the first attempt made a correct ribbon invisible. A light sheath separates
    // in both directions. It encodes nothing; only the core carries a value.
    // Kept to ~1.4x rather than 1.8x: the ribbon is a few pixels wide at the
    // default camera, and a wider casing swallowed the colour it exists to frame.
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

  // ----------------------------------------------------------------- markers

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
    // The globe carries the same floats, so it is rebuilt from the same list. Done before
    // the early return so clearing the markers clears them on the sphere too.
    this.refreshGlobeMarks();
    if (markers.length === 0) return;

    // Per-instance colour comes from instanceColor, which the renderer
    // multiplies against the material colour. `vertexColors` must stay off: it
    // makes the shader look for a geometry colour attribute that does not exist
    // here, and every marker renders black.
    const mesh = new THREE.InstancedMesh(
      // Was 0.02, sized for a camera 1.9x further out. Same apparent size.
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
    // The markers are the ONLY thing permitted to bloom. Enabling (not setting)
    // keeps them in the normal render too. Nothing added since — lattice, labels,
    // ribbon — goes on that layer: the bloom pass renders it alone, so anything
    // on it is unoccludable and would glow through the water and the Earth.
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
   * Markers are instruments, not data, so they must sit below the colormap in
   * the frame's value order. At full token brightness a resting marker renders
   * at foam (0.918, 0.953, 0.945) — level with the top of every cmocean ramp —
   * so it competed with the field it exists to point at. Resting states are
   * dimmed; only the selected one is allowed to be the brightest chrome.
   *
   * Both the initial colouring and every refresh go through here, so they
   * cannot drift apart.
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
    // The descent is meant to arrive at the instruments, not fly through them.
    this.lattice?.setVisible(true);
    if (this.ribbon) this.ribbon.visible = true;
    if (this.ribbonCasing) this.ribbonCasing.visible = true;
  }

  // ------------------------------------------------------------------- input

  /** Almost to either pole on the globe, but never past — the rig degenerates at ±π/2.
   * Allowed below the horizon in column view so the viewer can dive under the surface. */
  private clampElevation(value: number): number {
    return this.view === "globe"
      ? Math.max(-1.35, Math.min(1.35, value))
      : Math.max(-0.85, Math.min(1.35, value));
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    this.dragging = true;
    // Grabbing the globe always regains immediate control, whether a coast
    // from a previous release or an in-flight fly-to swoop was running.
    this.coasting = false;
    this.azimuthVelocity = 0;
    this.elevationVelocity = 0;
    this.flyToActive = false;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.lastPointerTime = performance.now();
    // Where the gesture started, so onClick can tell a real click (the
    // pointer barely moved) from a drag that happened to release over the
    // same element — the browser fires "click" after both.
    this.pointerDownPosition = { x: event.clientX, y: event.clientY };
    this.canvas.setPointerCapture(event.pointerId);
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    this.dragging = false;
    // Only a deliberate flick starts a coast — a slow drag or a click that
    // barely moved leaves the velocity near zero and nothing drifts.
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
      // Floored rather than left free, so two events on the same frame (dt≈0)
      // can't produce a divide-by-near-zero velocity spike.
      const dt = Math.max((now - this.lastPointerTime) / 1000, 1 / 240);
      this.lastPointer = { x: event.clientX, y: event.clientY };
      this.lastPointerTime = now;

      const azimuthStep = -dx * 0.006;
      const elevationStep = dy * 0.005;
      this.azimuth += azimuthStep;
      this.elevation = this.clampElevation(this.elevation + elevationStep);

      // Smoothed instantaneous angular speed, carried into onPointerUp to
      // decide whether — and how fast — to coast.
      const k = 1 - OceanScene.VELOCITY_SMOOTHING;
      this.azimuthVelocity += (azimuthStep / dt - this.azimuthVelocity) * k;
      this.elevationVelocity += (elevationStep / dt - this.elevationVelocity) * k;
      return;
    }
    this.updateHover();
  };

  private readonly onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const next = this.distanceTarget + event.deltaY * 0.0016;
    // The globe's near limit has to clear its own radius (1.35) or the camera ends up
    // inside the Earth, looking at the back of the texture.
    this.distanceTarget = this.view === "globe"
      ? Math.max(2.0, Math.min(9, next))
      : Math.max(1.2, Math.min(11, next));
  };

  private readonly onClick = () => {
    // A drag that released over the canvas still fires a native "click" —
    // this isn't one, so it shouldn't dive, select a marker, or fly
    // anywhere. Without this, every rotate gesture would end by reading its
    // release point as a click on whatever it happened to land on.
    if (this.wasDrag) return;

    // On the globe, clicking the analysis extent dives into it — unchanged,
    // and still the spatial route in (the header toggle is the discoverable,
    // keyboard-reachable one). Clicking anywhere else on the sphere now flies
    // the camera toward that point instead of doing nothing.
    if (this.view === "globe") {
      if (this.regionHovered) {
        this.enterColumn();
        this.onViewChange?.("column");
      } else if (this.hoverLatLon) {
        this.flyToOutsidePoint(this.hoverLatLon.lat, this.hoverLatLon.lon);
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
   * Fly the camera toward a clicked point outside the analysis extent, and
   * settle into a close orbit of it there.
   *
   * This is the honest version of "zoom in for detail": real detail only
   * exists inside the extent — that's the dive, unchanged above — so a click
   * elsewhere gets a closer look at the same basemap and the
   * `onEmptyRegionClick` signal for an explicit "no measurement here," never
   * fabricated detail (context.md §5.1 Principle 7).
   */
  private flyToOutsidePoint(lat: number, lon: number): void {
    const sphere = this.globe?.sphere;
    if (!sphere) return;

    // Three.js's own object-to-world transform, symmetric with
    // updateGlobeHover's worldToLocal — avoids hand-inverting globeGroup's
    // rotation to get from a lat/lon back to a world-space direction.
    const worldNormal = sphere.localToWorld(latLonToGlobe(lat, lon, 1)).normalize();

    // tick() renders the camera along the direction
    // (cosE*sin(az), sinE, cosE*cos(az)) from `target` — see the position
    // assignment there. Aligning that direction with the clicked point's
    // world normal is exactly "face the camera at this point."
    this.elevationTarget = this.clampElevation(
      Math.asin(THREE.MathUtils.clamp(worldNormal.y, -1, 1)),
    );
    this.azimuthTarget = Math.atan2(worldNormal.x, worldNormal.z);
    this.distanceTarget = OceanScene.FLYTO_CLOSE_DISTANCE;

    // A fly-to takeover always wins over a coast in progress — same "regain
    // control" rule as grabbing the globe.
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
   * Globe hover: is the cursor over the analysis extent, and where is it, period?
   *
   * Raycasts the sphere and tests the resulting lat/lon against the extent, rather than
   * raycasting the outline itself. A LineLoop is a nearly un-hittable target — a few
   * pixels wide, and only its edges — whereas this makes the whole region clickable, which
   * is what a reader expects from a box drawn on a map.
   *
   * `hoverLatLon` is refreshed on every call, independent of the `regionHovered`
   * early-return below, so a click always knows exactly where it landed —
   * not just the last point where inside/outside status changed.
   */
  private updateGlobeHover(): void {
    const sphere = this.globe?.sphere;
    if (!sphere) return;

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(sphere, false)[0];

    let inside = false;
    if (hit) {
      // World space to the sphere's own space, so the globe's rotation is undone before
      // the position is read as a place on Earth.
      const local = sphere.worldToLocal(hit.point.clone());
      this.hoverLatLon = globeToLatLon(local);
      inside = this.isInsideExtent(this.hoverLatLon.lat, this.hoverLatLon.lon);
    } else {
      this.hoverLatLon = null;
    }

    if (inside === this.regionHovered) return;
    this.regionHovered = inside;
    this.applyRegionHighlight();
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

  // ------------------------------------------------------------------- entry

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
      // Hand-off: the sphere opens into the sea it contains.
      const k = ease((t - 0.52) / 0.2);
      this.globeGroup.visible = true;
      this.worldGroup.visible = true;
      this.globeGroup.scale.setScalar(1 + k * 1.8);
      setGlobeOpacity(this.globeGroup, 1 - k);
      // Ends on 3.3 / 0.40 / -0.70, which is exactly where the settle begins.
      // The old curve handed off at 4.2 and resumed at 4.1 — a small jump that
      // was invisible only because the settle was so gentle.
      this.distance = 3.5 - k * 0.2;
      this.elevation = 0.49 - k * 0.09;
      this.azimuth = -0.8 + k * 0.1;
    } else {
      // Settle into the working view — and, now, THROUGH the surface. Eye
      // height runs from +1.14 to -0.21 across this phase, so the gesture's
      // last beat is a real dive rather than a hover above the water.
      //
      // These four must land exactly on resetColumnCamera(), or returning from
      // the globe jumps.
      const k = ease((t - 0.72) / 0.28);
      this.globeGroup.visible = false;
      this.worldGroup.visible = true;
      this.distance = 3.3 - k * 0.95;
      this.elevation = 0.4 - k * 0.3;
      this.azimuth = -0.7 + k * 0.08;
      this.target.y = -0.14 - k * 0.3;
    }

    // Turn the study region to face the camera. Done after the phase branches
    // so it uses this frame's azimuth, not the previous one's.
    //
    // The globe shader derives longitude as atan2(n.z, n.x), so a point at
    // longitude L sits at angle L in the xz plane, and rotating the globe by
    // theta moves it to L - theta. The camera at azimuth `az` looks along the
    // direction at angle (pi/2 - az); setting those equal gives the rotation
    // below. The previous formula ignored the camera azimuth entirely, which is
    // why the entry used to fly toward the Atlantic.
    const midLon = (this.extent.lonRange[0] + this.extent.lonRange[1]) / 2;
    this.globeGroup.rotation.y =
      THREE.MathUtils.degToRad(midLon) - Math.PI / 2 + this.azimuth;
    this.globeGroup.rotation.x = 0;

    if (t >= 1) {
      this.entryActive = false;
      this.globeGroup.visible = false;
      this.globeGroup.scale.setScalar(1);
      this.revealMarkers();
      // The entry writes `distance` directly every frame without touching
      // `distanceTarget`; sync it now so the first post-entry scroll eases
      // from where the camera actually is, not from a stale target.
      this.distanceTarget = this.distance;
      // Any coast or fly-to running before the dive started (from a flick or
      // a swoop on the globe) was frozen, not stopped, while entryActive
      // gated it out of tick() — clear it so it doesn't silently resume in
      // the column.
      this.coasting = false;
      this.azimuthVelocity = 0;
      this.elevationVelocity = 0;
      this.flyToActive = false;
      this.onEntryComplete?.();
    }
  }

  // -------------------------------------------------------------------- loop

  private tick(): void {
    if (this.disposed) return;
    const now = performance.now();
    // `getDelta()` advances the clock and returns the frame time; reading
    // `elapsedTime` afterward (rather than calling `getElapsedTime()`, which
    // would call `getDelta()` again) gives the same running total this file
    // used to get from `getElapsedTime()`, without consuming a second delta.
    const delta = Math.min(this.clock.getDelta(), 0.1);
    const time = this.clock.elapsedTime;
    if (this.entryActive) {
      this.updateEntry(now);
    } else {
      // Eased toward `distanceTarget` rather than snapped, so a scroll glides to a stop.
      // Skipped during the entry gesture, which drives `distance` directly every frame.
      this.distance += (this.distanceTarget - this.distance)
        * (1 - Math.exp(-OceanScene.ZOOM_DAMPING * delta));

      // Click-anywhere fly-to (globe only): eases azimuth/elevation toward
      // the target set by flyToOutsidePoint(); `distance` is already easing
      // toward FLYTO_CLOSE_DISTANCE via the block above, since it shares
      // `distanceTarget` with ordinary zoom. Mutually exclusive with
      // coasting below — flyToOutsidePoint() and onPointerDown both clear
      // `coasting` before this ever runs.
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
        // Drag inertia: coasts on the velocity carried out of the last drag,
        // decaying exponentially until it's imperceptible. onPointerDown
        // cancels this immediately, so grabbing the globe mid-coast regains
        // control at once rather than fighting it.
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

    // Elevation is clamped inside ±90°, so cosE > 0 and the camera's x/z signs
    // are the azimuth's — which is all the far-face choice needs.
    if (this.lattice && this.worldGroup.visible) {
      this.lattice.faceCull(sinA, cosA);
      this.lattice.anchorLabels(this.camera);
    }

    // The sky follows the camera so the horizon never runs out. It belongs to the sea, so
    // it is hidden whenever the sea is — which puts the globe against space rather than
    // against a horizon gradient, as the reference frames have it. During the hand-off
    // phase both groups are visible and the sky comes up with the water.
    this.sky?.position.copy(this.camera.position);
    if (this.sky) this.sky.visible = this.worldGroup.visible;
    // Synced here rather than at each of the several call sites that toggle
    // globeGroup.visible — see the field's own comment for why.
    this.starfield.visible = this.globeGroup.visible;

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
      // Turn broadside to the camera, with a fixed per-shaft offset so they do
      // not read as one card pivoting. See buildLightShafts.
      shaft.rotation.y = this.azimuth + ((shaft.userData.jitter as number) ?? 0);
    });

    if (this.volumeMesh) {
      const material = this.volumeMesh.material as THREE.ShaderMaterial;
      // The shader marches in the box's own space, so hand it the camera there.
      material.uniforms.uCameraLocal!.value.copy(
        this.volumeMesh.worldToLocal(this.camera.position.clone()),
      );
    }

    this.effects.render();

    this.frame++;
    // Measured against performance.now() directly. Calling clock.getDelta()
    // here would reset the same clock getElapsedTime() drives, and would time
    // one frame rather than ten.
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

  /** Rolling frame rate, so verification can report it rather than guess. */
  get fps(): number {
    if (this.fpsSamples.length === 0) return 0;
    return this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
  }

  get isUnderwater(): boolean {
    return this.camera.position.y < 0;
  }

  /** Exposed so verification can catch the entry gesture deterministically. */
  get isGlobeVisible(): boolean {
    return this.globeGroup.visible;
  }

  /**
   * Exposed for verification. Markers have silently vanished on group rebuilds before
   * (next_session.md §6.8), and switching views rebuilds groups, so the count is checked
   * across round trips rather than assumed.
   */
  get markerCount(): number {
    return this.markers.length;
  }

  set sunDirection(direction: THREE.Vector3) {
    SUN_DIRECTION.copy(direction.normalize());
  }
}
