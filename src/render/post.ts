/**
 * The post-processing chain.
 *
 * This is where "premium 2027 tech branding" actually lives. Three.js draws the
 * scene; this decides what the image looks like once the scene exists.
 *
 * The chain, in order:
 *
 *   scene -> + bloom -> vignette -> dither -> grain -> tone map -> screen
 *
 * Bloom goes on before the vignette so the glow itself gets darkened at the
 * corners rather than floating over them. Grain and dither go last because they
 * are image texture, not scene content -- they should not be blurred by the
 * bloom's mip chain and should not be affected by the vignette.
 *
 * Tone mapping and colour-space conversion are applied by the pipeline *after*
 * this chain, not by it. That is why the amplitudes in `POST` look small: they
 * are pre-tonemap values, so the tone curve compresses them.
 *
 * Cost: one extra full-screen pass plus bloom's mip chain. Bloom is the
 * expensive part. The good news is that this is entirely client-side, so it
 * cannot make the authoritative server miss a tick -- unlike the earlier worry
 * that a heavy frame would starve the reconciler of updates.
 */

import * as THREE from 'three/webgpu';
import {
  add,
  div,
  floor,
  float,
  length,
  mix,
  mul,
  oneMinus,
  pass,
  pow,
  screenSize,
  screenUV,
  smoothstep,
  sub,
  time,
  vec2,
  vec4,
  interleavedGradientNoise,
} from 'three/tsl';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';

import { POST } from './palette.ts';

export interface PostChain {
  /** Render through this instead of calling `renderer.render()`. */
  readonly pipeline: THREE.RenderPipeline;
  dispose(): void;
}

export function createPostChain(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): PostChain {
  // Render the scene into a texture we can sample. Everything downstream
  // operates on this node rather than on the scene directly.
  const scenePass = pass(scene, camera);
  const color = scenePass.getTextureNode();

  // --- bloom ---------------------------------------------------------------
  // `bloom()` returns the glow *contribution*, not a composited image, so it has
  // to be added back by hand. This is the pattern from three's own examples.
  const bloomPass = bloom(color, POST.bloomStrength, POST.bloomRadius, POST.bloomThreshold);
  let node = add(color, bloomPass);

  // --- vignette ------------------------------------------------------------
  // Aspect-corrected from the live framebuffer size rather than a constant, so
  // the darkening stays circular when a phone rotates. Without the correction
  // the vignette is an ellipse stretched to the viewport, which reads as a
  // gradient smear rather than as lens falloff.
  const aspect = div(screenSize.x, screenSize.y);
  const centred = sub(screenUV, 0.5);
  const radius = length(vec2(mul(centred.x, aspect), centred.y));

  // Fully lit at the centre, zero by 0.78.
  //
  // Written as `oneMinus(smoothstep(lo, hi, x))` rather than the more obvious
  // `smoothstep(hi, lo, x)`. Both describe an inverted ramp, but the reversed-edge
  // form has `edge0 > edge1`, which GLSL and WGSL both leave *undefined* — and
  // this game ships a WebGPU path and a WebGL2 fallback, so an undefined
  // construct is an undefined vignette on one of them. The `oneMinus` form is
  // unambiguous on both.
  const falloff = oneMinus(smoothstep(0.28, 0.78, radius));
  const shade = pow(falloff, POST.vignettePower);
  const lit = mix(float(1.0), shade, POST.vignette);

  // Alpha passes through untouched; only RGB is darkened. Broadcast by hand
  // rather than via the two-argument `vec4(vec3, float)` form, which will not
  // accept a float node where a vec3 is expected.
  node = mul(node, vec4(lit, lit, lit, 1.0));

  // --- dither --------------------------------------------------------------
  // Static, and far weaker than the grain. Its only job is to break up the
  // banding that 8-bit output shows in the dark gradient above the horizon.
  //
  // Both this and the grain broadcast one scalar across RGB. `vec4` takes the
  // components individually rather than being handed a vec3, because that keeps
  // the scalar's concrete `float` node type intact -- wrapping it in a vec3
  // first and annotating the helper as a bare `THREE.Node` erases it, and the
  // vector constructors then reject the value.
  const ditherAmount = mul(sub(interleavedGradientNoise(mul(screenUV, 512)), float(0.5)), POST.dither);
  node = add(node, vec4(ditherAmount, ditherAmount, ditherAmount, 0));

  // --- grain ---------------------------------------------------------------
  // `time` steps rather than scrolls. A continuously advancing offset makes the
  // noise slide across the frame, which reads as a dirty lens; stepping it a few
  // times a second reads as film.
  const tick = floor(mul(time, POST.grainHz));
  const grainSeed = vec2(tick, mul(tick, 1.7));
  const grainSample = interleavedGradientNoise(add(mul(screenUV, POST.grainScale), grainSeed));
  const grainAmount = mul(sub(grainSample, float(0.5)), POST.grain);
  node = add(node, vec4(grainAmount, grainAmount, grainAmount, 0));

  const pipeline = new THREE.RenderPipeline(renderer);
  // Left as a vec4 rather than collapsed to RGB. Every operation above is
  // alpha-preserving, so the pipeline can take the vec4 directly and apply tone
  // mapping and sRGB conversion itself.
  pipeline.outputNode = node;

  return {
    pipeline,
    dispose() {
      bloomPass.dispose();
      pipeline.dispose();
    },
  };
}