/**
 * The relief surface: land and seafloor as one mesh.
 *
 * ETOPO gives a single elevation field that is positive on land and negative at
 * sea, so the Eastern Ghats, the Indian coastline and the floor of the Bay of
 * Bengal are one continuous surface here — which is what they are. Building
 * them as separate objects would be both more code and less true.
 *
 * Geometry is assembled by hand rather than from PlaneGeometry: ERDDAP returns
 * latitude ascending (south first) while a plane's rows run north-first, and
 * quietly rendering the Bay of Bengal upside down is exactly the class of bug
 * that survives review because it still looks plausible.
 */

import * as THREE from "three";

import type { GeoFrame } from "./geo";
import { TOKEN_RGB, WATER_GLSL, waterUniforms } from "./water";

export interface TerrainField {
  lat: number[];
  lon: number[];
  shape: [number, number];
  elevation: Float32Array;
  minElevation: number;
  maxElevation: number;
}

const VERTEX = /* glsl */ `
  out vec3 vWorld;
  out float vElevation;
  out vec3 vNormal;

  in float elevation;

  void main() {
    vElevation = elevation;
    vNormal = normalize(normalMatrix * normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;

  in vec3 vWorld;
  in float vElevation;
  in vec3 vNormal;
  out vec4 fragColor;

  uniform vec3 uSunDirection;
  uniform vec3 uLandLow;
  uniform vec3 uLandHigh;
  uniform vec3 uSeabed;
  uniform vec3 uShelf;
  uniform vec3 uCameraPos;
  uniform float uTime;
  uniform float uMaxLandElevation;
  uniform float uCausticStrength;

  ${WATER_GLSL}

  void main() {
    vec3 normal = normalize(vNormal);
    float lambert = max(dot(normal, normalize(uSunDirection)), 0.0);

    if (vElevation > 0.0) {
      // --- Land -------------------------------------------------------
      // Deliberately desaturated and dark. Land is context; the moment it
      // competes with the data for attention it has failed its job.
      float h = clamp(vElevation / uMaxLandElevation, 0.0, 1.0);
      vec3 base = mix(uLandLow, uLandHigh, pow(h, 0.6));
      vec3 lit = base * (0.35 + 0.65 * lambert);
      fragColor = vec4(lit, 1.0);
      return;
    }

    // --- Seafloor -----------------------------------------------------
    float depthMetres = -vElevation;

    // The continental shelf reads lighter than the abyssal plain, as it does
    // in every bathymetric chart a forecaster has ever used.
    float shelfness = 1.0 - smoothstep(0.0, 900.0, depthMetres);
    vec3 base = mix(uSeabed, uShelf, shelfness);
    vec3 lit = base * (0.30 + 0.70 * lambert);

    float causticAmount = caustics(vWorld.xz, uTime, depthMetres);
    lit += vec3(0.45, 0.85, 0.80) * causticAmount * uCausticStrength;

    float fogAmount = 1.0 - exp(-uWaterDensity * waterPath(uCameraPos, vWorld));
    vec3 shaded = applyWater(lit, depthMetres, fogAmount);

    // Dissolve the seafloor away below the photic zone.
    //
    // Fog alone was not enough: the deep slope still showed as a silhouette,
    // because shading varied across it and betrayed its shape — and that shape
    // is a wall, an artifact of exaggerating the vertical axis a couple of
    // hundred times, not something anyone should be reading.
    //
    // Below roughly 700 m there is no light to see the bottom by, so it simply
    // is not drawn. The fade is gradual, so there is no cut line: the shelf and
    // upper slope stay legible and the abyssal plain becomes open water, which
    // is exactly what a diver, a camera or an echo of daylight would find.
    float visibility = 1.0 - smoothstep(250.0, 900.0, depthMetres);
    if (visibility <= 0.002) discard;

    fragColor = vec4(shaded, visibility);
  }
`;

/**
 * Low-pass the heightfield before it becomes geometry.
 *
 * At several hundred times vertical exaggeration, genuine 7 km-resolution
 * relief renders as a field of vertical shards: every seamount and canyon wall
 * becomes a spike taller than it is wide. Smoothing trades detail the viewer
 * could not read anyway for a surface that reads as a basin.
 *
 * This affects only the *rendered* relief. No depth reported anywhere in the UI
 * comes from this array — the depth ruler, the profile panel and the analysis
 * all carry their own untouched numbers.
 */
function smooth(elevation: Float32Array, nLat: number, nLon: number, passes: number): Float32Array {
  let current = Float32Array.from(elevation);
  let next = new Float32Array(current.length);

  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < nLat; i++) {
      for (let j = 0; j < nLon; j++) {
        let sum = 0;
        let count = 0;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= nLat) continue;
          for (let dj = -1; dj <= 1; dj++) {
            const jj = j + dj;
            if (jj < 0 || jj >= nLon) continue;
            sum += current[ii * nLon + jj]!;
            count++;
          }
        }
        next[i * nLon + j] = sum / count;
      }
    }
    const swap = current;
    current = next;
    next = swap;
  }
  return current;
}

export function buildTerrainMesh(field: TerrainField, geo: GeoFrame): THREE.Mesh {
  const [nLat, nLon] = field.shape;
  const relief = smooth(field.elevation, nLat, nLon, 8);
  const positions = new Float32Array(nLat * nLon * 3);
  const elevations = new Float32Array(nLat * nLon);

  for (let i = 0; i < nLat; i++) {
    const z = geo.z(field.lat[i]!);
    for (let j = 0; j < nLon; j++) {
      const index = i * nLon + j;
      const elevation = relief[index]!;
      positions[index * 3] = geo.x(field.lon[j]!);
      positions[index * 3 + 1] = geo.elevationY(elevation);
      positions[index * 3 + 2] = z;
      elevations[index] = elevation;
    }
  }

  // 32-bit indices are required: 141,376 vertices overflows Uint16.
  const quads = (nLat - 1) * (nLon - 1);
  const indices = new Uint32Array(quads * 6);
  let w = 0;
  for (let i = 0; i < nLat - 1; i++) {
    for (let j = 0; j < nLon - 1; j++) {
      const a = i * nLon + j;
      const b = a + 1;
      const c = a + nLon;
      const d = c + 1;
      indices[w++] = a; indices[w++] = c; indices[w++] = b;
      indices[w++] = b; indices[w++] = c; indices[w++] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("elevation", new THREE.BufferAttribute(elevations, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      ...waterUniforms(),
      uSunDirection: { value: new THREE.Vector3(0.35, 0.82, 0.45).normalize() },
      uLandLow: { value: new THREE.Color(...TOKEN_RGB.thermocline) },
      uLandHigh: { value: new THREE.Color(0.30, 0.34, 0.35) },
      uSeabed: { value: new THREE.Color(...TOKEN_RGB.abyss) },
      uShelf: { value: new THREE.Color(0.10, 0.28, 0.34) },
      uCameraPos: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uMaxLandElevation: { value: Math.max(field.maxElevation, 1) },
      uCausticStrength: { value: 0.5 },
    },
    side: THREE.FrontSide,
    transparent: true,
    depthWrite: true,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 0;
  mesh.frustumCulled = true;
  return mesh;
}
