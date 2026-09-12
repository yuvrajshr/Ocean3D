/**
 * Grid lines and depth labels on the analysis box.
 *
 * A raymarched volume has no edges, so without reference lines it just looks
 * like haze. We can't light the data (that would change its colours), so the
 * structure comes from lines around it instead.
 *
 * - Only the far faces are drawn, so lines are never in front of the data.
 * - Depth lines and labels use the same ticks as the DOM depth ruler (viz/depth.ts).
 * - Depth markings are hidden for surface-only variables.
 */

import * as THREE from "three";

import { LABELLED_TICKS, RULER_TICKS } from "./depth";
import type { Extent, GeoFrame } from "./geo";

/**
 * All render orders for transparent objects in the column, in one place.
 * renderOrder isn't inherited from groups, so spreading these across files lets
 * them clash.
 *
 * The lattice has to draw before the volume: the volume doesn't write depth, so
 * anything drawn after it lands on top. (The sea surface once drew after the
 * volume and greyed out all the data colours.) Don't set renderOrder anywhere else.
 */
export const RENDER_ORDER = {
  // --- background (behind the data) ---
  sky: -10,
  terrain: -8,
  seaSurface: -6,
  marineSnow: -4,
  lightShafts: -3,
  // --- data and instruments ---
  lattice: 1,
  volume: 2,
  frame: 4,
  ribbonCasing: 5,
  ribbon: 6,
  stems: 7,
  markers: 8,
  labels: 9,
} as const;

const TOKEN_CURRENT = 0x1c6e8c;
const TOKEN_FOAM = 0xeaf3f1;

/**
 * Minor and major lines use the same colour at different opacity. Lower values
 * were invisible against the dark background.
 */
const MINOR_OPACITY = 0.3;
const MAJOR_OPACITY = 0.62;

/** Offset from the face to avoid z-fighting with the volume. */
const INSET = 0.002;

/** Label size in CSS px (--size-readout in tokens.css). */
const LABEL_PX = 12;
const LABEL_FONT = `500 ${LABEL_PX}px "IBM Plex Mono", ui-monospace, monospace`;

/** How far a label sits outside the corner post, in world units. */
const LABEL_PAD = 0.055;

export interface Lattice {
  group: THREE.Group;
  /** Show only the two far side faces. Takes sin/cos of the azimuth. */
  faceCull(sinAzimuth: number, cosAzimuth: number): void;
  /** Move the depth labels to whichever corner post is leftmost on screen. */
  anchorLabels(camera: THREE.PerspectiveCamera): void;
  /** Rescale the sprites so labels stay a fixed CSS pixel size. */
  setLabelScale(camera: THREE.PerspectiveCamera, viewportHeight: number): void;
  /** False for surface-only fields. */
  setDepthAxisVisible(visible: boolean): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

/**
 * Wait for IBM Plex Mono before drawing, otherwise the canvas falls back to a
 * generic monospace and the labels won't match the ruler.
 */
export async function ensureLabelFont(): Promise<void> {
  try {
    await document.fonts?.load(LABEL_FONT);
  } catch {
    /* No FontFaceSet, or loading failed. Fallback fonts still work. */
  }
}

function labelSprite(text: string): THREE.Sprite {
  // Same pixel-ratio cap as the renderer so labels aren't resampled.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;

  ctx.font = LABEL_FONT;
  const cssW = Math.ceil(ctx.measureText(text).width) + 4;
  const cssH = Math.ceil(LABEL_PX * 1.4);

  canvas.width = Math.ceil(cssW * dpr);
  canvas.height = Math.ceil(cssH * dpr);
  ctx.scale(dpr, dpr);
  // Resizing the canvas resets the 2D context, so set the font again.
  ctx.font = LABEL_FONT;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  // Drawn white as an alpha mask; the material sets the colour.
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, 2, cssH / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      color: new THREE.Color(TOKEN_FOAM),
      transparent: true,
      opacity: 0.72,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      sizeAttenuation: false,
    }),
  );
  sprite.renderOrder = RENDER_ORDER.labels;
  sprite.center.set(0, 0.5);
  sprite.userData.cssW = cssW;
  sprite.userData.cssH = cssH;
  return sprite;
}

/** Whole-degree values strictly inside a range (the ends are the frame edges). */
function wholeDegrees(range: [number, number]): number[] {
  const lo = Math.min(range[0], range[1]);
  const hi = Math.max(range[0], range[1]);
  const out: number[] = [];
  for (let v = Math.ceil(lo); v <= Math.floor(hi); v++) {
    if (v > lo && v < hi) out.push(v);
  }
  return out;
}

interface Face {
  group: THREE.Group;
  depthLines: THREE.Object3D[];
}

export function buildLattice(geo: GeoFrame, extent: Extent, boxSize: THREE.Vector3): Lattice {
  const group = new THREE.Group();
  const hx = boxSize.x / 2;
  const hz = boxSize.z / 2;
  const floor = -boxSize.y;

  const minorMaterial = new THREE.LineBasicMaterial({
    color: TOKEN_CURRENT,
    transparent: true,
    opacity: MINOR_OPACITY,
    depthWrite: false,
  });
  const majorMaterial = new THREE.LineBasicMaterial({
    color: TOKEN_CURRENT,
    transparent: true,
    opacity: MAJOR_OPACITY,
    depthWrite: false,
  });

  // 0 m and 2000 m are already the frame edges.
  const depthTicks = RULER_TICKS.filter((d) => d > 0 && d < 2000);
  const lats = wholeDegrees(extent.latRange);
  const lons = wholeDegrees(extent.lonRange);

  const segments = (points: number[], material: THREE.LineBasicMaterial, order: number) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    const line = new THREE.LineSegments(geometry, material);
    line.renderOrder = order;
    return line;
  };

  /**
   * ``axis`` is the face's fixed axis, ``sign`` which side it's on. Depth lines run
   * across, lat/lon lines run top to bottom.
   */
  const buildFace = (axis: "x" | "z", sign: 1 | -1): Face => {
    const faceGroup = new THREE.Group();
    const minorDepth: number[] = [];
    const majorDepth: number[] = [];
    const minorGeo: number[] = [];
    const majorGeo: number[] = [];

    if (axis === "x") {
      const x = sign * (hx - INSET);
      for (const depth of depthTicks) {
        const y = geo.depthY(depth);
        (LABELLED_TICKS.has(depth) ? majorDepth : minorDepth).push(x, y, -hz, x, y, hz);
      }
      for (const lat of lats) {
        const z = geo.z(lat);
        (lat % 5 === 0 ? majorGeo : minorGeo).push(x, 0, z, x, floor, z);
      }
    } else {
      const z = sign * (hz - INSET);
      for (const depth of depthTicks) {
        const y = geo.depthY(depth);
        (LABELLED_TICKS.has(depth) ? majorDepth : minorDepth).push(-hx, y, z, hx, y, z);
      }
      for (const lon of lons) {
        const x = geo.x(lon);
        (lon % 5 === 0 ? majorGeo : minorGeo).push(x, 0, z, x, floor, z);
      }
    }

    const depthLines: THREE.Object3D[] = [];
    if (minorDepth.length) depthLines.push(segments(minorDepth, minorMaterial, RENDER_ORDER.lattice));
    if (majorDepth.length) depthLines.push(segments(majorDepth, majorMaterial, RENDER_ORDER.lattice));
    depthLines.forEach((line) => faceGroup.add(line));

    if (minorGeo.length) faceGroup.add(segments(minorGeo, minorMaterial, RENDER_ORDER.lattice));
    if (majorGeo.length) faceGroup.add(segments(majorGeo, majorMaterial, RENDER_ORDER.lattice));

    group.add(faceGroup);
    return { group: faceGroup, depthLines };
  };

  const posX = buildFace("x", 1);
  const negX = buildFace("x", -1);
  const posZ = buildFace("z", 1);
  const negZ = buildFace("z", -1);

  // --- depth labels ---
  // All labelled ticks, including 0 m and 2000 m (no gridline there, but still
  // worth labelling).
  const labels = RULER_TICKS.filter((d) => LABELLED_TICKS.has(d)).map((depth) => {
    const sprite = labelSprite(`${depth} m`);
    sprite.position.set(0, geo.depthY(depth), 0);
    group.add(sprite);
    return sprite;
  });

  // The four vertical corner posts as (x, z). Labels go on the leftmost one.
  const posts: Array<[number, number]> = [
    [hx, hz],
    [hx, -hz],
    [-hx, hz],
    [-hx, -hz],
  ];
  const projected = new THREE.Vector3();

  let depthVisible = true;
  let viewportHeight = 1;

  /**
   * The depth axis bunches up near the surface, so in a short box labels can
   * overlap. Skip a label rather than overlap (the gridline stays).
   */
  const MIN_LABEL_GAP = LABEL_PX * 1.3;

  return {
    group,

    faceCull(sinAzimuth, cosAzimuth) {
      // cos(elevation) is always > 0, so the camera's x/z signs match the azimuth;
      // show the opposite faces.
      posX.group.visible = sinAzimuth <= 0;
      negX.group.visible = sinAzimuth > 0;
      posZ.group.visible = cosAzimuth <= 0;
      negZ.group.visible = cosAzimuth > 0;
    },

    anchorLabels(camera) {
      if (!labels.length) return;
      let best = posts[0]!;
      let bestX = Infinity;
      for (const post of posts) {
        projected.set(post[0], 0, post[1]).project(camera);
        if (projected.x < bestX) {
          bestX = projected.x;
          best = post;
        }
      }
      // Push outward from the box centre so the label clears the corner.
      const length = Math.hypot(best[0], best[1]) || 1;
      const x = best[0] + (best[0] / length) * LABEL_PAD;
      const z = best[1] + (best[1] / length) * LABEL_PAD;

      // Labels go top to bottom, so keeping the first of any close pair keeps the
      // shallower one.
      const shown = depthVisible && group.visible;
      let lastY = -Infinity;
      for (const sprite of labels) {
        sprite.position.set(x, sprite.position.y, z);
        if (!shown) {
          sprite.visible = false;
          continue;
        }
        projected.copy(sprite.position).project(camera);
        const screenY = ((1 - projected.y) / 2) * viewportHeight;
        const clear = Math.abs(screenY - lastY) >= MIN_LABEL_GAP;
        sprite.visible = clear;
        if (clear) lastY = screenY;
      }
    },

    setLabelScale(camera, height) {
      viewportHeight = height;
      // With sizeAttenuation off, world scale maps to NDC. projectionMatrix[5] is
      // 1/tan(fov/2), which gives the exact canvas size in CSS px.
      const p11 = camera.projectionMatrix.elements[5] ?? 1;
      const k = 2 / (p11 * Math.max(viewportHeight, 1));
      for (const sprite of labels) {
        sprite.scale.set(
          (sprite.userData.cssW as number) * k,
          (sprite.userData.cssH as number) * k,
          1,
        );
      }
    },

    setDepthAxisVisible(visible) {
      depthVisible = visible;
      for (const face of [posX, negX, posZ, negZ]) {
        for (const line of face.depthLines) line.visible = visible;
      }
      for (const sprite of labels) sprite.visible = visible && group.visible;
    },

    setVisible(visible) {
      group.visible = visible;
      for (const sprite of labels) sprite.visible = visible && depthVisible;
    },

    dispose() {
      group.traverse((object) => {
        const sprite = object as THREE.Sprite;
        if (sprite.isSprite) {
          // Don't dispose sprite.geometry (shared by all sprites). The texture is ours
          // and SpriteMaterial.dispose() doesn't free it.
          const material = sprite.material as THREE.SpriteMaterial;
          material.map?.dispose();
          material.dispose();
          return;
        }
        (object as THREE.Mesh).geometry?.dispose?.();
      });
      minorMaterial.dispose();
      majorMaterial.dispose();
      group.clear();
    },
  };
}
