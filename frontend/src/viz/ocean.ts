/**
 * Sky, sea surface, and the things suspended in the water.
 *
 * The sea plane deliberately extends far past both the terrain and the
 * analysis. A horizon is what tells the eye this is a place rather than an
 * object, and it is the single largest reason the earlier build read as a
 * chunk floating in space.
 *
 * Marine snow and light shafts render only while the camera is below the
 * waterline. That is both a real saving and physically right: from above the
 * surface you would not see either.
 */

import * as THREE from "three";

import { TOKEN_RGB, WATER_GLSL, waterUniforms } from "./water";

export const SUN_DIRECTION = new THREE.Vector3(0.35, 0.82, 0.45).normalize();

/** Objects on this layer are the only ones allowed to bloom. */
export const BLOOM_LAYER = 1;

const SKY_GLSL = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uMidSky;
  uniform vec3 uZenith;
  uniform vec3 uSunDirection;

  // Deep twilight, in three stops rather than two.
  //
  // The first attempt ran thermocline to abyss, which are the two darkest
  // tokens in the system: the result was black on black, the horizon was
  // invisible, and the scene still read as a void. Anchoring the horizon on
  // the "current" token -- the brightest structural one -- gives a real
  // horizon while staying inside the palette. It still sits far below the
  // console chrome in luminance, so it cannot compete with the data.
  vec3 skyColour(vec3 dir) {
    float t = clamp(dir.y, -1.0, 1.0);
    vec3 sky = mix(uHorizon, uMidSky, smoothstep(-0.05, 0.28, t));
    sky = mix(sky, uZenith, smoothstep(0.22, 0.95, t));

    // Haze thickening toward the horizon, as air does over a long sea path.
    sky += uHorizon * 0.35 * pow(1.0 - clamp(abs(t) * 3.2, 0.0, 1.0), 2.0);

    float sun = max(dot(normalize(dir), normalize(uSunDirection)), 0.0);
    sky += vec3(0.30, 0.42, 0.44) * pow(sun, 40.0);
    sky += vec3(0.10, 0.17, 0.20) * pow(sun, 6.0) * 0.6;
    return sky;
  }
`;

// ---------------------------------------------------------------------- sky

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
    uniforms: {
      uHorizon: { value: new THREE.Color(0.085, 0.30, 0.375) },
      uMidSky: { value: new THREE.Color(0.042, 0.125, 0.192) },
      uZenith: { value: new THREE.Color(...TOKEN_RGB.abyss) },
      uSunDirection: { value: SUN_DIRECTION.clone() },
    },
  });

  const sky = new THREE.Mesh(new THREE.SphereGeometry(160, 32, 24), material);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  return sky;
}

// -------------------------------------------------------------- sea surface

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

      // Three summed waves at different scales and angles. Enough to break the
      // mirror and catch the light; not so much that it reads as a stormy sea,
      // which would be a claim about conditions we are not modelling.
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
      uniform vec3 uDeepColor;
      uniform float uTime;

      ${SKY_GLSL}

      void main() {
        vec3 viewDir = normalize(vWorld - uCameraPos);

        // Perturb the normal by the swell gradient so highlights travel.
        vec2 g = vec2(
          cos(vWorld.x * 0.42 + uTime * 0.44) * 0.42,
          cos(vWorld.z * 0.35 - uTime * 0.37) * 0.35
        );
        vec3 normal = normalize(vec3(-g.x * 0.045, 1.0, -g.y * 0.045));

        bool underneath = uCameraPos.y < 0.0;
        if (underneath) normal = -normal;

        // Schlick's approximation: glancing angles reflect, overhead angles
        // transmit. This is the whole reason a real sea reads as a surface.
        float cosTheta = clamp(dot(-viewDir, normal), 0.0, 1.0);
        float fresnel = 0.02 + 0.98 * pow(1.0 - cosTheta, 5.0);

        vec3 reflectDir = reflect(viewDir, normal);
        vec3 reflected = skyColour(reflectDir);

        // Sun glint. Sharp and small, so it reads as sun on water rather than
        // as a bloom smear.
        float glint = pow(max(dot(reflectDir, normalize(uSunDirection)), 0.0), 240.0);
        reflected += vec3(0.55, 0.72, 0.78) * glint * 1.6;

        // Looking straight down you see into the water; looking out toward the
        // horizon you see the sky on it. Without a floor on the mix the sea
        // renders as near-black against a near-black scene and disappears,
        // which is what happened on the first attempt.
        vec3 colour = mix(uDeepColor, reflected, clamp(fresnel + 0.10, 0.0, 1.0));
        float alpha = underneath ? 0.62 : mix(0.58, 0.97, fresnel);

        fragColor = vec4(colour, alpha);
      }
    `,
    uniforms: {
      uTime: { value: 0 },
      uCameraPos: { value: new THREE.Vector3() },
      uDeepColor: { value: new THREE.Color(0.030, 0.105, 0.150) },
      uHorizon: { value: new THREE.Color(0.085, 0.30, 0.375) },
      uMidSky: { value: new THREE.Color(0.042, 0.125, 0.192) },
      uZenith: { value: new THREE.Color(...TOKEN_RGB.abyss) },
      uSunDirection: { value: SUN_DIRECTION.clone() },
    },
  });

  // Far wider than the terrain, so the water runs out to a horizon.
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(120, 120, 220, 220), material);
  surface.rotation.x = -Math.PI / 2;
  surface.renderOrder = 6;
  surface.frustumCulled = false;
  return surface;
}

// ------------------------------------------------------------- marine snow

export function buildMarineSnow(bounds: THREE.Vector3, count = 2600): THREE.Points {
  const positions = new Float32Array(count * 3);
  const speeds = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * bounds.x;
    // Biased toward the surface, where suspended matter actually concentrates.
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
        // Fade with depth: less light down there to scatter off it.
        vFade = clamp(1.0 + p.y * 0.9, 0.06, 1.0);
        gl_PointSize = 1.7 * (7.0 / -mv.z);
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
        float a = (1.0 - r * 4.0) * vFade * 0.34;
        fragColor = vec4(vec3(0.62, 0.80, 0.82), a);
      }
    `,
    uniforms: {
      uTime: { value: 0 },
      uFallHeight: { value: bounds.y },
    },
  });

  const points = new THREE.Points(geometry, material);
  points.renderOrder = 7;
  points.frustumCulled = false;
  points.visible = false; // only underwater
  return points;
}

// ------------------------------------------------------------- light shafts

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
        // Bright at the surface, gone by the bottom of the shaft: light being
        // absorbed on the way down, which is the only reason shafts are visible.
        float vertical = pow(1.0 - vUv.y, 2.1);
        float across = sin(vUv.x * 3.14159);
        float flicker = 0.72 + 0.28 * sin(uTime * 0.7 + uSeed * 6.28);
        float a = vertical * across * flicker * 0.055;
        fragColor = vec4(vec3(0.44, 0.74, 0.78), a);
      }
    `,
    uniforms: { uTime: { value: 0 }, uSeed: { value: 0 } },
  });

  for (let i = 0; i < 7; i++) {
    const shaftMaterial = material.clone();
    shaftMaterial.uniforms.uSeed!.value = Math.random();
    const shaft = new THREE.Mesh(
      new THREE.PlaneGeometry(bounds.x * 0.16, bounds.y * 0.95),
      shaftMaterial,
    );
    shaft.position.set(
      (Math.random() - 0.5) * bounds.x * 0.8,
      -bounds.y * 0.47,
      (Math.random() - 0.5) * bounds.z * 0.8,
    );
    shaft.rotation.y = Math.random() * Math.PI;
    shaft.rotation.z = (Math.random() - 0.5) * 0.16;
    group.add(shaft);
  }

  group.renderOrder = 8;
  group.visible = false; // only underwater
  return group;
}

export { WATER_GLSL, waterUniforms };
