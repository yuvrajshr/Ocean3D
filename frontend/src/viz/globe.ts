/**
 * The Earth — entry gesture, and a view you can return to.
 *
 * This reverses two earlier decisions, both recorded in context.md §10. The globe used to
 * be a shader-drawn instrument (graticule, coastline land mask, two flat tones) on the
 * reasoning that a blue marble is a generic tell and a photographic sphere implies global
 * coverage we do not have. The team supplied NASA reference frames and asked for the real
 * thing, so the risk gets paid down rather than argued away — see §5.1 Principle 7:
 *
 *   The basemap is imagery; everything drawn on it is data.
 *
 * The sphere is a photograph and encodes nothing. The only marks added to it are the
 * analysis extent and the floats reporting inside it — both things we actually measured.
 * No field is ever painted onto the globe at global extent, because our coverage is a
 * regional box and a global-looking data layer would claim otherwise.
 *
 * The imagery is NASA Blue Marble Next Generation *with topography and bathymetry*: the
 * relief is baked into the pixels, which is where the visible mid-ocean ridges and the
 * Greenland ice dome come from, so no normal or elevation map is needed. It is bundled in
 * `public/` rather than fetched from a CDN — the deployment target cannot depend on outside
 * hosts. Run `node scripts/fetch-textures.mjs` to regenerate it.
 *
 * The basemap gets a shadow lift in the fragment shader below. That is a cosmetic grade on
 * an image that encodes nothing, and is not the renderer-wide tone mapping context.md §10
 * forbids — that one would also remap the data volume's colours.
 */

import * as THREE from "three";

import { TOKEN_RGB } from "./water";

/**
 * The bundled basemaps, by season.
 *
 * Two ship so a scenario can pick the month that matches it. Phailin is October 2013, so
 * it uses October — the December image has heavy Arctic and Scandinavian snow that would
 * be wrong for the demo window.
 *
 * 4096×2048 rather than NASA's published 5400×2700, and the power of two is the point:
 * mipmap generation on the NPOT original fails on some drivers, reproducibly under the
 * screenshot harness's software renderer, where it corrupted the GL context badly enough
 * that unrelated materials stopped validating and the canvas went blank. Full reasoning in
 * `scripts/fetch-textures.mjs`, which regenerates these.
 */
export const BASEMAPS = {
  october: "/world.topo.bathy.200410.4096x2048.jpg",
  december: "/world.topo.bathy.200412.4096x2048.jpg",
} as const;

export const DEFAULT_BASEMAP = BASEMAPS.october;

/** Derived, not downloaded — see fetch-textures.mjs for why and how. Same for both
 * basemap months, since geography doesn't change between them. */
export const OCEAN_MASK_URL = "/world.ocean-mask.2048x1024.jpg";

/** NASA's Blue Marble cloud composite — see fetch-textures.mjs for sourcing/credit. */
export const CLOUDS_URL = "/world.clouds.2048x1024.jpg";

/** Classic DMSP city-lights composite — see fetch-textures.mjs for the fuller credit
 * this one specifically requires (different from, and in addition to, the Blue Marble one). */
export const NIGHT_LIGHTS_URL = "/world.night-lights.2048x1024.jpg";

export const GLOBE_RADIUS = 1.35;
// Ordered outward from the surface: clouds sit just above it, floats and their
// stems above the clouds, the region outline above that — each layer clear of
// the one below rather than sharing a radius and risking z-fighting.
const CLOUD_RADIUS = GLOBE_RADIUS * 1.006;
const MARKER_RADIUS = GLOBE_RADIUS * 1.008;
const OUTLINE_RADIUS = GLOBE_RADIUS * 1.012;

const GLOBE_SUN_DIRECTION = new THREE.Vector3(0.4, 0.5, 0.75).normalize();

/**
 * Place a lat/lon on the sphere.
 *
 * This convention is load-bearing: the fragment shader below recovers longitude as
 * `atan2(n.z, n.x)` and latitude as `asin(n.y)`, so anything drawn on the globe has to use
 * the matching forward transform or it will sit at the wrong place on the texture.
 */
export function latLonToGlobe(lat: number, lon: number, radius: number): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(lat);
  const theta = THREE.MathUtils.degToRad(lon);
  return new THREE.Vector3(
    radius * Math.cos(phi) * Math.cos(theta),
    radius * Math.sin(phi),
    radius * Math.cos(phi) * Math.sin(theta),
  );
}

/** The inverse, for turning a raycast hit back into a position on Earth. */
export function globeToLatLon(point: THREE.Vector3): { lat: number; lon: number } {
  const n = point.clone().normalize();
  return {
    lat: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(n.y, -1, 1))),
    lon: THREE.MathUtils.radToDeg(Math.atan2(n.z, n.x)),
  };
}

const SPHERE_VERTEX = /* glsl */ `
  out vec3 vNormalObject;
  out vec3 vViewNormal;
  out vec3 vViewDirObject;
  void main() {
    vNormalObject = normalize(position);
    vViewNormal = normalize(normalMatrix * normal);
    // Camera position carried into object space (rather than doing the
    // specular math in world space) so it uses the same fixed, un-rotated
    // frame as uSunDirection below — the day/night terminator already
    // relies on that object-space convention (see globeRotationY's own
    // comment for why), and the specular highlight has to agree with it or
    // the glint would sit at the wrong place relative to the lit hemisphere.
    vec3 cameraPositionObject = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
    vViewDirObject = normalize(cameraPositionObject - position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SPHERE_FRAGMENT = /* glsl */ `
  precision highp float;
  in vec3 vNormalObject;
  in vec3 vViewNormal;
  in vec3 vViewDirObject;
  out vec4 fragColor;

  uniform sampler2D uBasemap;
  uniform float uHasBasemap;
  uniform sampler2D uSpecularMask;
  uniform float uHasSpecularMask;
  uniform sampler2D uNightLights;
  uniform float uHasNightLights;
  uniform vec3 uSunDirection;
  uniform vec3 uUnlit;
  uniform vec3 uRim;
  uniform float uNightFloor;
  uniform float uLift;
  uniform float uGain;
  uniform float uOpacity;
  uniform float uSpecularStrength;
  uniform float uSpecularShininess;
  uniform float uNightLightsStrength;

  const float PI = 3.141592653589793;

  void main() {
    vec3 n = normalize(vNormalObject);

    // Latitude and longitude straight from the object-space normal, so the basemap stays
    // correctly registered however the globe is rotated. (The texture is uploaded with
    // flipY = false so that v = 0 is the image's top row, which is the north pole.)
    float lon = atan(n.z, n.x);
    float lat = asin(clamp(n.y, -1.0, 1.0));
    vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);

    // Before the basemap arrives, and if it never does, a plain dark ocean sphere. The
    // entry gesture must never be blocked on a 1.6 MB texture.
    vec3 surface = mix(uUnlit, texture(uBasemap, uv).rgb, uHasBasemap);

    // Lift the shadows. BMNG's deep ocean sits at 3-12% luminance, which on an already
    // dark page reads as a black hole with a coastline around it — the reference frames
    // show a mid-blue sea with the ridges legible right across it. A gamma lift raises
    // the darks steeply and the highlights barely, so the bathymetry and the ice both
    // survive; a flat multiplier would blow out Antarctica long before the ocean moved.
    //
    // This is a cosmetic grade on a basemap that encodes nothing (§5.1 Principle 7), and
    // it is confined to this shader — which is exactly why the renderer-wide tone mapping
    // forbidden in §10 is a different thing: that one would also remap the data volume.
    surface = pow(max(surface, vec3(0.0)), vec3(1.0 / uLift));

    // Terminator, very softly. A hard shadow reads as a rendering error, and a
    // physically dark night side would hide half of a sphere that is a navigation
    // surface — the reference frames are near-fully lit for exactly that reason. This
    // only ever scales the imagery's own colour; it never tints it, so nothing about the
    // basemap's appearance is invented here.
    float day = smoothstep(-0.75, 0.65, dot(n, normalize(uSunDirection)));
    vec3 colour = surface * mix(uNightFloor, 1.0, day) * uGain;

    // City lights on the night side. Same uv as the basemap, so no new
    // coordinate mapping; (1.0 - day) confines it to the dark hemisphere —
    // the same terminator the basemap's own dimming already uses, so lights
    // switch on exactly where the surface dims, not at a mismatched edge.
    vec3 lights = texture(uNightLights, uv).rgb * uHasNightLights;
    colour += lights * uNightLightsStrength * (1.0 - day);

    // Ocean sun-glint. A Blinn-Phong-style highlight, masked to water only
    // (the derived specular mask — see fetch-textures.mjs) and confined to
    // the lit hemisphere, since there is no glint to see on the night side.
    // Colour is a fixed warm-white, not a token: cosmetic grade on imagery
    // that encodes nothing, same category as uLift/uGain above.
    vec3 reflectDir = reflect(-normalize(uSunDirection), n);
    float specAngle = max(dot(reflectDir, normalize(vViewDirObject)), 0.0);
    float specular = pow(specAngle, uSpecularShininess) * texture(uSpecularMask, uv).r
      * uHasSpecularMask * day;
    colour += vec3(1.0, 0.98, 0.92) * specular * uSpecularStrength;

    // Atmosphere: brightest at the limb, where a real line of sight passes through the
    // most air.
    float rim = pow(1.0 - abs(dot(normalize(vViewNormal), vec3(0.0, 0.0, 1.0))), 3.0);
    colour += uRim * rim * (0.35 + 0.65 * day);

    fragColor = vec4(colour, uOpacity);
  }
`;

export interface Globe {
  group: THREE.Group;
  /** The sphere itself, exposed so the scene can raycast against it for region picking. */
  sphere: THREE.Mesh;
  /** Resolves once the basemap has loaded, or immediately if it cannot. */
  ready: Promise<void>;
  /**
   * Swap the basemap — a scenario picks its own season, so this is called once the
   * scenario is known. A no-op if the URL is already loaded.
   */
  setBasemap(url: string): Promise<void>;
  dispose(): void;
}

export interface GlobeOptions {
  /** Path to the equirectangular basemap under `public/`. */
  basemapUrl: string;
  /** From `renderer.capabilities.getMaxAnisotropy()` — the reference view is oblique. */
  maxAnisotropy?: number;
  /** Path to the derived ocean/land mask under `public/` (see fetch-textures.mjs). Optional —
   * a missing mask just means no specular glint, not a broken globe. */
  specularMaskUrl?: string;
  /** Path to the night-lights composite under `public/`. Optional — a missing texture
   * just means a plain dark night side, not a broken globe. */
  nightLightsUrl?: string;
}

export function buildGlobe({
  basemapUrl,
  maxAnisotropy = 1,
  specularMaskUrl,
  nightLightsUrl,
}: GlobeOptions): Globe {
  const group = new THREE.Group();

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: SPHERE_VERTEX,
    fragmentShader: SPHERE_FRAGMENT,
    uniforms: {
      uBasemap: { value: null },
      uHasBasemap: { value: 0 },
      uSpecularMask: { value: null },
      uHasSpecularMask: { value: 0 },
      uNightLights: { value: null },
      uHasNightLights: { value: 0 },
      uOpacity: { value: 1 },
      uSunDirection: { value: GLOBE_SUN_DIRECTION.clone() },
      // Deep ocean, so an un-textured globe still reads as Earth rather than as a bug.
      uUnlit: { value: new THREE.Color(0.055, 0.19, 0.26) },
      uRim: { value: new THREE.Color(...TOKEN_RGB.current) },
      // The night side stays legible. A physically dark hemisphere would hide half the
      // planet, and the globe is a navigation surface — you have to be able to find the
      // Bay of Bengal on it whatever the hour.
      uNightFloor: { value: 0.66 },
      // Shadow lift, applied in linear space before lighting. See the shader.
      uLift: { value: 1.5 },
      uGain: { value: 1.04 },
      uSpecularStrength: { value: 0.55 },
      uSpecularShininess: { value: 28 },
      uNightLightsStrength: { value: 1.4 },
    },
    transparent: true,
  });

  // 96×64 rather than the previous 72×48: at the close, oblique framing the reference
  // frames use, a coarser sphere shows a polygonal limb against black.
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(GLOBE_RADIUS, 96, 64), material);
  group.add(sphere);

  const loader = new THREE.TextureLoader();
  let texture: THREE.Texture | null = null;
  let loadedUrl: string | null = null;
  let specularTexture: THREE.Texture | null = null;
  let nightLightsTexture: THREE.Texture | null = null;

  // Fire-and-forget, unlike the basemap: a missing specular mask degrades to
  // no glint, not a blocked entry gesture, so this never gates `ready`.
  if (specularMaskUrl) {
    loader.load(specularMaskUrl, (loaded) => {
      loaded.flipY = false;
      // A data mask, not a colour image — sRGB decoding would skew the 0-1
      // ramp the shader reads as a literal multiplier.
      loaded.colorSpace = THREE.NoColorSpace;
      loaded.anisotropy = maxAnisotropy;
      loaded.wrapS = THREE.RepeatWrapping;
      loaded.wrapT = THREE.ClampToEdgeWrapping;
      loaded.minFilter = THREE.LinearMipmapLinearFilter;
      loaded.magFilter = THREE.LinearFilter;
      loaded.needsUpdate = true;

      specularTexture = loaded;
      material.uniforms.uSpecularMask!.value = loaded;
      material.uniforms.uHasSpecularMask!.value = 1;
    });
  }

  // Also fire-and-forget — a missing night-lights texture degrades to a
  // plain dark night side, which is exactly what the globe already showed
  // before this layer existed.
  if (nightLightsUrl) {
    loader.load(nightLightsUrl, (loaded) => {
      loaded.flipY = false;
      // Displayed as actual colour (warm city-light glow), unlike the
      // specular mask and clouds — sRGB, matching the basemap's own
      // treatment, not NoColorSpace.
      loaded.colorSpace = THREE.SRGBColorSpace;
      loaded.anisotropy = maxAnisotropy;
      loaded.wrapS = THREE.RepeatWrapping;
      loaded.wrapT = THREE.ClampToEdgeWrapping;
      loaded.minFilter = THREE.LinearMipmapLinearFilter;
      loaded.magFilter = THREE.LinearFilter;
      loaded.needsUpdate = true;

      nightLightsTexture = loaded;
      material.uniforms.uNightLights!.value = loaded;
      material.uniforms.uHasNightLights!.value = 1;
    });
  }

  const setBasemap = (url: string): Promise<void> => {
    if (url === loadedUrl) return Promise.resolve();
    loadedUrl = url;

    return new Promise<void>((resolve) => {
      loader.load(
        url,
        (loaded) => {
          // Another swap may have started and finished while this one was in flight.
          if (loadedUrl !== url) {
            loaded.dispose();
            resolve();
            return;
          }
          // v = 0 must be the image's top row (north pole) to match the shader's uv.
          loaded.flipY = false;
          // The renderer runs NoToneMapping by deliberate decision (context.md §10), so
          // colour management has to be correct at the sampler or the Earth arrives
          // washed out.
          loaded.colorSpace = THREE.SRGBColorSpace;
          loaded.anisotropy = maxAnisotropy;
          loaded.wrapS = THREE.RepeatWrapping;
          loaded.wrapT = THREE.ClampToEdgeWrapping;
          loaded.minFilter = THREE.LinearMipmapLinearFilter;
          loaded.magFilter = THREE.LinearFilter;
          loaded.needsUpdate = true;

          texture?.dispose();
          texture = loaded;
          material.uniforms.uBasemap!.value = loaded;
          material.uniforms.uHasBasemap!.value = 1;
          resolve();
        },
        undefined,
        () => {
          // A globe without imagery is worse but still functional, and the app must be
          // able to start without it. Cleared so a later retry is not treated as a no-op.
          if (loadedUrl === url) loadedUrl = null;
          resolve();
        },
      );
    });
  };

  return {
    group,
    sphere,
    ready: setBasemap(basemapUrl),
    setBasemap,
    dispose() {
      sphere.geometry.dispose();
      material.dispose();
      texture?.dispose();
      specularTexture?.dispose();
      nightLightsTexture?.dispose();
    },
  };
}

const CLOUD_VERTEX = /* glsl */ `
  out vec3 vNormalObject;
  void main() {
    // Same object-space normal trick as SPHERE_VERTEX, so this layer's uv
    // mapping matches the basemap's exactly — the clouds have to sit over
    // the correct geography, not just anywhere on the sphere.
    vNormalObject = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CLOUD_FRAGMENT = /* glsl */ `
  precision highp float;
  in vec3 vNormalObject;
  out vec4 fragColor;

  uniform sampler2D uClouds;
  uniform float uHasClouds;
  uniform vec3 uSunDirection;
  uniform float uNightFloor;
  uniform float uOpacity;

  const float PI = 3.141592653589793;

  void main() {
    vec3 n = normalize(vNormalObject);
    float lon = atan(n.z, n.x);
    float lat = asin(clamp(n.y, -1.0, 1.0));
    vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);

    // The classic NASA cloud composite is a luminance image — bright where
    // there is cloud, dark where sky is clear — used here as both the white
    // tint and the alpha, rather than needing a real alpha channel.
    float intensity = texture(uClouds, uv).r * uHasClouds;

    float day = smoothstep(-0.75, 0.65, dot(n, normalize(uSunDirection)));
    vec3 colour = vec3(1.0) * mix(uNightFloor, 1.0, day);

    fragColor = vec4(colour, intensity * uOpacity);
  }
`;

export interface CloudLayer {
  mesh: THREE.Mesh;
  /** Resolves once the cloud texture has loaded, or immediately if it never does — a
   * missing cloud layer degrades to no clouds, not a broken globe. */
  ready: Promise<void>;
  dispose(): void;
}

/**
 * A thin static shell of clouds just above the surface — the single biggest
 * "this is a static model, not a living planet" gap identified against
 * Google Earth. Static by deliberate choice (not independently drifting):
 * consistent with the globe never moving on its own, and simpler.
 *
 * A dedicated shader rather than a stock material + alphaMap: Three.js's
 * alphaMap reads a texture's own alpha channel, which a plain RGB JPEG
 * doesn't have — sampling luminance for both tint and alpha needs a custom
 * fragment shader, the same reason the main sphere and specular mask do.
 */
export function buildClouds(cloudsUrl: string, maxAnisotropy = 1): CloudLayer {
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: CLOUD_VERTEX,
    fragmentShader: CLOUD_FRAGMENT,
    uniforms: {
      uClouds: { value: null },
      uHasClouds: { value: 0 },
      uSunDirection: { value: GLOBE_SUN_DIRECTION.clone() },
      // Clouds stay faintly visible on the night side rather than vanishing
      // outright — consistent with the main sphere's own uNightFloor, and
      // an abrupt disappearance at the terminator would read as a bug.
      uNightFloor: { value: 0.35 },
      uOpacity: { value: 0.8 },
    },
    transparent: true,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(CLOUD_RADIUS, 96, 64), material);

  const loader = new THREE.TextureLoader();
  let texture: THREE.Texture | null = null;

  const ready = new Promise<void>((resolve) => {
    loader.load(
      cloudsUrl,
      (loaded) => {
        loaded.flipY = false;
        // A luminance/data texture here (see the shader), not a colour
        // image — same reasoning as the specular mask's NoColorSpace.
        loaded.colorSpace = THREE.NoColorSpace;
        loaded.anisotropy = maxAnisotropy;
        loaded.wrapS = THREE.RepeatWrapping;
        loaded.wrapT = THREE.ClampToEdgeWrapping;
        loaded.minFilter = THREE.LinearMipmapLinearFilter;
        loaded.magFilter = THREE.LinearFilter;
        loaded.needsUpdate = true;

        texture = loaded;
        material.uniforms.uClouds!.value = loaded;
        material.uniforms.uHasClouds!.value = 1;
        resolve();
      },
      undefined,
      () => resolve(),
    );
  });

  return {
    mesh,
    ready,
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
      texture?.dispose();
    },
  };
}

/**
 * Fade the whole globe as one, during the hand-off into the water column.
 * The sphere carries its opacity as a uniform (its shader is custom); the outline and
 * markers are ordinary materials.
 */
export function setGlobeOpacity(group: THREE.Object3D, opacity: number): void {
  group.traverse((object) => {
    const material = (object as THREE.Mesh).material as THREE.Material | undefined;
    if (!material) return;
    if (material instanceof THREE.ShaderMaterial && material.uniforms.uOpacity) {
      material.uniforms.uOpacity.value = opacity;
      return;
    }
    if ("opacity" in material) {
      material.transparent = true;
      (material as THREE.LineBasicMaterial).opacity = opacity;
    }
  });
}

/**
 * The study region, drawn on the globe so the dive has a visible destination.
 *
 * Deliberately NOT on BLOOM_LAYER, unlike the water column's markers. The bloom pass sets
 * the camera to that layer alone (`effects.ts`), so the sphere is culled out of it and
 * cannot occlude anything — a glowing outline would bleed straight through the Earth when
 * the Bay of Bengal is on the far side. Off the bloom layer, ordinary depth testing against
 * the opaque sphere hides it correctly. `bioluminescence` at full opacity is already the
 * brightest thing on a basemap this dark.
 */
export function regionOutline(
  latRange: [number, number],
  lonRange: [number, number],
): THREE.LineLoop {
  const [lat0, lat1] = latRange;
  const [lon0, lon1] = lonRange;
  const points: THREE.Vector3[] = [];
  const push = (lat: number, lon: number) =>
    points.push(latLonToGlobe(lat, lon, OUTLINE_RADIUS));

  // Walked edge by edge rather than as four corners: a straight line between two corners
  // would cut through the sphere instead of following it.
  for (let i = 0; i <= 32; i++) push(lat0, lon0 + ((lon1 - lon0) * i) / 32);
  for (let i = 0; i <= 32; i++) push(lat0 + ((lat1 - lat0) * i) / 32, lon1);
  for (let i = 0; i <= 32; i++) push(lat1, lon1 - ((lon1 - lon0) * i) / 32);
  for (let i = 0; i <= 32; i++) push(lat1 - ((lat1 - lat0) * i) / 32, lon0);

  const outline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({
      color: new THREE.Color(...TOKEN_RGB.bioluminescence),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    }),
  );
  return outline;
}

/**
 * The floats, on the sphere.
 *
 * Drawn as points rather than the instanced spheres the water column uses: at globe scale
 * the whole Phailin box is a small patch, so a mesh marker would be sub-pixel anyway. They
 * will visibly cluster, which is true — that is what a 17° box looks like from orbit.
 */
export function globeFloatMarkers(
  positions: { lat: number; lon: number }[],
): THREE.Points | null {
  if (positions.length === 0) return null;

  const coords = new Float32Array(positions.length * 3);
  positions.forEach(({ lat, lon }, i) => {
    latLonToGlobe(lat, lon, MARKER_RADIUS).toArray(coords, i * 3);
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(coords, 3));

  const points = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: new THREE.Color(...TOKEN_RGB.bioluminescence),
      size: 0.028,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    }),
  );
  return points;
}


/** Far outside the globe view's max camera distance (9) — negligible
 * parallax as the camera orbits, so the field reads as fixed background
 * rather than something orbiting along with the viewer. */
const STARFIELD_RADIUS = 45;

/** A uniform random direction on the unit sphere (not `Math.random()` per
 * axis then normalized, which clusters toward the corners of the cube it
 * samples from — this is the standard unbiased spherical distribution). */
function randomOnSphere(radius: number): THREE.Vector3 {
  const u = Math.random();
  const v = Math.random();
  const theta = 2 * Math.PI * u;
  const phi = Math.acos(2 * v - 1);
  return new THREE.Vector3(
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.sin(phi) * Math.sin(theta),
    radius * Math.cos(phi),
  );
}

function starLayer(count: number, size: number, opacity: number, warmth: number): THREE.Points {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const color = new THREE.Color();

  for (let i = 0; i < count; i++) {
    randomOnSphere(STARFIELD_RADIUS).toArray(positions, i * 3);

    // Mostly white with a slight, varied tint — real starfields aren't a
    // uniform grey dust; a touch of blue-white/warm-white variety is most
    // of the difference between "scattered dots" and "a sky full of stars."
    const hue = Math.random() < warmth ? 0.08 + Math.random() * 0.05 : 0.58 + Math.random() * 0.08;
    const lightness = 0.7 + Math.random() * 0.3;
    color.setHSL(hue, 0.35, lightness);
    color.toArray(colors, i * 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity,
      depthWrite: false,
    }),
  );
}

/**
 * The globe against space, not a flat void — the missing piece that makes a
 * lit sphere read as a planet rather than a rendered prop on a page.
 *
 * Two point layers rather than one uniform field: a dense, dim background
 * layer and a sparser, brighter foreground layer, giving the size/brightness
 * variety a single fixed-size THREE.Points otherwise can't (stock
 * PointsMaterial has no per-vertex size without a custom shader — this stays
 * within the plan's "no custom shader needed" scope for this layer while
 * still avoiding a uniform dust of identical dots).
 */
export function buildStarfield(): THREE.Group {
  const group = new THREE.Group();
  group.add(starLayer(3200, 1.1, 0.55, 0.12));
  group.add(starLayer(220, 2.1, 0.85, 0.12));
  return group;
}
