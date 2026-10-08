/**
 * Frame loop
 *
 * One callback per animation frame, with wall-clock delta for cosmetics.
 *
 * There is deliberately no fixed-timestep accumulator here any more. Under
 * server reconciliation the simulation clock belongs to `predict.tick()`,
 * which returns the number of fixed input steps due this frame and re-runs the
 * shared step function that many times. Accumulating time in a second place
 * would give the client two opinions about how far the world has advanced, and
 * the one that loses produces rubber-banding that reads as a physics bug.
 *
 * Fixed steps are still the rule — they are just owned by the prediction layer
 * now, where the server's step rate is also known.
 */

import { MAX_FRAME_DELTA } from '../constants.ts';

export interface LoopHandle {
  stop(): void;
}

export interface FrameInfo {
  /** `performance.now()` value for this frame, in ms. */
  now: number;
  /** Seconds since the previous frame, clamped to MAX_FRAME_DELTA. */
  delta: number;
}

export type FrameUpdate = (frame: FrameInfo) => void;

export function startFrameLoop(update: FrameUpdate): LoopHandle {
  let last = performance.now();
  let frameHandle = 0;

  const frame = (now: number) => {
    frameHandle = requestAnimationFrame(frame);

    // A backgrounded tab or a long GC pause produces a huge delta. Clamping
    // keeps cosmetics from teleporting; the sim does not use this value, so
    // there is no catch-up spiral to guard against.
    const raw = (now - last) / 1000;
    // Math.min passes NaN through, and every consumer eases with this value —
    // a NaN delta would latch the camera and feel curves at NaN until reload.
    const delta = Number.isFinite(raw) ? Math.min(raw, MAX_FRAME_DELTA) : 0;
    last = now;

    update({ now, delta });
  };

  frameHandle = requestAnimationFrame(frame);

  return {
    stop: () => cancelAnimationFrame(frameHandle),
  };
}