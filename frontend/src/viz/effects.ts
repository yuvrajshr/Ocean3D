/**
 * Post-processing, with a hard boundary around the data.
 *
 * context.md §5.1 permits the ocean to be cinematic but forbids any effect from
 * altering a value the reader might interpret. Bloom is the dangerous one: a
 * glow bleeding off the warm end of a cmocean ramp would make a 29 °C cell look
 * hotter than a 28 °C one by more than the colour scale says, and nobody would
 * notice it happening.
 *
 * So bloom is *selective*, by construction rather than by tuning. Only objects
 * on BLOOM_LAYER — the instrument markers and the sun glint — are rendered into
 * the bloom pass at all. The water column is not in that render, so it cannot
 * contribute to the glow no matter how bright its colours get. A brightness
 * threshold would have been fewer lines and would have failed silently the
 * first time somebody selected a warm palette.
 */

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

import { BLOOM_LAYER } from "./ocean";

const COMBINE_SHADER = {
  uniforms: {
    baseTexture: { value: null as THREE.Texture | null },
    bloomTexture: { value: null as THREE.Texture | null },
    bloomStrength: { value: 0.9 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D baseTexture;
    uniform sampler2D bloomTexture;
    uniform float bloomStrength;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D(baseTexture, vUv);
      vec4 glow = texture2D(bloomTexture, vUv);
      // Clamped. This was an unbounded base + glow * strength: a foam marker at
      // 0.92 plus a full-strength glow landed near 2.0 and clipped to a flat
      // white disc, which is what made the markers read as lens flares rather
      // than instruments. The clamp does not stop bloom bleeding onto
      // neighbouring pixels; only the smaller radius bounds that.
      gl_FragColor = vec4(min(base.rgb + glow.rgb * bloomStrength, vec3(1.0)), base.a);
    }
  `,
};

export class OceanEffects {
  private readonly bloomComposer: EffectComposer;
  private readonly finalComposer: EffectComposer;
  private readonly bloomLayer = new THREE.Layers();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    this.bloomLayer.set(BLOOM_LAYER);

    const size = renderer.getSize(new THREE.Vector2());

    this.bloomComposer = new EffectComposer(renderer);
    this.bloomComposer.renderToScreen = false;
    this.bloomComposer.addPass(new RenderPass(scene, camera));
    this.bloomComposer.addPass(
      new UnrealBloomPass(
        new THREE.Vector2(size.x, size.y),
        // Was 1.15 / 0.62. The markers are chrome — they encode position, not a
        // value — and at that strength they were the brightest thing in the
        // frame, above the data they exist to point at.
        0.5, // strength
        0.35, // radius
        0.0, // threshold: zero is correct here, because only the markers are
        //                  in this render at all — the layer does the selecting
      ),
    );

    const combinePass = new ShaderPass(
      new THREE.ShaderMaterial({
        // Cloned, not shared. COMBINE_SHADER is module-level and ShaderMaterial
        // does not copy the object it is handed, so two scenes (hot reload, a
        // second canvas) would share one bloomTexture and the last one to
        // construct would win.
        uniforms: THREE.UniformsUtils.clone(COMBINE_SHADER.uniforms),
        vertexShader: COMBINE_SHADER.vertexShader,
        fragmentShader: COMBINE_SHADER.fragmentShader,
        defines: {},
      }),
      "baseTexture",
    );
    combinePass.needsSwap = true;
    combinePass.material.uniforms.bloomTexture!.value =
      this.bloomComposer.renderTarget2.texture;

    this.finalComposer = new EffectComposer(renderer);
    this.finalComposer.addPass(new RenderPass(scene, camera));
    this.finalComposer.addPass(combinePass);
  }

  setSize(width: number, height: number): void {
    this.bloomComposer.setSize(width, height);
    this.finalComposer.setSize(width, height);
  }

  private readonly previousClear = new THREE.Color();

  render(): void {
    const previousBackground = this.scene.background;
    this.renderer.getClearColor(this.previousClear);
    const previousAlpha = this.renderer.getClearAlpha();

    // Pass 1 — glow sources only, on black. Everything else is excluded by the
    // camera layer mask, so it contributes nothing.
    this.camera.layers.set(BLOOM_LAYER);
    this.scene.background = null;
    this.renderer.setClearColor(0x000000, 1);
    this.bloomComposer.render();

    // Pass 2 — the real scene, plus the glow added back on top.
    this.camera.layers.enableAll();
    this.scene.background = previousBackground;
    this.renderer.setClearColor(this.previousClear, previousAlpha);
    this.finalComposer.render();
  }

  dispose(): void {
    this.bloomComposer.dispose();
    this.finalComposer.dispose();
  }
}
