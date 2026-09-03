/**
 * The lattice: the analysis box's own instrument markings.
 *
 * Why this exists (context.md §5.1, Principle 8). A raymarched field has no
 * edges, and the eye reads structure from edges — so the volume reads as haze
 * at any density, and no `uDensity` value fixes it. Lighting the data is
 * forbidden (it would shift a colour away from what the colorbar states), so
 * the form has to come from around the data rather than from shading it.
 *
 * Three rules keep this an instrument rather than chart trim:
 *
 *  1. Only the FAR faces draw, so the lattice is never between the reader and
 *     the data. The camera orbits by azimuth with elevation clamped inside
 *     ±90°, so cos(elevation) > 0 always and the choice is two sign bits — see
 *     `faceCull`.
 *  2. Depth lines sit at RULER_TICKS and labels at LABELLED_TICKS, the same
 *     arrays viz/depth.ts hands the DOM DepthRuler. The two agree literally,
 *     not approximately.
 *  3. Depth markings vanish for a field with no depth dimension. Four of the
 *     seven variables are surface-only; writing "500 m" beside one would assert
 *     a measurement that does not exist. See `setDepthAxisVisible`.
 */

import * as THREE from "three";

import { LABELLED_TICKS, RULER_TICKS } from "./depth";
import type { Extent, GeoFrame } from "./geo";

/**
 * One table for every transparent object in the column, because renderOrder is
 * read off the leaf and not inherited from a group — spreading these across
 * files is how they drift apart.
 *
 * The lattice MUST sort before the volume. The volume runs `depthWrite: false`
 * and so never occludes anything; ordered after it, a grid geometrically behind
 * the data would draw on top of it.
 */
export const RENDER_ORDER = {
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
 * Minor and major share a token and differ only in weight, like the ruler's
 * ticks. Tuned up from 0.16/0.38 on first look: `current` is a dark teal and
 * the ground behind it is `abyss`, so the first pass was invisible — a lattice
 * that cannot be seen supplies none of the edges it exists to supply.
 */
const MINOR_OPACITY = 0.3;
const MAJOR_OPACITY = 0.62;

/** Pulled off the face so it cannot z-fight the volume's BackSide fragments. */
const INSET = 0.002;

/** Label size in CSS pixels — --size-readout (12px) from tokens.css. */
const LABEL_PX = 12;
const LABEL_FONT = `500 ${LABEL_PX}px "IBM Plex Mono", ui-monospace, monospace`;

/** How far outboard of the corner post a label sits, in world units. */
const LABEL_PAD = 0.055;

export interface Lattice {
  group: THREE.Group;
  /** Show only the two far side faces. Takes sin/cos of azimuth, already computed by the caller. */
  faceCull(sinAzimuth: number, cosAzimuth: number): void;
  /** Move the depth labels to whichever corner post currently reads leftmost. */
  anchorLabels(camera: THREE.PerspectiveCamera): void;
  /** Recompute sprite scale so labels stay at an exact CSS pixel size. */
  setLabelScale(camera: THREE.PerspectiveCamera, viewportHeight: number): void;
  /** False for surface-only fields, which have no depth to mark. */
  setDepthAxisVisible(visible: boolean): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

/**
 * The canvas must not be drawn before IBM Plex Mono is parsed, or ctx.font
 * silently falls back to generic monospace and the 3D labels stop matching the
 * DOM ruler they are supposed to agree with.
 */
export async function ensureLabelFont(): Promise<void> {
  try {
    await document.fonts?.load(LABEL_FONT);
  } catch {
    /* No FontFaceSet, or the face failed. The fallback stack still renders. */
  }
}

function labelSprite(text: string): THREE.Sprite {
  // Match the renderer's own pixel ratio cap so a label is never resampled.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;

  ctx.font = LABEL_FONT;
  const cssW = Math.ceil(ctx.measureText(text).width) + 4;
  const cssH = Math.ceil(LABEL_PX * 1.4);

  canvas.width = Math.ceil(cssW * dpr);
  canvas.height = Math.ceil(cssH * dpr);
  ctx.scale(dpr, dpr);
  // Re-set: resizing the canvas resets every 2D context property.
  ctx.font = LABEL_FONT;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  // Drawn white, as a pure alpha mask. The colour comes from the material, so
  // the label lands at the same apparent brightness as the rest of the chrome.
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

/** Whole-degree values strictly inside a range — the ends are the frame's own edges. */
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

  // 0 m and 2000 m are the frame's own top and bottom edges; a line there doubles up.
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
   * `axis` is the face's constant axis; `sign` which side it sits on. Depth
   * lines run across the face horizontally, geographic lines run top to bottom.
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

  // --- depth labels -------------------------------------------------------
  // Every labelled tick, including 0 m and 2000 m: those get no gridline
  // because the frame already draws that edge, but the reader still wants the
  // number on it.
  const labels = RULER_TICKS.filter((d) => LABELLED_TICKS.has(d)).map((depth) => {
    const sprite = labelSprite(`${depth} m`);
    sprite.position.set(0, geo.depthY(depth), 0);
    group.add(sprite);
    return sprite;
  });

  // The four vertical corner posts, as (x, z) pairs. Labels hang off whichever
  // reads leftmost on screen.
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
   * The depth axis is a 0.65 power curve, so the top ticks bunch — fine on the
   * DOM ruler, which is tall, but in a box a couple of hundred pixels high
   * "50 m" and "100 m" land on top of each other. Drop a label rather than let
   * two overlap: an unreadable number is worse than a missing one, and the
   * gridline it belongs to is still drawn.
   */
  const MIN_LABEL_GAP = LABEL_PX * 1.3;

  return {
    group,

    faceCull(sinAzimuth, cosAzimuth) {
      // cos(elevation) > 0 always, so the camera's x and z signs are the
      // azimuth's. The far face is the one on the opposite side. Complementary
      // comparisons keep exactly one of each pair up at the degenerate value.
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
      // Push outboard, away from the box centre, so the number clears the corner.
      const length = Math.hypot(best[0], best[1]) || 1;
      const x = best[0] + (best[0] / length) * LABEL_PAD;
      const z = best[1] + (best[1] / length) * LABEL_PAD;

      // Labels are ordered surface-downward, so walking them in order and
      // keeping the first of any crowded pair always keeps the shallower tick.
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
      // With sizeAttenuation off, the sprite's world scale maps to NDC directly.
      // projectionMatrix[5] is 1/tan(fov/2), so this lands the sprite at exactly
      // its canvas size in CSS pixels.
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
          // Never touch sprite.geometry — Three shares one instance across every
          // Sprite in the process. The map is ours and SpriteMaterial.dispose()
          // does not reach it.
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
