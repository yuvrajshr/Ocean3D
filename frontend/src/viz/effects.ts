/**
 * Post-processing.
 *
 * Bloom must never change how the data looks, so it's selective by layer: only
 * objects on BLOOM_LAYER (the markers and the sun glint) go into the bloom pass.
 * The water column isn't in that render, so it can't glow however bright it is.
 * A brightness threshold would break as soon as someone picked a warm colormap.
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
      // Clamp so a bright marker plus glow doesn't clip to a flat white disc.
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
        // Kept low so the markers don't outshine the data.
        0.5, // strength
        0.35, // radius
        0.0, // threshold 0: only the markers are in this render anyway
      ),
    );

    const combinePass = new ShaderPass(
      new THREE.ShaderMaterial({
        // Clone the uniforms; ShaderMaterial doesn't copy them, so two instances would
        // share one bloomTexture.
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

    // Pass 1: only the glow sources, on black (the camera layer mask filters the rest).
    this.camera.layers.set(BLOOM_LAYER);
    this.scene.background = null;
    this.renderer.setClearColor(0x000000, 1);
    this.bloomComposer.render();

    // Pass 2: the full scene, with the glow added on top.
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
