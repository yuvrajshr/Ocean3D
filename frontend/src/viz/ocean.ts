/**
 * Sky, sea surface, marine snow and light shafts.
 *
 * The sea plane goes far past the terrain and the data, out to a horizon, so the
 * scene reads as a place and not an object. Snow and light shafts only render
 * when the camera is underwater.
 */

import * as THREE from "three";

import { TOKEN_RGB, WATER_GLSL, waterUniforms } from "./water";

export const SUN_DIRECTION = new THREE.Vector3(0.35, 0.82, 0.45).normalize();

/** Only objects on this layer can bloom. */
export const BLOOM_LAYER = 1;

const SKY_GLSL = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uMidSky;
  uniform vec3 uZenith;
  uniform vec3 uNearSurface;
  uniform vec3 uDeepWater;
  uniform vec3 uSunDirection;

  // One colour ramp that continues through the waterline.
  //
  // The horizon band is narrow and one-sided; below it is water, lit just under
  // the surface and darkening to abyss by ~35 degrees down. A brighter lower half
  // hid the light shafts and marine snow (both additive). It never goes fully
  // black, since black against lit water shows up as a silhouette.
  vec3 skyColour(vec3 dir) {
    float t = clamp(dir.y, -1.0, 1.0);

    if (t < 0.0) {
      float d = -t;                       // 0 at the waterline, 1 straight down
      // With a 42-degree FOV looking just below level, the lower frame only covers
      // d = 0 to ~0.47, so the ramp has to finish within that.
      vec3 water = mix(uNearSurface, uDeepWater, smoothstep(0.0, 0.20, d));
      water = mix(water, uZenith * 0.4, smoothstep(0.18, 0.55, d));
      // Slight brightening right at the waterline so the surface has an edge.
      water += uNearSurface * 0.50 * pow(1.0 - clamp(d * 9.0, 0.0, 1.0), 2.0);
      return water;
    }

    vec3 sky = mix(uHorizon, uMidSky, smoothstep(0.0, 0.30, t));
    sky = mix(sky, uZenith, smoothstep(0.24, 0.85, t));
    sky += uHorizon * 0.30 * pow(1.0 - clamp(t * 5.0, 0.0, 1.0), 2.0);

    float sun = max(dot(normalize(dir), normalize(uSunDirection)), 0.0);
    sky += vec3(0.16, 0.24, 0.26) * pow(sun, 40.0);
    sky += vec3(0.05, 0.09, 0.11) * pow(sun, 6.0) * 0.6;
    return sky;
  }
`;

/** A token colour, scaled by k. */
function dimmed(token: readonly number[], k: number): THREE.Color {
  return new THREE.Color(token[0]! * k, token[1]! * k, token[2]! * k);
}

/**
 * All the uniforms skyColour() uses. Both the sky and the sea surface call it, and
 * a uniform missing from either renders that material black, so both use this.
 */
export function skyUniforms() {
  return {
    uHorizon: { value: dimmed(TOKEN_RGB.current, 0.42) },
    uMidSky: { value: dimmed(TOKEN_RGB.thermocline, 0.8) },
    uZenith: { value: new THREE.Color(...TOKEN_RGB.abyss) },
    // Sunlit water needs to be fairly bright or there's no visible gradient, but
    // still well below the bright end of the colormap.
    uNearSurface: { value: dimmed(TOKEN_RGB.current, 0.62) },
    uDeepWater: { value: dimmed(TOKEN_RGB.thermocline, 0.28) },
    uSunDirection: { value: SUN_DIRECTION.clone() },
  };
}

// --- sky ---

export function buildSky(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      out vec3 vDirection;
      void main() {
        vDirection = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      in vec3 vDirection;
      out vec4 fragColor;
      ${SKY_GLSL}
      void main() {
        fragColor = vec4(skyColour(normalize(vDirection)), 1.0);
      }
    `,
    uniforms: skyUniforms(),
  });

  const sky = new THREE.Mesh(new THREE.SphereGeometry(160, 32, 24), material);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  return sky;
}

// --- sea surface ---

export function buildSeaSurface(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      uniform float uTime;
      out vec3 vWorld;
      out float vSwell;

      // Three waves at different scales and angles: enough to catch the light, not so
      // much that it looks stormy.
      float swell(vec2 p, float t) {
        float a = sin(p.x * 0.42 + t * 0.44) * 0.55;
        float b = sin(p.y * 0.35 - t * 0.37) * 0.45;
        float c = sin((p.x + p.y) * 0.27 + t * 0.29) * 0.35;
        return a + b + c;
      }

      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        float h = swell(world.xz, uTime);
        vSwell = h;
        world.y += h * 0.011;
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      in vec3 vWorld;
      in float vSwell;
      out vec4 fragColor;

      uniform vec3 uCameraPos;
      // uDeepWater comes from SKY_GLSL, so the water and the sky below the horizon match.
      uniform float uTime;

      ${SKY_GLSL}
      // For caustics()
      ${WATER_GLSL}

      void main() {
        vec3 viewDir = normalize(vWorld - uCameraPos);

        // Tilt the normal by the swell gradient so highlights move.
        vec2 g = vec2(
          cos(vWorld.x * 0.42 + uTime * 0.44) * 0.42,
          cos(vWorld.z * 0.35 - uTime * 0.37) * 0.35
        );
        vec3 normal = normalize(vec3(-g.x * 0.045, 1.0, -g.y * 0.045));

        bool underneath = uCameraPos.y < 0.0;
        if (underneath) normal = -normal;

        // Schlick's approximation: glancing angles reflect, looking straight down transmits.
        float cosTheta = clamp(dot(-viewDir, normal), 0.0, 1.0);
        float fresnel = 0.02 + 0.98 * pow(1.0 - cosTheta, 5.0);

        vec3 reflectDir = reflect(viewDir, normal);

        if (underneath) {
          // Snell's window: from below, the surface is see-through inside a ~48.6 degree
          // cone and a mirror outside it.
          float up = clamp(viewDir.y, 0.0, 1.0);
          float window = smoothstep(0.50, 0.78, up);

          // The whole sky above folds into that cone; remapping up onto the sky's y does
          // the refraction.
          float skyY = clamp((up - 0.50) / 0.50, 0.0, 1.0);
          vec3 flat3 = normalize(vec3(viewDir.x, 0.0, viewDir.z) + vec3(1e-4, 0.0, 0.0));
          vec3 through = skyColour(normalize(mix(flat3, vec3(0.0, 1.0, 0.0), skyY)));

          // Total internal reflection outside the window. Clamp below zero so the swell
          // doesn't flip it into the sky and flash.
          vec3 m = reflectDir;
          m.y = min(m.y, -0.004);
          vec3 mirrored = skyColour(normalize(m));

          vec3 under = mix(mirrored, through, window);
          under += vec3(0.30, 0.62, 0.62) * caustics(vWorld.xz, uTime, 0.0)
                 * 0.42 * mix(0.30, 1.0, window);
          float sunUp = max(dot(normalize(-reflectDir), normalize(uSunDirection)), 0.0);
          under += vec3(0.20, 0.31, 0.33) * pow(sunUp, 18.0) * window;

          fragColor = vec4(under, mix(0.95, 0.68, window));
          return;
        }

        // Above water: same clamp, the other way.
        vec3 s = reflectDir;
        s.y = max(s.y, 0.008);
        vec3 reflected = skyColour(normalize(s));

        // Sun glint, small and sharp.
        float glint = pow(max(dot(normalize(s), normalize(uSunDirection)), 0.0), 240.0);
        reflected += vec3(0.55, 0.72, 0.78) * glint * 0.9;

        vec3 colour = mix(uDeepWater, reflected, fresnel);

        // Fade the plane into the sky with distance so its edge isn't visible.
        float away = length(vWorld.xz - uCameraPos.xz);
        colour = mix(colour, skyColour(normalize(vec3(viewDir.x, 0.004, viewDir.z))),
                     smoothstep(30.0, 95.0, away));

        // Low opacity looking straight down, so it doesn't cover what's below.
        fragColor = vec4(colour, mix(0.07, 0.96, pow(fresnel, 0.65)));
      }
    `,
    uniforms: {
      uTime: { value: 0 },
      uCameraPos: { value: new THREE.Vector3() },
      ...waterUniforms(),
      ...skyUniforms(),
    },
  });

  // Much wider than the terrain so the water reaches a horizon.
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(120, 120, 220, 220), material);
  surface.rotation.x = -Math.PI / 2;
  // Behind the data; see RENDER_ORDER in viz/lattice.ts (not imported to avoid a cycle).
  surface.renderOrder = -6;
  surface.frustumCulled = false;
  return surface;
}

// --- marine snow ---

export function buildMarineSnow(bounds: THREE.Vector3, count = 2600): THREE.Points {
  const positions = new Float32Array(count * 3);
  const speeds = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * bounds.x;
    // Denser near the surface.
    positions[i * 3 + 1] = -Math.pow(Math.random(), 1.7) * bounds.y;
    positions[i * 3 + 2] = (Math.random() - 0.5) * bounds.z;
    speeds[i] = 0.004 + Math.random() * 0.012;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("speed", new THREE.BufferAttribute(speeds, 1));

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      in float speed;
      uniform float uTime;
      uniform float uFallHeight;
      out float vFade;
      void main() {
        vec3 p = position;
        p.y = -mod(-p.y + uTime * speed, uFallHeight);
        p.x += sin(uTime * 0.25 + speed * 90.0) * 0.006;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        // Fade with depth.
        vFade = clamp(1.0 + p.y * 0.9, 0.06, 1.0);
        // Fade out near the camera (which is inside the particle field underwater).
        vFade *= smoothstep(0.30, 1.10, -mv.z);
        gl_PointSize = clamp(1.35 * (7.0 / -mv.z), 1.0, 4.5);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      in float vFade;
      out vec4 fragColor;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = dot(d, d);
        if (r > 0.25) discard;
        // Kept subtle, but visible enough to show you're looking through water.
        float a = (1.0 - r * 4.0) * vFade * 0.24;
        fragColor = vec4(vec3(0.55, 0.74, 0.78), a);
      }
    `,
    uniforms: {
      uTime: { value: 0 },
      uFallHeight: { value: bounds.y },
    },
  });

  const points = new THREE.Points(geometry, material);
  // Behind the data (RENDER_ORDER in viz/lattice.ts); additive snow on top would
  // change the data colours.
  points.renderOrder = -4;
  points.frustumCulled = false;
  points.visible = false; // underwater only
  return points;
}

// --- light shafts ---

export function buildLightShafts(bounds: THREE.Vector3): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      out vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      in vec2 vUv;
      out vec4 fragColor;
      uniform float uTime;
      uniform float uSeed;
      void main() {
        // Bright at the surface and fading downward. vUv.y (not 1.0 - vUv.y), since
        // PlaneGeometry has uv.y = 1 at the top and these hang from the waterline.
        float vertical = pow(vUv.y, 1.7);
        float across = pow(sin(vUv.x * 3.14159), 1.6);
        float flicker = 0.72 + 0.28 * sin(uTime * 0.7 + uSeed * 6.28);
        float a = vertical * across * flicker * 0.2;
        fragColor = vec4(vec3(0.40, 0.70, 0.76), a);
      }
    `,
    uniforms: { uTime: { value: 0 }, uSeed: { value: 0 } },
  });

  // A few large shafts rather than many narrow ones, so they actually fill the frame.
  for (let i = 0; i < 5; i++) {
    const shaftMaterial = material.clone();
    shaftMaterial.uniforms.uSeed!.value = Math.random();
    const shaft = new THREE.Mesh(
      new THREE.PlaneGeometry(bounds.x * 0.3, bounds.y * 2.4),
      shaftMaterial,
    );
    shaft.position.set(
      (Math.random() - 0.5) * bounds.x * 0.8,
      // Top edge at the waterline, long enough to run past the bottom of the box.
      -bounds.y * 1.2,
      (Math.random() - 0.5) * bounds.z * 0.8,
    );
    // Rotation is set each frame in tick() to face the camera; a fixed yaw leaves
    // some of these flat planes edge-on and invisible.
    shaft.userData.jitter = (Math.random() - 0.5) * 0.9;
    shaft.rotation.z = (Math.random() - 0.5) * 0.16;
    group.add(shaft);
  }

  // Behind the data (RENDER_ORDER in viz/lattice.ts). Group renderOrder is used
  // as the sort key.
  group.renderOrder = -3;
  group.visible = false; // underwater only
  return group;
}

export { WATER_GLSL, waterUniforms };
