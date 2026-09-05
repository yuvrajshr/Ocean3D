/**
 * The water column: a raymarched 3D texture.
 *
 * The INCOIS volume is 24 x 60 x 90 = 129,600 points, which is nothing for a
 * GPU, so we can afford real volumetric rendering rather than a stack of
 * translucent images. The field is uploaded once as a 3D texture and the
 * fragment shader marches a ray through it per pixel.
 *
 * Values are quantized to 8 bits for the GPU. That is 256 colour steps, which
 * is finer than the eye resolves in a gradient — and every *numeric* readout in
 * the UI comes from the untouched Float32 array on the CPU, so precision is
 * never lost where it is actually read.
 */

import * as THREE from "three";

import { buildLut, encodeRange, LUT_SIZE, type ColormapName } from "./colormaps";
import { depthToNorm, MAX_DEPTH, resampleToNormAxis } from "./depth";

/** Vertical layers in the 3D texture, evenly spaced on the square-root axis. */
export const DEPTH_LAYERS = 64;

export interface FieldGeometry {
  lat: number[];
  lon: number[];
  depths: number[];
  shape: number[];
}

export interface VolumeUpload {
  texture: THREE.Data3DTexture;
  /** Value range actually encoded, after any diverging re-centring. */
  encodedRange: [number, number];
}

/**
 * Pack a field into an RG 3D texture: R carries the normalized value, G carries
 * validity AND local structure.
 *
 * Validity has to be its own signal because NaN is not reliably filterable —
 * without it, land bleeds a fake value into neighbouring water.
 *
 * Structure rides in the same channel because of what was wrong with the first
 * version of this renderer: opacity was CONSTANT for every sample in the box.
 * Colour varied with the value and opacity did not, which is the definition of
 * a homogeneous fog — it cannot show structure at any density, because nothing
 * in it is more present than anything else. Raising uDensity gave a brighter
 * fog, lowering it a fainter one, and neither had form.
 *
 * So the shader needs to know where the field is *changing*: a thermocline, a
 * front, the edge of a cold wake. That is a gradient, and computing it here —
 * once, on upload, with the real Float32 values — costs the raymarch nothing,
 * where doing it in the shader would have meant six extra texture fetches on
 * every one of 160 steps.
 *
 * Encoding: G = 0 means no data. Valid samples occupy 128..255, so the shader's
 * `g < 0.5` land test is unchanged and land still cuts off cleanly under linear
 * filtering; the remaining 7 bits carry gradient magnitude.
 *
 * Colour is untouched by all of this. Opacity is the only channel modulated,
 * which is exactly what this file already permitted.
 */
export function buildVolumeTexture(
  values: Float32Array,
  geometry: FieldGeometry,
  valueRange: [number, number],
  colormap: ColormapName,
): VolumeUpload {
  const [nDepth, nLat, nLon] = geometry.shape as [number, number, number];
  const layers = nDepth > 1 ? DEPTH_LAYERS : 1;

  // encodeRange lives in colormaps.ts so the 2D map cannot encode a diverging
  // field differently from this texture. See its comment.
  const [lo, hi] = encodeRange(valueRange, colormap);
  const span = hi - lo || 1;

  const columnStride = nLat * nLon;
  const voxels = layers * nLat * nLon;

  // Pass 1 — normalized values on the render grid. NaN marks no data.
  const norm = new Float32Array(voxels);
  for (let i = 0; i < nLat; i++) {
    for (let j = 0; j < nLon; j++) {
      const offset = i * nLon + j;
      const column =
        nDepth > 1
          ? resampleToNormAxis(geometry.depths, values, offset, columnStride, layers, MAX_DEPTH)
          : Float32Array.of(values[offset]!);
      for (let k = 0; k < layers; k++) {
        const value = column[k]!;
        norm[k * columnStride + offset] = Number.isFinite(value) ? (value - lo) / span : NaN;
      }
    }
  }

  const at = (k: number, i: number, j: number) => norm[k * columnStride + i * nLon + j]!;

  // Pass 2 — central differences. A one-sided difference at a land or surface
  // boundary would invent a huge gradient and draw a bright shell around the
  // coastline, so an axis only contributes where both neighbours are real.
  const gradient = new Float32Array(voxels);
  for (let k = 0; k < layers; k++) {
    for (let i = 0; i < nLat; i++) {
      for (let j = 0; j < nLon; j++) {
        const index = k * columnStride + i * nLon + j;
        if (!Number.isFinite(norm[index]!)) continue;

        let sum = 0;
        if (k > 0 && k < layers - 1) {
          const a = at(k - 1, i, j);
          const b = at(k + 1, i, j);
          if (Number.isFinite(a) && Number.isFinite(b)) sum += (b - a) * (b - a);
        }
        if (i > 0 && i < nLat - 1) {
          const a = at(k, i - 1, j);
          const b = at(k, i + 1, j);
          if (Number.isFinite(a) && Number.isFinite(b)) sum += (b - a) * (b - a);
        }
        if (j > 0 && j < nLon - 1) {
          const a = at(k, i, j - 1);
          const b = at(k, i, j + 1);
          if (Number.isFinite(a) && Number.isFinite(b)) sum += (b - a) * (b - a);
        }
        gradient[index] = Math.sqrt(sum);
      }
    }
  }

  // Normalize against a high percentile, never the maximum: one bad cell would
  // otherwise flatten every real feature to nothing. Same reasoning as the
  // percentile colour clipping in context.md §10.
  //
  // Taken from a histogram rather than by sorting. Sorting these gradients —
  // once for the field and again for each of 64 layers — measured at 78 ms per
  // field load, which is a visible hitch every time the timeline steps. This is
  // one linear pass, and 1024 bins is far more resolution than a scale that
  // only drives opacity will ever need.
  const BINS = 1024;
  let maxGradient = 0;
  for (let n = 0; n < voxels; n++) {
    if (gradient[n]! > maxGradient) maxGradient = gradient[n]!;
  }
  const binScale = maxGradient > 0 ? (BINS - 1) / maxGradient : 0;

  const percentileOf = (counts: Uint32Array, total: number, p: number): number => {
    if (total === 0 || binScale === 0) return 0;
    const target = total * p;
    let seen = 0;
    for (let b = 0; b < BINS; b++) {
      seen += counts[b] ?? 0;
      if (seen >= target) return b / binScale;
    }
    return maxGradient;
  };

  const globalCounts = new Uint32Array(BINS);
  let globalTotal = 0;
  for (let n = 0; n < voxels; n++) {
    const g = gradient[n]!;
    if (g > 0) {
      const b = Math.round(g * binScale);
      globalCounts[b] = (globalCounts[b] ?? 0) + 1;
      globalTotal++;
    }
  }
  const globalReference = percentileOf(globalCounts, globalTotal, 0.98) || 1;

  // Then normalize PER DEPTH LAYER. The thermocline's vertical gradient is
  // orders of magnitude larger than anything below it, so on one global scale
  // it alone saturates and the entire deep column collapses to the floor — the
  // box keeps its lid and loses its depth. Per-layer, every level shows its own
  // structure, which is what makes an eddy at 800 m visible at all.
  //
  // Opacity is not a quantitative channel here (colour is), so rescaling it by
  // depth states nothing false. The guard matters though: a genuinely uniform
  // layer would divide by its own noise and manufacture structure that is not
  // there, so no layer may be scaled more aggressively than the global floor.
  const layerReference = new Float32Array(layers);
  const layerCounts = new Uint32Array(BINS);
  for (let k = 0; k < layers; k++) {
    layerCounts.fill(0);
    let total = 0;
    for (let n = k * columnStride; n < (k + 1) * columnStride; n++) {
      const g = gradient[n]!;
      if (g > 0) {
        const b = Math.round(g * binScale);
        layerCounts[b] = (layerCounts[b] ?? 0) + 1;
        total++;
      }
    }
    layerReference[k] = Math.max(percentileOf(layerCounts, total, 0.98), globalReference * 0.18) || 1;
  }

  // Pass 3 — pack.
  const data = new Uint8Array(voxels * 2);
  for (let n = 0; n < voxels; n++) {
    const value = norm[n]!;
    const out = n * 2;
    if (Number.isFinite(value)) {
      data[out] = Math.max(0, Math.min(255, Math.round(value * 255)));
      const ratio = Math.min(1, gradient[n]! / layerReference[Math.floor(n / columnStride)]!);
      // Square root, so moderate structure is not swamped by the strongest few
      // percent — and so the seven bits available spend their range where the
      // features actually live.
      data[out + 1] = 128 + Math.round(Math.sqrt(ratio) * 127);
    } else {
      data[out] = 0;
      data[out + 1] = 0;
    }
  }

  const texture = new THREE.Data3DTexture(data, nLon, nLat, layers);
  texture.format = THREE.RGFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;

  return { texture, encodedRange: [lo, hi] };
}

export function buildLutTexture(colormap: ColormapName): THREE.DataTexture {
  const lut = buildLut(colormap);
  const rgba = new Uint8Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    rgba[i * 4] = lut[i * 3]!;
    rgba[i * 4 + 1] = lut[i * 3 + 1]!;
    rgba[i * 4 + 2] = lut[i * 3 + 2]!;
    rgba[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(rgba, LUT_SIZE, 1, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

const VERTEX = /* glsl */ `
  out vec3 vLocalPosition;

  void main() {
    vLocalPosition = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  precision highp sampler3D;

  in vec3 vLocalPosition;
  out vec4 fragColor;

  uniform sampler3D uVolume;
  uniform sampler2D uLut;
  uniform vec3  uCameraLocal;
  uniform float uSteps;
  uniform float uDepthMin;   // normalized, 0 = surface
  uniform float uDepthMax;
  uniform float uDensity;
  uniform float uStructureFloor; // how present still water is, against structure
  uniform float uSlice;      // 1.0 = show only the selected depth plane
  uniform float uSliceDepth;
  uniform float uEdgeFade;   // width of the boundary fade, in texture units

  // Where the analysis stops, the ocean continues. A hard wall of data made
  // the field look like an object dropped into the scene; fading it into the
  // surrounding water removes the seam. The extent is not thereby hidden — a
  // hairline frame and a stated bounding box still say exactly where the
  // measured region ends (context.md §5.1).
  float edgeFalloff(vec3 uv) {
    float fx = smoothstep(0.0, uEdgeFade, uv.x) * smoothstep(0.0, uEdgeFade, 1.0 - uv.x);
    float fy = smoothstep(0.0, uEdgeFade, uv.y) * smoothstep(0.0, uEdgeFade, 1.0 - uv.y);
    return fx * fy;
  }

  // Slab method: where does this ray enter and leave the unit box?
  bool intersectBox(vec3 origin, vec3 dir, out float tNear, out float tFar) {
    vec3 invDir = 1.0 / dir;
    vec3 tBottom = (vec3(-0.5) - origin) * invDir;
    vec3 tTop    = (vec3( 0.5) - origin) * invDir;
    vec3 tMin = min(tBottom, tTop);
    vec3 tMax = max(tBottom, tTop);
    tNear = max(max(tMin.x, tMin.y), tMin.z);
    tFar  = min(min(tMax.x, tMax.y), tMax.z);
    return tFar > max(tNear, 0.0);
  }

  // Local box space -> texture space.
  //   x  -> longitude (east is +x)
  //   z  -> latitude  (north is -z, so flip)
  //   y  -> depth     (surface at +y, seafloor at -y)
  vec3 toTexture(vec3 p) {
    return vec3(p.x + 0.5, 0.5 - p.z, 0.5 - p.y);
  }

  void main() {
    vec3 rayDir = normalize(vLocalPosition - uCameraLocal);
    float tNear, tFar;
    if (!intersectBox(uCameraLocal, rayDir, tNear, tFar)) discard;
    tNear = max(tNear, 0.0);

    float stepSize = (tFar - tNear) / uSteps;
    vec3 accum = vec3(0.0);
    float alpha = 0.0;

    for (int i = 0; i < 512; i++) {
      if (float(i) >= uSteps || alpha >= 0.98) break;

      vec3 p = uCameraLocal + rayDir * (tNear + (float(i) + 0.5) * stepSize);
      vec3 uv = toTexture(p);

      // Honour the depth ruler: everything outside the selected band is simply
      // not there, so the ruler reads as a real instrument rather than a filter.
      if (uv.z < uDepthMin || uv.z > uDepthMax) continue;

      if (uSlice > 0.5 && abs(uv.z - uSliceDepth) > 0.012) continue;

      vec2 sampled = texture(uVolume, uv).rg;
      if (sampled.g < 0.5) continue;   // land or no data

      vec3 colour = texture(uLut, vec2(sampled.r, 0.5)).rgb;

      // The transfer function. G's upper seven bits carry local gradient
      // magnitude, packed once on upload. Water that is not changing steps back
      // toward uStructureFloor; a thermocline, a front, or the edge of a cold
      // wake steps forward to full weight. This is what makes the field read as
      // form rather than as an even haze — with a constant weight the volume is
      // a homogeneous fog by construction, and no density setting can fix that.
      float structure = clamp((sampled.g - 0.5) * 2.0, 0.0, 1.0);
      float weight = mix(uStructureFloor, 1.0, structure);

      // Front-to-back compositing.
      // NOTE: the sampled colour is used exactly as the colormap produced it.
      // No lighting, fog or depth attenuation is applied to the data, because
      // any of those would shift a value away from what the colorbar claims.
      // OPACITY is the only channel ever modulated — by the boundary fade and
      // by the transfer function above. Never colour.
      float sampleAlpha = uDensity * stepSize * weight * (uSlice > 0.5 ? 40.0 : 1.0);
      sampleAlpha *= edgeFalloff(uv);
      sampleAlpha = clamp(sampleAlpha, 0.0, 1.0);
      accum += (1.0 - alpha) * colour * sampleAlpha;
      alpha += (1.0 - alpha) * sampleAlpha;
    }

    if (alpha < 0.004) discard;
    fragColor = vec4(accum / max(alpha, 0.0001), alpha);
  }
`;

/**
 * The float profile ribbon.
 *
 * A measured profile is data, so it is coloured through the SAME lookup table
 * and the SAME encoded range as the volume around it — that is the whole point:
 * a reader compares the float against the water by looking at one against the
 * other. Which is also why this is a raw GLSL3 material rather than Three's
 * `Line2`: `LineMaterial`'s fragment shader ends with `<tonemapping_fragment>`
 * and `<colorspace_fragment>`. `toneMapped = false` disarms the first; nothing
 * disarms the second. It is identity today only because the composer's targets
 * happen to be Linear-sRGB — change that and the ribbon would shift while the
 * volume stayed put, disagreeing with the colorbar in silence. Same reasoning
 * as the renderer's NoToneMapping, reached through an addon instead.
 *
 * The strip is billboarded in the vertex shader. A profile is a vertical line,
 * so its perpendicular is always horizontal and the quad only degenerates when
 * looking straight down the axis — which the length guard covers.
 */
const PROFILE_VERTEX = /* glsl */ `
  in float aSide;
  in float aValue;
  in float aNorm;

  out float vValue;
  out float vNorm;

  uniform float uHalfWidth;

  void main() {
    vValue = aValue;
    vNorm = aNorm;

    vec4 world = modelMatrix * vec4(position, 1.0);
    vec3 toCamera = normalize(cameraPosition - world.xyz);
    vec3 across = cross(vec3(0.0, 1.0, 0.0), toCamera);
    float len = length(across);
    vec3 right = len > 1e-4 ? across / len : vec3(1.0, 0.0, 0.0);
    world.xyz += right * aSide * uHalfWidth;

    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const PROFILE_FRAGMENT = /* glsl */ `
  precision highp float;

  in float vValue;
  in float vNorm;
  out vec4 fragColor;

  uniform sampler2D uLut;
  uniform float uLo;
  uniform float uHi;
  uniform float uDepthMin;
  uniform float uDepthMax;
  uniform float uOpacity;
  uniform float uCasing;
  uniform vec3  uCasingColor;

  void main() {
    // The ribbon is data, so the depth ruler governs it exactly as it governs
    // the volume. A ribbon that outlived the window would make the ruler a lie.
    if (vNorm < uDepthMin || vNorm > uDepthMax) discard;

    if (uCasing > 0.5) {
      fragColor = vec4(uCasingColor, uOpacity);
      return;
    }

    float t = clamp((vValue - uLo) / max(uHi - uLo, 1e-6), 0.0, 1.0);
    fragColor = vec4(texture(uLut, vec2(t, 0.5)).rgb, uOpacity);
  }
`;

export interface ProfileMaterialOptions {
  lut: THREE.DataTexture;
  encodedRange: [number, number];
  halfWidth: number;
  /** A casing draws flat in `abyss` behind the ribbon: figure/ground, never a tint on top. */
  casingColor?: number;
  opacity: number;
}

export function createProfileMaterial({
  lut,
  encodedRange,
  halfWidth,
  casingColor,
  opacity,
}: ProfileMaterialOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: PROFILE_VERTEX,
    fragmentShader: PROFILE_FRAGMENT,
    uniforms: {
      uLut: { value: lut },
      uLo: { value: encodedRange[0] },
      uHi: { value: encodedRange[1] },
      uDepthMin: { value: 0 },
      uDepthMax: { value: 1 },
      uHalfWidth: { value: halfWidth },
      uOpacity: { value: opacity },
      uCasing: { value: casingColor === undefined ? 0 : 1 },
      uCasingColor: { value: new THREE.Color(casingColor ?? 0x000000) },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

export interface VolumeMaterialOptions {
  volume: THREE.Data3DTexture;
  lut: THREE.DataTexture;
}

export function createVolumeMaterial({ volume, lut }: VolumeMaterialOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uVolume: { value: volume },
      uLut: { value: lut },
      uCameraLocal: { value: new THREE.Vector3() },
      uSteps: { value: 160 },
      uDepthMin: { value: 0 },
      uDepthMax: { value: 1 },
      // Raised from 2.6 once opacity started carrying the transfer function.
      // At a constant weight, 2.6 was the least-bad point on a bad axis: higher
      // was an opaque glowing slab, lower was haze, and neither had structure.
      // Now the two ends are separated — still water is scaled down by
      // uStructureFloor and the features are scaled up — so the field can be
      // denser where it matters without filling the box.
      uDensity: { value: 5.5 },
      // Not near zero. Still water is real water; it should recede, not vanish.
      // At 0.09 the deep column disappeared and the analysis read as a lid with
      // nothing under it, which is a different lie from the fog it replaced.
      uStructureFloor: { value: 0.26 },
      uSlice: { value: 0 },
      uSliceDepth: { value: depthToNorm(0) },
      uEdgeFade: { value: 0.06 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
  });
}
