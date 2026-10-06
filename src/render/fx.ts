/**
 * The feel bus
 *
 * A handful of shader uniforms that gameplay writes and the image reads: how
 * hard the screen is streaking with speed, how far the colour channels are
 * split, and where we are inside the current beat of the music.
 *
 * Module-level on purpose. The writers (render/scene.ts, main.ts, the audio
 * clock) and the readers (render/post.ts, course/build.ts, the Core) are far
 * apart, and threading three numbers through every constructor between them
 * would couple modules that otherwise know nothing about each other. These are
 * cosmetic only -- nothing here may ever feed back into the simulation.
 *
 * Every value is eased by its writer; the shaders just read.
 */

import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

type FloatUniform = THREE.UniformNode<'float', number>;

/** 0..1. Speed lines at the screen edges: running fast, and hard in a dash. */
export const fxSpeed = uniform(0) as unknown as FloatUniform;

/** 0..1. Chromatic split, pulsed by dashes and steals, then decaying. */
export const fxAberration = uniform(0) as unknown as FloatUniform;

/**
 * 0..1, peaking on every kick drum and decaying before the next.
 *
 * At 130 BPM that is ~2.2 pulses a second, under the 3 Hz photosensitive
 * flash limit (WCAG 2.3.1) -- keep any beat-driven brightness on the beat, never
 * on 16ths.
 */
export const fxBeat = uniform(0) as unknown as FloatUniform;

/**
 * The user asked their OS for less motion. Shake, FOV kicks, speed lines and
 * hit-stop all honour it; colour and light still react, which carries the
 * energy without moving the image.
 */
export const reducedMotion: boolean =
  typeof globalThis.matchMedia === 'function' &&
  globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
