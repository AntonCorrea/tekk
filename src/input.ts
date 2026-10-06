/**
 * Keyboard input
 *
 * Polled state, not event-driven. The fixed-timestep loop stages this into the
 * network input schema once per step, which keeps what the server simulates and
 * what the client predicts byte-identical.
 *
 * Controls: WASD / arrows move, Space jumps, Shift (either) dashes. There is
 * no sprint -- Shift belongs to the dash now.
 *
 * `jump` is level-triggered here and stays level-triggered on the wire. A
 * queued keypress consumed by one step would be lost every time rollback
 * replayed past it — see shared/input.ts.
 *
 * `dash` is plain held state, not even queued like jump: holding Shift dashes
 * again the moment the cooldown allows, and the cooldown (simulated, so both
 * sides agree on it) is the only rate limit. A tap shorter than one fixed step
 * can be missed; at 60 Hz that is a 16ms tap, which no hand produces.
 */

import { CAMERA } from './constants.ts';
import type { MoveInputData } from './shared/input.ts';

const FORWARD_KEYS = new Set(['KeyW', 'ArrowUp']);
const BACK_KEYS = new Set(['KeyS', 'ArrowDown']);
const LEFT_KEYS = new Set(['KeyA', 'ArrowLeft']);
const RIGHT_KEYS = new Set(['KeyD', 'ArrowRight']);
const DASH_KEYS = new Set(['ShiftLeft', 'ShiftRight']);
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

/**
 * Call once at startup.
 *
 * `viewport` is the element to lock the pointer to on click -- the renderer
 * canvas. Clicking anywhere else on the page still leaves the keyboard working,
 * but the camera only turns while the pointer is captured.
 */
export function initInput(target: EventTarget = window, viewport?: HTMLElement): void {
  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);

  // `mousemove` on the document, not the canvas: under pointer lock the cursor
  // stops producing element-targeted events the way it normally would, and
  // movement is reported against the locked element's document.
  document.addEventListener('mousemove', onPointerMove);
  document.addEventListener('pointerlockchange', onLockChange);

  if (viewport) {
    viewport.addEventListener('click', onViewportClick);
    viewport.addEventListener('contextmenu', onContextMenu);
  }
}

export function disposeInput(target: EventTarget = window, viewport?: HTMLElement): void {
  target.removeEventListener('keydown', onKeyDown);
  target.removeEventListener('keyup', onKeyUp);
  document.removeEventListener('mousemove', onPointerMove);
  document.removeEventListener('pointerlockchange', onLockChange);
  if (viewport) {
    viewport.removeEventListener('click', onViewportClick);
    viewport.removeEventListener('contextmenu', onContextMenu);
  }

  // Releasing the lock rather than leaving it held: a stray `locked` flag would
  // keep the camera responding to a cursor the player can no longer see.
  if (document.pointerLockElement) document.exitPointerLock();
}

function onViewportClick(event: Event): void {
  // Ignore the click that is itself unlocking, or capture would immediately
  // re-engage and the player could never let go.
  if (document.pointerLockElement) return;
  (event.currentTarget as HTMLElement).requestPointerLock();
}

/**
 * Suppress the browser's context menu on the viewport.
 *
 * Right-clicking a WebGL canvas otherwise offers "Save image as", which is
 * useless mid-race -- the canvas is a frame, not the thing you want. Pointer
 * lock is unaffected; this only kills the menu.
 */
function onContextMenu(event: Event): void {
  event.preventDefault();
}

/**
 * Look angles, in radians. Yaw 0 faces -Z, the course start direction.
 *
 * Held here rather than in the renderer because both the camera and the movement
 * mapping need them, and they must agree: if they read different values, the
 * racer walks off at an angle to the way the view is pointing.
 *
 * Yaw is unwrapped and grows without bound. Sin/cos tolerate that, and keeping
 * it continuous avoids a discontinuity when the camera crosses the +/-PI seam.
 */
let yaw = 0;
// Annotated: CAMERA is `as const`, so without this the local narrows to the
// literal type 0.5 and every reassignment fails.
let pitch: number = CAMERA.pitch;
let locked = false;

function onPointerMove(event: Event): void {
  const e = event as MouseEvent;

  // movementX/Y are deltas from the previous event, so they stay correct at any
  // event rate. Guard on lock anyway: unlocked, these are plain client
  // coordinates and one stray move would fling the camera across the course.
  if (!locked) return;

  yaw -= e.movementX * CAMERA.yawSensitivity;
  pitch = clamp(
    pitch - e.movementY * CAMERA.pitchSensitivity,
    CAMERA.minPitch,
    CAMERA.maxPitch,
  );
}

function onLockChange(): void {
  locked = document.pointerLockElement !== null;
}

const clamp = (value: number, lo: number, hi: number): number =>
  value < lo ? lo : value > hi ? hi : value;

/** Current look angles, for the renderer. */
export function lookAngles(): { yaw: number; pitch: number } {
  return { yaw, pitch };
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
export function stageInput(target: MoveInputData, yaw = 0): MoveInputData {
  const axis = (positive: Set<string>, negative: Set<string>) => {
    let value = 0;
    for (const code of positive) if (held.has(code)) value += 1;
    for (const code of negative) if (held.has(code)) value -= 1;
    return Math.max(-1, Math.min(1, value));
  };

  // Keyboard intent in camera space: +Z is "away from the camera", +X is right.
  const forward = axis(FORWARD_KEYS, BACK_KEYS);
  const strafe = axis(RIGHT_KEYS, LEFT_KEYS);

  // Rotate into world space so W always means "the way I'm looking".
  //
  // At yaw 0 the camera sits on +Z looking toward -Z (see `orbitOffset`), so
  // "away from the camera" is -Z. W therefore has to produce a NEGATIVE moveZ.
  // Getting this sign wrong is invisible in code review and obvious in play: W
  // walks you backwards, toward the camera.
  //
  //   forward at yaw 0 is (0, -1); rotating it by yaw gives
  //     (-sin(yaw), -cos(yaw))
  //   right at yaw 0 is (+1, 0); rotating it by yaw gives
  //     ( cos(yaw), -sin(yaw))
  //
  // Yaw never leaves the client. The server still simulates world-axis input,
  // which is why applyInput needs no change and the determinism contract holds:
  // two clients looking different directions send different vectors, and both
  // are exactly what that client predicted.
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  let moveX = strafe * cos - forward * sin;
  let moveZ = -strafe * sin - forward * cos;

  // A held diagonal has length sqrt(2), and once rotated a single component can
  // exceed 1 (yaw 0.3 gives moveZ -1.25). The server's `sanitize` clamps each
  // axis to [-1, 1], so an unclamped vector here is a direction the server never
  // simulates -- a correction on every tick. Scaling to unit length keeps both
  // components inside the range and the direction unchanged.
  const length = Math.hypot(moveX, moveZ);
  if (length > 1) {
    moveX /= length;
    moveZ /= length;
  }
  target.moveX = moveX;
  target.moveZ = moveZ;

  target.dash = [...DASH_KEYS].some((code) => held.has(code));
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