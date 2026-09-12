/**
 * Shared water optics.
 *
 * Seawater absorbs red first, then green, then blue, which is why the ocean looks
 * blue and darkens with depth. Every shader in the scene applies this.
 *
 * The coefficients aren't the real ones: real water kills red within ~10 m,
 * which at this exaggeration would make everything black just below the surface.
 * These keep the right order (red, green, blue) over the depths we show. The data
 * colours are never affected.
 */

/**
 * Absorption per metre. Set high enough that the deep, exaggerated slope fades
 * into darkness, like it would in real water below a few hundred metres.
 */
export const ABSORPTION = { r: 0.0062, g: 0.0034, b: 0.0021 } as const;

/** Colour scattered back by the water (from the current token). */
/**
 * What distant things fade into. Has to match the background water or fogged
 * terrain still shows as a dark silhouette. Keep in sync with uNearSurface in
 * ocean.ts.
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
 * GLSL shared by the terrain, volume and surface shaders. waterExtinction gives
 * transmittance over a path; applyWater blends a colour through it and adds
 * scattered light so distant seafloor doesn't go black.
 */
export const WATER_GLSL = /* glsl */ `
  uniform vec3 uAbsorption;
  uniform vec3 uScatter;
  uniform float uWaterDensity;

  vec3 waterExtinction(float pathMetres) {
    return exp(-uAbsorption * max(pathMetres, 0.0));
  }

  // colour : the lit surface colour
  // depthMetres: depth of the point (drives absorption)
  // fogAmount : 0..1, how much water is between the point and the eye
  //
  // Kept separate because absorption alone turns deep terrain black, which shows
  // up as a silhouette. Distant things have to fade into the water colour instead.
  vec3 applyWater(vec3 colour, float depthMetres, float fogAmount) {
    vec3 transmit = waterExtinction(depthMetres);
    vec3 ambient = uScatter * (0.22 + 0.78 * exp(-depthMetres * 0.0017));
    return mix(colour * transmit, ambient, clamp(fogAmount, 0.0, 1.0));
  }

  // How much water a ray passes through, in world units, with the camera above or
  // below the surface.
  float waterPath(vec3 cameraPos, vec3 worldPos) {
    float total = length(cameraPos - worldPos);
    if (cameraPos.y <= 0.0) return total;
    float span = cameraPos.y - worldPos.y;
    if (span <= 1e-5) return 0.0;
    return total * clamp(-worldPos.y / span, 0.0, 1.0);
  }

  // Shallow-water caustics. They fade out by ~250 m, since sunlight doesn't reach
  // deeper.
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
    // Per world unit, not per metre (one unit is ~850 km across but ~4.4 km down).
    uWaterDensity: { value: 2.6 },
  };
}
