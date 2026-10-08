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
 * Touch devices mount the same actions on a stick and two buttons (ui/touch.ts).
 * The stick reports a continuous -1..1 axis (setTouchAxis) — keys only ever
 * produce -1/0/1, and the keyboard intent is slewed a fraction per step so
 * both sides stage floats and direction changes come out smooth. JUMP and
 * DASH push the same queue/held state the keyboard pushes, so there is exactly
 * one staging path and the wire format cannot diverge between inputs.
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

/**
 * Per-fixed-step approach fraction for keyboard-axis direction changes.
 * Digital keys can only mean -1/0/1, so a turn would snap between octants;
 * slewing toward the target a fraction per step makes the staged axis a float
 * and the rotation smooth (~6 steps / ~100ms to settle). Releasing snaps to 0
 * so stopping stays crisp.
 */
const KEY_SLEW = 0.4;

const held = new Set<string>();
let jumpQueued = false;

// Analog stick axes, written only by the touch layer (ui/touch.ts): continuous
// -1..1 per axis, 0 when no thumb is engaged. Zero doubles as "no stick here",
// which lets the keyboard's value through on that axis.
let analogForward = 0;
let analogStrafe = 0;
// The slewed keyboard intent: what actually gets staged when no stick is
// engaged on an axis. See KEY_SLEW.
let smoothForward = 0;
let smoothStrafe = 0;

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

  // C flips the camera between AUTO (follow behind) and DRAG (pointer orbit).
  // A separate listener rather than a key set in onKeyDown: it toggles state
  // instead of feeding the movement axes, and leaks no repeat or modifier.
  target.addEventListener('keydown', (event) => {
    const e = event as KeyboardEvent;
    if (e.code === 'KeyC' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      toggleCameraMode();
    }
  });

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
  // Touch devices have no mouse to capture; on iOS `requestPointerLock` does
  // not exist and would throw. The touch layer (ui/touch.ts) mounts its own
  // camera input instead.
  if (isCoarsePointer()) return;
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

// --- camera mode ----------------------------------------------------------
// AUTO parks the camera behind the racer (the renderer swings it toward the
// velocity heading every frame); DRAG hands the angle to the pointer via
// `applyLookDelta`. The mode lives here rather than in the renderer because it
// GATES look input: a drag that happens in AUTO must not accumulate a hidden
// orbit to snap to on the next mode switch.
export type CameraMode = 'follow' | 'drag';
let cameraMode: CameraMode = 'follow';

/** Current camera mode — the renderer reads this every frame. */
export function getCameraMode(): CameraMode {
  return cameraMode;
}

/** Flip follow <-> drag and report the new mode, for buttons and logs. */
export function toggleCameraMode(): CameraMode {
  cameraMode = cameraMode === 'follow' ? 'drag' : 'follow';
  console.info(
    `camera: ${cameraMode === 'follow' ? 'AUTO — follows the racer' : 'DRAG — pointer orbits'}`,
  );
  return cameraMode;
}

function onPointerMove(event: Event): void {
  const e = event as MouseEvent;

  // movementX/Y are deltas from the previous event, so they stay correct at any
  // event rate. Guard on lock anyway: unlocked, these are plain client
  // coordinates and one stray move would fling the camera across the course.
  if (!locked) return;

  // The touch layer calls the same function with its own pixel deltas, so
  // both inputs are provably the same math.
  applyLookDelta(e.movementX, e.movementY);
}

function onLockChange(): void {
  locked = document.pointerLockElement !== null;
}

const clamp = (value: number, lo: number, hi: number): number =>
  value < lo ? lo : value > hi ? hi : value;

/**
 * Touch control entry points — see ui/touch.ts.
 *
 * The stick is analog: it writes continuous -1..1 axes that `stageInput`
 * prefers over the keyboard on a per-axis basis, so no key codes and no
 * wire-schema change are involved. JUMP/DASH stay boolean like the keyboard's
 * (one queued jump per press, dash held while a finger stays down). Look
 * deltas share `applyLookDelta` with the mouse, which keeps the two camera
 * inputs identical.
 */
const touchHeld = new Set<string>();

/** Add or release one touch-owned key code, only when ownership changes. */
function hold(code: string, want: boolean): void {
  if (want) {
    touchHeld.add(code);
    held.add(code);
  } else if (touchHeld.delete(code)) {
    held.delete(code);
  }
}

/**
 * The virtual stick. `forward`/`strafe` are continuous -1..1, so sweeping the
 * thumb between directions rotates the wish smoothly instead of snapping
 * between octants. An inactive axis is exactly 0, which the staging reads as
 * "no stick input" and lets the keyboard's own value through on that axis.
 */
export function setTouchAxis(forward: number, strafe: number): void {
  analogForward = forward;
  analogStrafe = strafe;
}

/** The DASH button. Held while the finger is down, like holding a Shift key. */
export function setTouchDash(active: boolean): void {
  hold('ShiftLeft', active);
}

/**
 * What the touch layer currently believes it is sending, for the `?debug`
 * readout (ui/touch.ts). `jump` is the momentary queue and is usually 0 —
 * it is consumed by the very next `stageInput`.
 */
export function touchState(): {
  forward: number;
  strafe: number;
  dash: boolean;
  jump: boolean;
} {
  return {
    forward: analogForward,
    strafe: analogStrafe,
    dash: touchHeld.has('ShiftLeft'),
    jump: jumpQueued,
  };
}

/** The JUMP button. One press queues one jump, exactly like a Space tap. */
export function queueTouchJump(): void {
  jumpQueued = true;
}

/**
 * Look deltas in pixel scale. The mouse passes `movementX`/`movementY`
 * straight through; the touch layer scales its drags by a touch factor first
 * (LOOK_SCALE in ui/touch.ts). Living here means one yaw/pitch implementation
 * for every input.
 */
export function applyLookDelta(dx: number, dy: number): void {
  // AUTO mode owns its angle; a drag would only accumulate a hidden view to
  // snap to on the next mode switch. The mouse's onPointerMove and the touch
  // layer both land here, so the gate covers camera drags from every pointer.
  if (cameraMode !== 'drag') return;
  yaw -= dx * CAMERA.yawSensitivity;
  pitch = clamp(
    pitch - dy * CAMERA.pitchSensitivity,
    CAMERA.minPitch,
    CAMERA.maxPitch,
  );
}

/**
 * Is the user's primary pointer a finger or stylus? True on phones and
 * touch-first tablets. `any-pointer` would also match a touchscreen laptop
 * whose primary pointer is a mouse — where pointer lock works and thumb
 * controls would be wrong — so coarse checks the *primary* pointer only.
 */
export function isCoarsePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

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

  // --- axis: continuous, from whichever input is live --------------------
  // The touch stick supplies continuous -1..1 and wins while it is engaged on
  // an axis; the keyboard is digital, so its intent is slewed toward the
  // target a fraction per step. Either way `forward`/`strafe` are floats and
  // the staged direction changes smoothly. Releasing a key snaps to 0 so
  // stopping is crisp, while turning leans in over a few steps.
  const keyForward = axis(FORWARD_KEYS, BACK_KEYS);
  const keyStrafe = axis(RIGHT_KEYS, LEFT_KEYS);
  if (analogForward !== 0) smoothForward = analogForward;
  else if (keyForward === 0) smoothForward = 0;
  else smoothForward += (keyForward - smoothForward) * KEY_SLEW;
  if (analogStrafe !== 0) smoothStrafe = analogStrafe;
  else if (keyStrafe === 0) smoothStrafe = 0;
  else smoothStrafe += (keyStrafe - smoothStrafe) * KEY_SLEW;

  // Keyboard intent in camera space: +Z is "away from the camera", +X is right.
  const forward = smoothForward;
  const strafe = smoothStrafe;

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
  if (analogForward !== 0 || analogStrafe !== 0) return true;
  for (const code of FORWARD_KEYS) if (held.has(code)) return true;
  for (const code of BACK_KEYS) if (held.has(code)) return true;
  for (const code of LEFT_KEYS) if (held.has(code)) return true;
  for (const code of RIGHT_KEYS) if (held.has(code)) return true;
  return false;
}

/** Drop all held keys — used when the window loses focus. */
export function clearInput(): void {
  held.clear();
  touchHeld.clear();
  jumpQueued = false;
  analogForward = 0;
  analogStrafe = 0;
  smoothForward = 0;
  smoothStrafe = 0;
}