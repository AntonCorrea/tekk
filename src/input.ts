/**
 * Keyboard input
 *
 * Polled state, not event-driven. The fixed-timestep loop reads this once
 * per step, which keeps simulation input deterministic and replayable.
 */

export interface InputState {
  /** -1 (back) .. 1 (forward) on the Z axis. */
  forward: number;
  /** -1 (left) .. 1 (right) on the X axis. */
  strafe: number;
  sprint: boolean;
  /** True only on the step where jump was pressed. */
  jumpPressed: boolean;
}

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
 * Snapshot the current input. Call exactly once per fixed step, before
 * reading, so `jumpPressed` is consumed by a single step.
 */
export function readInput(): InputState {
  const axis = (positive: Set<string>, negative: Set<string>) => {
    let value = 0;
    for (const code of positive) if (held.has(code)) value += 1;
    for (const code of negative) if (held.has(code)) value -= 1;
    return Math.max(-1, Math.min(1, value));
  };

  const state: InputState = {
    forward: axis(FORWARD_KEYS, BACK_KEYS),
    strafe: axis(RIGHT_KEYS, LEFT_KEYS),
    sprint: [...SPRINT_KEYS].some((code) => held.has(code)),
    jumpPressed: jumpQueued,
  };

  jumpQueued = false;
  return state;
}

/** Drop all held keys — used when the window loses focus. */
export function clearInput(): void {
  held.clear();
  jumpQueued = false;
}