/**
 * The water column as a raymarched 3D texture.
 *
 * The INCOIS volume is only 24 x 60 x 90 points, so real volume rendering is
 * cheap. Values are stored as 8 bits on the GPU (256 colour steps); all numeric
 * readouts use the original Float32 data.
 */

import * as THREE from "three";

import { buildLut, encodeRange, LUT_SIZE, type ColormapName } from "./colormaps";
import { depthToNorm, MAX_DEPTH, resampleToNormAxis } from "./depth";

/** Depth layers in the 3D texture, evenly spaced on the depth axis. */
export const DEPTH_LAYERS = 64;

export interface FieldGeometry {
  lat: number[];
  lon: number[];
  depths: number[];
  shape: number[];
}

export interface VolumeUpload {
  texture: THREE.Data3DTexture;
  /** Range actually encoded, after re-centring diverging maps. */
  encodedRange: [number, number];
}

/**
 * Pack a field into an RG 3D texture: R is the normalised value, G is validity
 * plus local gradient.
 *
 * - Validity: NaN doesn't filter reliably, and land would bleed into the water.
 * - Gradient: opacity comes from how fast the field changes (thermocline,
 *   fronts, cold wake). With constant opacity the volume is just fog. Computed
 *   here once on the CPU instead of with extra texture reads in the shader.
 *
 * G = 0 means no data; valid samples use 128..255, so the shader's g < 0.5 land
 * test still works, and the other 7 bits hold the gradient. Colour isn't affected.
 */
export function buildVolumeTexture(
  values: Float32Array,
  geometry: FieldGeometry,
  valueRange: [number, number],
  colormap: ColormapName,
): VolumeUpload {
  const [nDepth, nLat, nLon] = geometry.shape as [number, number, number];
  const layers = nDepth > 1 ? DEPTH_LAYERS : 1;

  // Shared with the map so diverging fields are encoded the same way.
  const [lo, hi] = encodeRange(valueRange, colormap);
  const span = hi - lo || 1;

  const columnStride = nLat * nLon;
  const voxels = layers * nLat * nLon;

  // Pass 1: normalised values on the render grid, NaN for no data.
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

  // Pass 2: central differences, only where both neighbours exist (otherwise
  // coastlines get a bright shell).
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

  // Normalise against a high percentile, not the max, so one bad cell doesn't
  // flatten everything. Uses a histogram because sorting took ~78 ms per load.
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

  // Then normalise per depth layer. The thermocline gradient is much bigger than
  // anything below it, so one global scale would hide the deep column. Clamped
  // by a global floor so a uniform layer doesn't amplify its own noise.
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

  // Pass 3: pack.
  const data = new Uint8Array(voxels * 2);
  for (let n = 0; n < voxels; n++) {
    const value = norm[n]!;
    const out = n * 2;
    if (Number.isFinite(value)) {
      data[out] = Math.max(0, Math.min(255, Math.round(value * 255)));
      const ratio = Math.min(1, gradient[n]! / layerReference[Math.floor(n / columnStride)]!);
      // Square root so moderate gradients aren't swamped by the strongest ones.
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
  uniform float uDepthMin;   // normalised, 0 = surface
  uniform float uDepthMax;
  uniform float uDensity;
  uniform float uStructureFloor; // opacity of still water relative to structure
  uniform float uSlice;      // 1.0 = only the selected depth plane
  uniform float uSliceDepth;
  uniform float uEdgeFade;   // width of the edge fade, in texture units

  // Fade the field into the surrounding water at its edges. The frame and the
  // stated bounding box still show where the data ends.
  float edgeFalloff(vec3 uv) {
    float fx = smoothstep(0.0, uEdgeFade, uv.x) * smoothstep(0.0, uEdgeFade, 1.0 - uv.x);
    float fy = smoothstep(0.0, uEdgeFade, uv.y) * smoothstep(0.0, uEdgeFade, 1.0 - uv.y);
    return fx * fy;
  }

  // Slab method: where does the ray enter and leave the unit box?
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

  // Box space to texture space.
  // x -> longitude (east is +x)
  // z -> latitude (north is -z, so flip)
  // y -> depth (surface at +y, seafloor at -y)
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

      // Skip everything outside the depth range selected on the ruler.
      if (uv.z < uDepthMin || uv.z > uDepthMax) continue;

      if (uSlice > 0.5 && abs(uv.z - uSliceDepth) > 0.012) continue;

      vec2 sampled = texture(uVolume, uv).rg;
      if (sampled.g < 0.5) continue;   // land or no data

      vec3 colour = texture(uLut, vec2(sampled.r, 0.5)).rgb;

      // Transfer function: G's upper 7 bits hold the local gradient. Still water fades
      // toward uStructureFloor; thermoclines, fronts and cold wakes are fully opaque.
      float structure = clamp((sampled.g - 0.5) * 2.0, 0.0, 1.0);
      float weight = mix(uStructureFloor, 1.0, structure);

      // Front-to-back compositing. The colour is used exactly as the colormap gives it;
      // only opacity changes (edge fade and transfer function), never colour.
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
 * Float profile ribbon.
 *
 * Coloured with the same LUT and range as the volume so you can compare the float
 * against the water around it. Custom GLSL3 instead of Line2, because
 * LineMaterial applies colour-space conversion that would shift the colours.
 *
 * The strip is billboarded in the vertex shader. A profile is vertical, so its
 * perpendicular is always horizontal; it only degenerates looking straight down,
 * which the length check covers.
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
    // The ribbon follows the depth ruler too.
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
  /** Optional flat casing colour drawn behind the ribbon. */
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
      // Higher density works now that opacity follows the gradient (still water is
      // scaled down by uStructureFloor).
      uDensity: { value: 5.5 },
      // Don't go near zero: at 0.09 the deep water vanished and only the top showed.
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
