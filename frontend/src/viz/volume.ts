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

import { buildLut, DIVERGING, LUT_SIZE, type ColormapName } from "./colormaps";
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
 * Pack a field into an RG 3D texture: R carries the normalized value, G marks
 * validity. A separate validity channel matters because NaN is not reliably
 * filterable — without it, land bleeds a fake value into neighbouring water.
 */
export function buildVolumeTexture(
  values: Float32Array,
  geometry: FieldGeometry,
  valueRange: [number, number],
  colormap: ColormapName,
): VolumeUpload {
  const [nDepth, nLat, nLon] = geometry.shape as [number, number, number];
  const layers = nDepth > 1 ? DEPTH_LAYERS : 1;

  let [lo, hi] = valueRange;
  if (DIVERGING.has(colormap)) {
    // A diverging map that is not centred on zero puts "no difference" at a
    // coloured position, which reads as a signal. Centre it.
    const extent = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
    lo = -extent;
    hi = extent;
  }
  const span = hi - lo || 1;

  const data = new Uint8Array(nLon * nLat * layers * 2);
  const columnStride = nLat * nLon;

  for (let i = 0; i < nLat; i++) {
    for (let j = 0; j < nLon; j++) {
      const offset = i * nLon + j;

      const column =
        nDepth > 1
          ? resampleToNormAxis(geometry.depths, values, offset, columnStride, layers, MAX_DEPTH)
          : Float32Array.of(values[offset]!);

      for (let k = 0; k < layers; k++) {
        const value = column[k]!;
        const out = (k * nLat * nLon + i * nLon + j) * 2;
        if (Number.isFinite(value)) {
          const t = (value - lo) / span;
          data[out] = Math.max(0, Math.min(255, Math.round(t * 255)));
          data[out + 1] = 255;
        } else {
          data[out] = 0;
          data[out + 1] = 0;
        }
      }
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

      // Front-to-back compositing.
      // NOTE: the sampled colour is used exactly as the colormap produced it.
      // No lighting, fog or depth attenuation is applied to the data, because
      // any of those would shift a value away from what the colorbar claims.
      // Only opacity is modulated, and only at the analysis boundary.
      float sampleAlpha = uDensity * stepSize * (uSlice > 0.5 ? 40.0 : 1.0);
      sampleAlpha *= edgeFalloff(uv);
      sampleAlpha = clamp(sampleAlpha, 0.0, 1.0);
      accum += (1.0 - alpha) * colour * sampleAlpha;
      alpha += (1.0 - alpha) * sampleAlpha;
    }

    if (alpha < 0.004) discard;
    fragColor = vec4(accum / max(alpha, 0.0001), alpha);
  }
`;

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
      // Lowered when the analysis box was shortened to share the terrain's
      // vertical axis: the same density over a shorter path made the volume
      // read as an opaque glowing slab rather than water with structure in it.
      uDensity: { value: 2.6 },
      uSlice: { value: 0 },
      uSliceDepth: { value: depthToNorm(0) },
      uEdgeFade: { value: 0.06 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
  });
}
