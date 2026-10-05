/**
 * Keyboard input
 *
 * Polled state, not event-driven. The fixed-timestep loop stages this into the
 * network input schema once per step, which keeps what the server simulates and
 * what the client predicts byte-identical.
 *
 * `jump` is level-triggered here and stays level-triggered on the wire. A
 * queued keypress consumed by one step would be lost every time rollback
 * replayed past it — see shared/input.ts.
 */

import type { MoveInputData } from './shared/input.ts';

const FORWARD_KEYS = new Set(['KeyW', 'ArrowUp']);
const BACK_KEYS = new Set(['KeyS', 'ArrowDown']);
const LEFT_KEYS = new Set(['KeyA', 'ArrowLeft']);
const RIGHT_KEYS = new Set(['KeyD', 'ArrowRight']);
const SPRINT_KEYS = new Set(['ShiftLeft', 'ShiftRight']);
const JUMP_KEYS = new Set(['Space']);

const held = new Set<string>();
let jumpQueued = false;

// Typed as Event so these can be registered on a generic EventTarget
// without a cast at the call site.
function onKeyDown(event: Event): void {
  const e = event as KeyboardEvent;

  // Don't swallow browser shortcuts or scrolling.
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (JUMP_KEYS.has(e.code)) e.preventDefault();

  // Auto-repeat would re-trigger jump while held.
  if (!e.repeat && JUMP_KEYS.has(e.code)) jumpQueued = true;

  held.add(e.code);
}

function onKeyUp(event: Event): void {
  held.delete((event as KeyboardEvent).code);
}

/** Call once at startup. */
export function initInput(target: EventTarget = window): void {
  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
}

export function disposeInput(target: EventTarget = window): void {
  target.removeEventListener('keydown', onKeyDown);
  target.removeEventListener('keyup', onKeyUp);
}

/**
 * Stage the current keyboard state into a network input, in place.
 *
 * Writes into the schema rather than returning a fresh object because the value
 * that gets transmitted has to be the one the reconciler buffers for replay.
 * A returned copy would be a different object from the one on the wire.
 *
 * Call at most once per fixed step, before `send()`.
 */
export function stageInput(target: MoveInputData): MoveInputData {
  const axis = (positive: Set<string>, negative: Set<string>) => {
    let value = 0;
    for (const code of positive) if (held.has(code)) value += 1;
    for (const code of negative) if (held.has(code)) value -= 1;
    return Math.max(-1, Math.min(1, value));
  };

  // Forward is -Z, matching the shared simulation's world axes.
  target.moveZ = axis(FORWARD_KEYS, BACK_KEYS);
  target.moveX = axis(RIGHT_KEYS, LEFT_KEYS);
  target.sprint = [...SPRINT_KEYS].some((code) => held.has(code));
  target.jump = jumpQueued;

  jumpQueued = false;
  return target;
}

/**
 * Is the player asking to move at all?
 *
 * Used only for local feedback (the "ready" prompt). The server decides when
 * the race actually starts, from the inputs it receives.
 */
export function hasMovementIntent(): boolean {
  for (const code of FORWARD_KEYS) if (held.has(code)) return true;
  for (const code of BACK_KEYS) if (held.has(code)) return true;
  for (const code of LEFT_KEYS) if (held.has(code)) return true;
  for (const code of RIGHT_KEYS) if (held.has(code)) return true;
  return false;
}

/** Drop all held keys — used when the window loses focus. */
export function clearInput(): void {
  held.clear();
  jumpQueued = false;
}