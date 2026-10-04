/**
 * Fixed-timestep loop
 *
 * The simulation always advances in exact FIXED_TIMESTEP increments, no
 * matter what the display refresh rate is. Rendering happens once per
 * animation frame with whatever wall-clock time is left over.
 *
 * This is not optional. Variable-dt physics plus network prediction
 * produces desyncs that look exactly like collision bugs.
 */

import { FIXED_TIMESTEP, MAX_FRAME_DELTA, MAX_STEPS_PER_FRAME } from '../constants.ts';

export interface LoopHandle {
  stop(): void;
}

export type FixedUpdate = (dt: number) => void;

export function startLoop(update: FixedUpdate, render: () => void): LoopHandle {
  let last = performance.now();
  let accumulator = 0;
  let frameHandle = 0;

  const frame = (now: number) => {
    frameHandle = requestAnimationFrame(frame);

    const frameDelta = Math.min((now - last) / 1000, MAX_FRAME_DELTA);
    last = now;
    accumulator += frameDelta;

    let steps = 0;
    while (accumulator >= FIXED_TIMESTEP && steps < MAX_STEPS_PER_FRAME) {
      update(FIXED_TIMESTEP);
      accumulator -= FIXED_TIMESTEP;
      steps++;
    }

    // Fell too far behind (tab was backgrounded, long GC pause). Drop the
    // backlog rather than spiralling into an ever-growing catch-up loop.
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;

    render();
  };

  frameHandle = requestAnimationFrame(frame);

  return {
    stop: () => cancelAnimationFrame(frameHandle),
  };
}