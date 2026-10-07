/**
 * The post-processing chain.
 *
 * This is where "premium 2027 tech branding" actually lives. Three.js draws the
 * scene; this decides what the image looks like once the scene exists.
 *
 * The chain, in order:
 *
 *   scene -> chromatic split -> + bloom -> + speed lines -> vignette
 *         -> dither -> grain -> tone map -> screen
 *
 * The chromatic split and the speed lines are driven by the feel bus
 * (render/fx.ts) and sit at zero most of the time: they are punctuation for
 * dashes and steals, not a permanent look.
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
  abs,
  atan,
  div,
  fract,
  hash,
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

import { NEON, POST } from './palette.ts';
import { fxAberration, fxSpeed } from './fx.ts';

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
  const sceneTex = scenePass.getTextureNode();

  // Aspect-corrected from the live framebuffer size rather than a constant, so
  // radial effects stay circular when a phone rotates. Without the correction
  // they are ellipses stretched to the viewport, which reads as a smear.
  const aspect = div(screenSize.x, screenSize.y);
  const centred = sub(screenUV, 0.5);
  const radius = length(vec2(mul(centred.x, aspect), centred.y));

  // --- chromatic split -------------------------------------------------------
  // Red pushed outward, blue pulled inward, radially, so the centre of the
  // frame (where you are) stays sharp and the edges tear. Scaled by the feel
  // bus, so at rest this is three samples of the same texel.
  const split = mul(centred, mul(fxAberration, 0.022));
  const red = sceneTex.sample(add(screenUV, split)).r;
  const blue = sceneTex.sample(sub(screenUV, split)).b;
  const color = vec4(red, sceneTex.g, blue, sceneTex.a);

  // --- bloom ---------------------------------------------------------------
  // `bloom()` returns the glow *contribution*, not a composited image, so it has
  // to be added back by hand. This is the pattern from three's own examples.
  // Bloom reads the clean scene texture; the split is applied to what it adds to.
  const bloomPass = bloom(sceneTex, POST.bloomStrength, POST.bloomRadius, POST.bloomThreshold);
  let node = add(color, bloomPass);

  // --- speed lines -----------------------------------------------------------
  // Thin rays from the centre, only at the edges of the frame, with dashes
  // that STREAM outward rather than flicker -- motion, not flashing, so no
  // part of this strobes. Each of 160 angular buckets is either a ray or not,
  // fixed by a hash, so the pattern is stable and only its flow moves. Narrow
  // rays (a sliver of each bucket) and sparse ones, so they read as streaks
  // of light rather than as a sunburst painted over the frame.
  const angle = atan(centred.y, mul(centred.x, aspect));
  const slot = mul(add(angle, 3.1416), 240 / 6.2832);
  const bucket = floor(slot);
  // Distance from the bucket's centre line: only the middle sliver is lit.
  const thin = sub(1, smoothstep(0.04, 0.16, abs(sub(fract(slot), 0.5))));
  const isRay = mul(smoothstep(0.78, 0.82, hash(bucket)), thin);
  const flow = pow(fract(add(sub(mul(radius, 3.0), mul(time, 4.5)), mul(hash(add(bucket, 17)), 9))), 8);
  const edge = smoothstep(0.34, 0.7, radius);
  const lines = mul(mul(mul(isRay, flow), edge), mul(fxSpeed, 0.9));
  const lineTint = new THREE.Color(NEON.blue);
  node = add(node, vec4(mul(lines, lineTint.r), mul(lines, lineTint.g), mul(lines, lineTint.b), 0));

  // --- vignette ------------------------------------------------------------

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