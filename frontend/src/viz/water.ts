/**
 * Shared water optics.
 *
 * Seawater absorbs light unevenly across the spectrum — red disappears within
 * metres, green persists, blue goes deepest — which is why the ocean is blue
 * and why everything in it darkens toward black. This is the single effect that
 * does most of the work in making the scene read as water rather than as a lit
 * box, so it lives in one place and every shader in the scene applies it.
 *
 * The coefficients are NOT the true ones. Real seawater extinguishes red within
 * about 10 m, and at this scene's ~480x vertical exaggeration that would render
 * the entire column black a pixel below the surface. These are tuned so the
 * *sequence* is truthful — red first, then green, blue last — over the depth
 * range the app actually shows. That is a deliberate, documented departure:
 * the colour of the DATA is never touched by it, only the water around it.
 */

/**
 * Absorption per metre.
 *
 * Raised sharply after the first attempt, and the reason is worth recording.
 * The seafloor's continental slope was rendering as a sheer wall — unavoidable,
 * because a slope that falls 2 km over 60 km genuinely IS vertical once the
 * vertical axis is stretched a couple of hundred times. Smoothing it did not
 * help and flattening it enough to look natural would have crushed the water
 * column to a film.
 *
 * The actual fix was to stop lighting it. In real seawater there is no light at
 * 1,000 m: you cannot see the abyssal plain, only the shelf and the upper
 * slope. Making the water absorb the way it really does means the shelf and
 * coastline read clearly, and everything below fades into darkness — which is
 * both what the eye expects and, conveniently, where the exaggerated geometry
 * stops being legible anyway.
 */
export const ABSORPTION = { r: 0.0062, g: 0.0034, b: 0.0021 } as const;

/** Colour the water itself scatters back, from the `current` token. */
/**
 * What distant things fade INTO. It has to match the water they are seen
 * against, or fog cannot hide anything: terrain fully fogged to a colour half
 * as bright as its background still reads as a dark silhouette, which is
 * exactly how the continental slope kept reappearing after it was "hidden".
 * Kept in step with `uNearSurface` in ocean.ts — if one moves, so does this.
 */
export const SCATTER_COLOR = { r: 0.062, g: 0.24, b: 0.305 } as const;

export const TOKEN_RGB = {
  abyss: [0.02, 0.043, 0.071],
  thermocline: [0.051, 0.141, 0.212],
  current: [0.11, 0.431, 0.549],
  bioluminescence: [0.31, 0.91, 0.769],
  advisory: [0.91, 0.635, 0.239],
  foam: [0.918, 0.953, 0.945],
} as const;

/**
 * GLSL shared by the terrain, volume and surface shaders.
 *
 * `waterExtinction` is the transmittance over a path length; `applyWater`
 * composites a surface colour through that path and adds the scattered
 * in-water light, which is what stops distant seafloor going pure black.
 */
export const WATER_GLSL = /* glsl */ `
  uniform vec3 uAbsorption;
  uniform vec3 uScatter;
  uniform float uWaterDensity;

  vec3 waterExtinction(float pathMetres) {
    return exp(-uAbsorption * max(pathMetres, 0.0));
  }

  // colour     : the lit surface colour, before water is accounted for
  // depthMetres: how deep the shaded point is (drives spectral absorption)
  // fogAmount  : 0..1, how much water lies between the point and the eye
  //
  // The two are deliberately separate. Absorption alone turns deep terrain
  // black, and black is not invisible — against lit water it reads as a
  // silhouette, which is exactly how the exaggerated continental slope kept
  // showing up as a wall. Distant things have to fade INTO the water's own
  // colour, the way they do in reality, not out of the frame.
  vec3 applyWater(vec3 colour, float depthMetres, float fogAmount) {
    vec3 transmit = waterExtinction(depthMetres);
    vec3 ambient = uScatter * (0.22 + 0.78 * exp(-depthMetres * 0.0017));
    return mix(colour * transmit, ambient, clamp(fogAmount, 0.0, 1.0));
  }

  // How much water a ray crosses, in world units, for a camera that may be
  // above or below the surface.
  float waterPath(vec3 cameraPos, vec3 worldPos) {
    float total = length(cameraPos - worldPos);
    if (cameraPos.y <= 0.0) return total;
    float span = cameraPos.y - worldPos.y;
    if (span <= 1e-5) return 0.0;
    return total * clamp(-worldPos.y / span, 0.0, 1.0);
  }

  // Shallow-water caustics. Real caustics are surface waves focusing sunlight,
  // so they exist only where sunlight still reaches: this fades out entirely by
  // ~250 m and never appears on the abyssal plain, where it would be fiction.
  float caustics(vec2 p, float time, float depthMetres) {
    float reach = 1.0 - smoothstep(60.0, 250.0, depthMetres);
    if (reach <= 0.001) return 0.0;

    vec2 q = p * 3.4;
    float a = sin(q.x * 1.7 + time * 0.45) + sin(q.y * 1.9 - time * 0.38);
    float b = sin((q.x + q.y) * 1.3 + time * 0.52);
    float c = sin((q.x - q.y) * 1.6 - time * 0.31);
    float v = (a + b + c) / 4.0;
    v = pow(max(v, 0.0), 3.0);
    return v * reach;
  }
`;

export function waterUniforms() {
  return {
    uAbsorption: { value: [ABSORPTION.r, ABSORPTION.g, ABSORPTION.b] },
    uScatter: { value: [SCATTER_COLOR.r, SCATTER_COLOR.g, SCATTER_COLOR.b] },
    // Per world unit, not per metre: the scene is wildly anisotropic (one unit
    // is ~850 km across but ~4.4 km down), so a single metric fog distance is
    // meaningless. Tuned so the shelf stays legible and the basin does not.
    uWaterDensity: { value: 2.6 },
  };
}
