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
  uniform vec3 uNearSurface;
  uniform vec3 uDeepWater;
  uniform vec3 uSunDirection;

  // One ramp, continued through the waterline.
  //
  // The previous version ran a bright current-derived horizon and then added
  // a haze term SYMMETRIC about t = 0, so every direction below the horizon
  // came back at roughly (0.11, 0.40, 0.50). With the camera near eye level
  // that is most of the frame — which is why the scene read as a teal void with
  // a lit box floating in it, and why the light shafts and marine snow have
  // never once been visible: both blend additively, and additive light does
  // not register against a ground that bright.
  //
  // The horizon band is now narrow and one-sided, and the lower hemisphere is
  // WATER: lit just under the surface, abyss by ~35 degrees down. This is
  // context.md §5.1 Principle 1 made literal — the ramp that encodes depth in
  // the data is the ramp the surroundings darken along.
  //
  // Still not true black at the bottom. water.ts's rule is that distant things
  // fade INTO the water rather than out of the frame, because black is not
  // invisible: against lit water it reads as a silhouette.
  vec3 skyColour(vec3 dir) {
    float t = clamp(dir.y, -1.0, 1.0);

    if (t < 0.0) {
      float d = -t;                       // 0 at the waterline, 1 straight down
      // The band that matters is small. With a 42-degree vertical fov looking
      // just below level, the whole lower frame spans d = 0 to about 0.47, so
      // the ramp has to complete inside that or the background is one flat
      // colour. The first attempt ran it over 0.02..0.34 and then 0.30..0.90 —
      // the second stop barely engaged, and all three colours were near-black
      // anyway, so it read as a dark void rather than as water with depth.
      vec3 water = mix(uNearSurface, uDeepWater, smoothstep(0.0, 0.20, d));
      water = mix(water, uZenith * 0.4, smoothstep(0.18, 0.55, d));
      // A thin lift right at the waterline, so the surface keeps an edge to sit
      // on. Without it the sea's silhouette dissolves and the scene loses the
      // horizon that makes it a place rather than an object.
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

/** A token, dimmed. Keeps the six-token rule visible at the point of use. */
function dimmed(token: readonly number[], k: number): THREE.Color {
  return new THREE.Color(token[0]! * k, token[1]! * k, token[2]! * k);
}

/**
 * Every uniform `skyColour` reads, in ONE place.
 *
 * The sky and the sea surface are separate materials with separate uniform
 * blocks, and both call `skyColour`. A value added to only one of them uploads
 * as zero and that material silently renders black. Handing both the same
 * factory makes disagreeing impossible, rather than making it a thing to
 * remember.
 */
export function skyUniforms() {
  return {
    uHorizon: { value: dimmed(TOKEN_RGB.current, 0.42) },
    uMidSky: { value: dimmed(TOKEN_RGB.thermocline, 0.8) },
    uZenith: { value: new THREE.Color(...TOKEN_RGB.abyss) },
    // Sunlit water, and it has to be genuinely bright or there is no gradient
    // to see: a ramp between three near-blacks is a flat dark field, which is
    // exactly what the first pass produced. It stays far below the data — the
    // colormap's warm end is ~0.9 — so the field still leads the frame.
    uNearSurface: { value: dimmed(TOKEN_RGB.current, 0.62) },
    uDeepWater: { value: dimmed(TOKEN_RGB.thermocline, 0.28) },
    uSunDirection: { value: SUN_DIRECTION.clone() },
  };
}

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
    uniforms: skyUniforms(),
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
      // uDeepWater now comes from SKY_GLSL, shared with the sky, so the water
      // you look INTO and the water you look THROUGH are the same colour.
      uniform float uTime;

      ${SKY_GLSL}
      // For caustics() — the surface has been able to draw them all along and
      // never did, because from below it was a flat 62%-opaque sheet.
      ${WATER_GLSL}

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

        if (underneath) {
          // Snell's window. From below, the surface is a WINDOW inside a cone of
          // about 48.6 degrees from vertical and a mirror everywhere outside it.
          // This is what gives the underwater view a lit ceiling for the data to
          // hang from, and it puts the brightest non-data value in the frame
          // overhead as a SHAPE — a rim — rather than as another flat wash.
          float up = clamp(viewDir.y, 0.0, 1.0);
          float window = smoothstep(0.50, 0.78, up);

          // The whole above-water hemisphere folds into that cone, so the rim
          // carries the horizon and the centre carries the zenith. Remapping
          // the up component onto the sky's own y is the refraction, in one line.
          float skyY = clamp((up - 0.50) / 0.50, 0.0, 1.0);
          vec3 flat3 = normalize(vec3(viewDir.x, 0.0, viewDir.z) + vec3(1e-4, 0.0, 0.0));
          vec3 through = skyColour(normalize(mix(flat3, vec3(0.0, 1.0, 0.0), skyY)));

          // Total internal reflection outside the window. Clamp below zero, or
          // the swell tips the vector into the sky branch and the ceiling
          // flashes in patches as the waves move.
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

        // Above water. Same clamp, opposite side: at grazing angles the swell
        // tips the reflection below the horizon and into the water branch.
        vec3 s = reflectDir;
        s.y = max(s.y, 0.008);
        vec3 reflected = skyColour(normalize(s));

        // Sun glint. Sharp and small, so it reads as sun on water rather than
        // as a bloom smear.
        float glint = pow(max(dot(normalize(s), normalize(uSunDirection)), 0.0), 240.0);
        reflected += vec3(0.55, 0.72, 0.78) * glint * 0.9;

        // The +0.10 mix floor is gone. It was propping the surface up because
        // the scene behind it was black, and it is why the near field never
        // darkened.
        vec3 colour = mix(uDeepWater, reflected, fresnel);

        // Dissolve the plane into the sky at range. It is 120 units across and
        // terminated in a hard edge that a raised camera could see.
        float away = length(vWorld.xz - uCameraPos.xz);
        colour = mix(colour, skyColour(normalize(vec3(viewDir.x, 0.004, viewDir.z))),
                     smoothstep(30.0, 95.0, away));

        // Was mix(0.58, 0.97, ...) — a 58% floor, i.e. a permanent sheet over
        // everything below the water even when looking straight down into it.
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

  // Far wider than the terrain, so the water runs out to a horizon.
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(120, 120, 220, 220), material);
  surface.rotation.x = -Math.PI / 2;
  // Behind the data. See RENDER_ORDER in viz/lattice.ts — the numbers live
  // there; ocean.ts does not import it only because that would be a cycle.
  // This was 6, which put a 66%-opaque sheet of water OVER the analysis.
  surface.renderOrder = -6;
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
        // The camera sits INSIDE this field now that the default view is
        // submerged, so a grain 20 cm from the lens would be a 40 px blob.
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
        // 0.34 was tuned against a background that never let it show. It reads
        // now, so it comes down — but only to 0.24: this is the one element
        // that tells the eye it is looking THROUGH water rather than at a pane.
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
  // Behind the data (RENDER_ORDER in viz/lattice.ts). Was 7: additive snow was
  // adding light onto data pixels, which is a colour shift the data forbids.
  points.renderOrder = -4;
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
        // vUv.y, NOT 1.0 - vUv.y. PlaneGeometry puts uv.y = 1 at the TOP row,
        // and these planes hang from the waterline, so the old expression put
        // zero brightness exactly where sunlight enters and full brightness at
        // the deep end. The shafts were upside down, which is why no amount of
        // raising their alpha ever made them read: the lit end was buried in
        // the dark. Bright at the surface, absorbed on the way down.
        float vertical = pow(vUv.y, 1.7);
        float across = pow(sin(vUv.x * 3.14159), 1.6);
        float flicker = 0.72 + 0.28 * sin(uTime * 0.7 + uSeed * 6.28);
        float a = vertical * across * flicker * 0.2;
        fragColor = vec4(vec3(0.40, 0.70, 0.76), a);
      }
    `,
    uniforms: { uTime: { value: 0 }, uSeed: { value: 0 } },
  });

  // Fewer and much larger. Seven narrow planes scattered over a 7-unit box left
  // most of the frame with no shaft in it at all.
  for (let i = 0; i < 5; i++) {
    const shaftMaterial = material.clone();
    shaftMaterial.uniforms.uSeed!.value = Math.random();
    const shaft = new THREE.Mesh(
      new THREE.PlaneGeometry(bounds.x * 0.3, bounds.y * 2.4),
      shaftMaterial,
    );
    shaft.position.set(
      (Math.random() - 0.5) * bounds.x * 0.8,
      // Top edge on the waterline, where the light actually enters, and long
      // enough to run down past the box into the dark.
      -bounds.y * 1.2,
      (Math.random() - 0.5) * bounds.z * 0.8,
    );
    // rotation.y is set per frame in the scene's tick: these are flat planes,
    // so with a fixed random yaw roughly a third of them are edge-on and
    // invisible at any given moment. A real shaft is a volume; billboarding is
    // the cheapest honest stand-in for one.
    shaft.userData.jitter = (Math.random() - 0.5) * 0.9;
    shaft.rotation.z = (Math.random() - 0.5) * 0.16;
    group.add(shaft);
  }

  // Behind the data (RENDER_ORDER in viz/lattice.ts). Was 8, same additive
  // problem as the snow. Group renderOrder does propagate as the sort key.
  group.renderOrder = -3;
  group.visible = false; // only underwater
  return group;
}

export { WATER_GLSL, waterUniforms };
