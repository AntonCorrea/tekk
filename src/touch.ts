/**
 * Touch controls
 *
 * A two-thumb layout for touch-first devices. The left thumb drives a virtual
 * stick; the right thumb drags anywhere else on screen to steer the camera,
 * with JUMP and DASH buttons in the corner and a mute toggle bottom-centre.
 *
 * Nothing here reasons about the simulation. The stick reports a continuous
 * -1..1 axis (setTouchAxis), which keys never can, so direction changes
 * rotate smoothly through every angle, and JUMP/DASH push the same state the
 * keyboard pushes. Every input stages through the one path in input.ts, so
 * the prediction and the server see byte-identical intent. Camera drags go
 * through `applyLookDelta` — the mouse's own math, so the two inputs provably
 * agree.
 *
 * Two design decisions exist because of how fingers actually work:
 *
 *  1. The stick is ANCHORED: the press point becomes its centre. Reading the
 *     thumb's position against the *base* centre would treat every sloppy
 *     landing as a push — a thumb resting on the rim would walk the racer
 *     sideways before the player did anything. Only a deliberate push past
 *     the deadzone engages an axis.
 *  2. Every release goes through ONE path: a document-level pointerup /
 *     pointercancel handler that consults a `pointerId -> release` registry.
 *     Element capture is still requested so moves keep streaming to the
 *     control, but no control relies on capture working for its release —
 *     Safari has a habit of dropping it, and a missed release would leave a
 *     key held forever (worst symptom: an unstoppable dash). If capture
 *     fails, the end event reaches the document instead and the registry
 *     still fires the right release.
 *
 * `blur` / `visibilitychange` flush the whole registry and reset the visuals,
 * mirroring main.ts's `clearInput` on blur for the keyboard. Append `?debug`
 * to the URL for a live readout of the stick axis, dash, jump and the active
 * pointer ids, which shows instantly when an input is misbehaving.
 *
 * This module only mounts when the primary pointer is coarse — `pointer:
 * coarse` (see `isCoarsePointer` in input.ts), so desktop sessions never see
 * it and a touchscreen laptop whose primary pointer is a mouse does not get
 * thumb controls over its viewport.
 */

import {
  applyLookDelta,
  isCoarsePointer,
  queueTouchJump,
  setTouchAxis,
  setTouchDash,
  touchState,
} from './input.ts';

export interface TouchControlsOptions {
  /**
   * Toggle the techno track and report the new state, so the button can label
   * itself. Mobiles have no M key.
   */
  onToggleMute: () => boolean;
}

// 1:1 with the mouse. Fingers cover a small screen quickly, so starting at
// parity and tuning up beats starting hot; one number, playtest it.
const LOOK_SCALE = 1.0;
// A resting thumb jitters by a few pixels; below this, drag deltas are
// accumulated but never applied. Slow, deliberate drags still steer — the
// deltas pile up until they cross the line and apply together.
const LOOK_DEAD = 2;

// Stick geometry in CSS pixels. Every target comfortably clears the 44px
// touch minimum: the stick base is 132px wide, JUMP 84, DASH 68.
const STICK_BASE = 132;
const KNOB_SIZE = 52;
/** Half the base: stick deflection is measured from the press anchor. */
const STICK_RADIUS = STICK_BASE / 2;
const KNOB_RADIUS = KNOB_SIZE / 2;
/** How far the knob may travel before it stops and the axis saturates. */
const KNOB_TRAVEL = STICK_RADIUS - KNOB_RADIUS;
/**
 * Engagement is a ring, not a line: pushing PAST DEADZONE_ENGAGE turns the
 * axis on, and it stays on until the thumb returns INSIDE DEADZONE_RELEASE.
 * A single static threshold re-engages every time resting jitter crosses it,
 * which reads as a twitching stick.
 *
 * Direction is a PURE function of the thumb's current position (see drive):
 * no sign latch, no locked direction, no state that could go stale. Straighten
 * a diagonal push and the output straightens with you, immediately. The only
 * guard against jitter strobing a cardinal is AXIS_DEAD, a per-axis deadband
 * around each centre line.
 */
const DEADZONE_ENGAGE = 0.35 * STICK_RADIUS;
const DEADZONE_RELEASE = 0.15 * STICK_RADIUS;
/**
 * Per-axis half-deadband in CSS pixels: an axis leaves 0 only when the thumb
 * has moved past its centre line by more than AXIS_DEAD. Wide enough that
 * resting jitter is ignored, small enough that a course correction is a flick.
 */
const AXIS_DEAD = 8;
/**
 * Float axis for a displacement from the press anchor: 0 inside AXIS_DEAD,
 * ramping to ±1 at KNOB_TRAVEL. The sim normalises the wish direction, so a
 * short push and a full push are the same speed — but the ANGLE is continuous,
 * and that continuity is what makes rotation smooth.
 */
const axisValue = (offset: number): number => {
  if (offset > AXIS_DEAD) return Math.min(1, (offset - AXIS_DEAD) / (KNOB_TRAVEL - AXIS_DEAD));
  if (offset < -AXIS_DEAD) return Math.max(-1, (offset + AXIS_DEAD) / (KNOB_TRAVEL - AXIS_DEAD));
  return 0;
};
/**
 * Bump this on every behavioural change to the touch layer. The ?debug readout
 * prints it up front (`v<REV>`), so a phone report can be checked against the
 * code it actually ran — HMR silently keeps running the previous closures.
 */
const REV = 6;

export function initTouchControls(
  container: HTMLElement,
  options: TouchControlsOptions,
): void {
  // The primary pointer is what the user is actually holding. `any-pointer`
  // would also match a touchscreen laptop whose primary pointer is a mouse,
  // where pointer lock works and thumb controls would be wrong.
  if (!isCoarsePointer()) return;
  // Idempotent against a hot-reload double-mount.
  if (container.querySelector('.touch')) return;

  const root = document.createElement('div');
  root.className = 'touch';

  // ------------------------------------------------------------------ net
  // The single release path. A control registers itself for a pointerId when
  // it engages a finger; `release` fires that registration exactly once. The
  // document-level listeners below are the ONLY place endings are handled, so
  // capture success or failure cannot change the outcome.
  const owners = new Map<number, () => void>();

  const release = (pointerId: number): void => {
    const end = owners.get(pointerId);
    if (!end) return;
    owners.delete(pointerId);
    end();
  };

  document.addEventListener('pointerup', (event) => release(event.pointerId));
  document.addEventListener('pointercancel', (event) => release(event.pointerId));
  // Capture forcibly released (element replaced, browser grabs the gesture
  // back): treat it as "the finger is gone".
  document.addEventListener('lostpointercapture', (event) => release(event.pointerId));

  // Lifetime event totals, for the ?debug readout. If these climb while no
  // hand is on the phone, the screen itself is synthesising events (ghost
  // touches) — that rewrites the whole diagnosis.
  const counters = { down: 0, up: 0, cancel: 0 };
  document.addEventListener('pointerdown', () => counters.down++);
  document.addEventListener('pointerup', () => counters.up++);
  document.addEventListener('pointercancel', () => counters.cancel++);

  // --- camera drag -------------------------------------------------------
  // Anywhere that is not a control island: a one-finger drag turns the camera,
  // in the same pixel deltas the mouse's movementX/Y produce (scaled by
  // LOOK_SCALE, since fingers cannot travel as far as a mouse arm).
  const look = document.createElement('div');
  look.className = 'touch-look';

  let lookId: number | null = null;
  let lastX = 0;
  let lastY = 0;
  // Accumulated-but-unapplied deltas, for the LOOK_DEAD jitter filter.
  let pendingX = 0;
  let pendingY = 0;

  look.addEventListener('pointerdown', (event) => {
    // One finger steers. A second finger landing on the zone is ignored rather
    // than averaged, so an accidental second thumb cannot fight the first.
    if (owners.has(event.pointerId) || lookId !== null) return;
    lookId = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    pendingX = 0;
    pendingY = 0;
    owners.set(event.pointerId, () => {
      lookId = null;
      pendingX = 0;
      pendingY = 0;
    });
    look.setPointerCapture(event.pointerId);
  });

  look.addEventListener('pointermove', (event) => {
    if (event.pointerId !== lookId) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;

    // A resting thumb jitters; apply deltas only once a real motion has
    // accumulated past the dead line, per axis, so a slow deliberate drag
    // still steers and a resting thumb does not.
    pendingX += dx;
    pendingY += dy;
    if (Math.abs(pendingX) < LOOK_DEAD && Math.abs(pendingY) < LOOK_DEAD) return;
    applyLookDelta(
      (Math.abs(pendingX) >= LOOK_DEAD ? pendingX : 0) * LOOK_SCALE,
      (Math.abs(pendingY) >= LOOK_DEAD ? pendingY : 0) * LOOK_SCALE,
    );
    if (Math.abs(pendingX) >= LOOK_DEAD) pendingX = 0;
    if (Math.abs(pendingY) >= LOOK_DEAD) pendingY = 0;
  });

  // --- stick --------------------------------------------------------------
  const stick = document.createElement('div');
  stick.className = 'touch-stick';
  const knob = document.createElement('div');
  knob.className = 'touch-knob';
  stick.appendChild(knob);

  let stickId: number | null = null;
  // The press point is the stick's centre for this gesture (see the module
  // comment: placement is not intent).
  let anchorX = 0;
  let anchorY = 0;
  // Ring state for this gesture (DEADZONE_ENGAGE/RELEASE). The direction has
  // no state of its own: it is recomputed from where the thumb is, every move.
  let engaged = false;
  // Last raw deflection relative to the anchor, for the ?debug readout.
  const stickDebug = { dx: 0, dy: 0, dist: 0 };

  /**
   * Turn a thumb position relative to the press anchor into the clamped knob
   * offset and the continuous -1..1 axes — pure functions of that position.
   * The knob is clamped to its travel; the axis logic uses the true distance.
   */
  const drive = (clientX: number, clientY: number): void => {
    const dx = clientX - anchorX;
    const dy = clientY - anchorY;
    const raw = Math.hypot(dx, dy);
    const scale = Math.min(1, KNOB_TRAVEL / Math.max(raw, 1e-4));
    knob.style.transform = `translate(${dx * scale}px, ${dy * scale}px)`;

    // Ring hysteresis: past ENGAGE turns the axis on, back inside RELEASE
    // turns it off; between the two rings nothing changes state.
    if (engaged ? raw > DEADZONE_RELEASE : raw > DEADZONE_ENGAGE) {
      engaged = true;
      // Continuous axis, pure function of the thumb's position: 0 inside the
      // per-axis deadband, ramping to ±1 at full travel. Direction changes
      // sweep through every angle, so steering is smooth, and nothing latches.
      setTouchAxis(
        -axisValue(dy), // up is forward
        axisValue(dx), // right is strafe
      );
    } else {
      engaged = false;
      setTouchAxis(0, 0);
    }

    stickDebug.dx = dx;
    stickDebug.dy = dy;
    stickDebug.dist = raw;
  };

  const endStick = (): void => {
    if (stickId === null) return;
    stickId = null;
    engaged = false;
    knob.style.transform = '';
    setTouchAxis(0, 0);
  };

  stick.addEventListener('pointerdown', (event) => {
    if (owners.has(event.pointerId) || stickId !== null) return;
    stickId = event.pointerId;
    anchorX = event.clientX;
    anchorY = event.clientY;
    engaged = false;
    // The knob starts centred and the axis starts zeroed; only a push past
    // DEADZONE_ENGAGE (a pointermove, below) engages movement.
    knob.style.transform = '';
    setTouchAxis(0, 0);
    owners.set(event.pointerId, endStick);
    stick.setPointerCapture(event.pointerId);
  });

  stick.addEventListener('pointermove', (event) => {
    if (event.pointerId !== stickId) return;
    drive(event.clientX, event.clientY);
  });

  // --- JUMP / DASH --------------------------------------------------------
  const buttons = document.createElement('div');
  buttons.className = 'touch-buttons';

  /**
   * JUMP queues a single jump per press (like a Space tap); DASH is a held
   * state (like holding Shift) while any finger keeps pressing it. Multi-finger
   * safety: the hold ends only when the last finger lifts, so a second thumb
   * arriving just as the first lifts cannot slam the dash off mid-tap.
   */
  const addButton = (
    label: string,
    kind: 'jump' | 'dash',
    onPress: () => void,
    onRelease: () => void,
  ): void => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `touch-btn touch-btn--${kind}`;
    btn.textContent = label;

    btn.addEventListener('pointerdown', (event) => {
      if (owners.has(event.pointerId)) return;
      btn.classList.add('is-pressed');
      onPress();
      owners.set(event.pointerId, () => {
        btn.classList.remove('is-pressed');
        onRelease();
      });
      btn.setPointerCapture(event.pointerId);
    });
    // A long-press otherwise summons Android's context menu or iOS's callout
    // magnifier over the button.
    btn.addEventListener('contextmenu', (event) => event.preventDefault());
    buttons.appendChild(btn);
  };

  let dashFingers = 0;
  addButton('JUMP', 'jump', () => queueTouchJump(), () => {});
  addButton('DASH', 'dash', () => {
    dashFingers++;
    setTouchDash(true);
  }, () => {
    dashFingers = Math.max(0, dashFingers - 1);
    setTouchDash(dashFingers > 0);
  });

  // --- mute ---------------------------------------------------------------
  const mute = document.createElement('button');
  mute.type = 'button';
  mute.className = 'touch-mute';
  mute.textContent = 'SOUND';
  mute.addEventListener('click', () => {
    const muted = options.onToggleMute();
    mute.classList.toggle('is-muted', muted);
    mute.textContent = muted ? 'MUTED' : 'SOUND';
  });

  // A long-press on empty sky is the same context-menu / magnifier problem
  // as on the buttons.
  root.addEventListener('contextmenu', (event) => event.preventDefault());

  // --- reset on focus loss -------------------------------------------------
  // A blur with the thumb still down (pocket, notification shade, tab switch)
  // must not leave the racer committed to a direction. Flushing the registry
  // releases every finger registered so far — every stuck-key failure mode
  // ends here, the same guarantees as the keyboard's clearInput on blur plus
  // the DOM visuals.
  const flushAll = (): void => {
    for (const [, end] of owners) end();
    owners.clear();
    lookId = null;
    stickId = null;
    knob.style.transform = '';
    setTouchAxis(0, 0);
    setTouchDash(false);
    for (const el of buttons.querySelectorAll<HTMLElement>('.is-pressed')) {
      el.classList.remove('is-pressed');
    }
  };
  globalThis.addEventListener('blur', flushAll);
  document.addEventListener('visibilitychange', flushAll);

  // --- ?debug readout -------------------------------------------------------
  // Live view of exactly what the touch layer thinks it is sending. If the
  // racer misbehaves, this shows whether the stick axis/dash are stale —
  // without it, stuck input is indistinguishable from a simulation bug.
  //
  // The REV token proves which code the phone is running: a full reload is
  // required after an edit — HMR re-runs initTouchControls but the guard below
  // early-returns on the existing `.touch` node, so an un-reloaded page keeps
  // the PREVIOUS closures, forever. An old REV in the readout means the phone
  // never reloaded and the report describes dead code.
  //
  // Tap the readout to freeze it (◼) so a flickering line can be read or
  // screenshotted; tap again to resume.
  const debug = new URLSearchParams(location.search).has('debug');
  let debugLine: HTMLElement | null = null;
  if (debug) {
    debugLine = document.createElement('div');
    debugLine.className = 'touch-debug';
    root.appendChild(debugLine);
    let frozen = false;
    debugLine.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      frozen = !frozen;
      if (!frozen) renderDebug();
    });
    const renderDebug = (): void => {
      if (!debugLine) return;
      const state = touchState();
      const fingers = [...owners.keys()].join(',');
      debugLine.textContent =
        `v${REV} f${state.forward.toFixed(1)} s${state.strafe.toFixed(1)} d${state.dash ? 1 : 0} j${state.jump ? 1 : 0}` +
        ` | e${engaged ? 1 : 0} raw(${stickDebug.dx.toFixed(0)},${stickDebug.dy.toFixed(0)}) ${stickDebug.dist.toFixed(0)}px` +
        `\nev d${counters.down} u${counters.up} c${counters.cancel}` +
        ` | stick:${stickId ?? '-'} look:${lookId ?? '-'}` +
        ` | f:${fingers || '-'}` +
        (frozen ? ' ◼' : '');
      if (frozen) return; // hold this frame; a tap resumes the loop
      requestAnimationFrame(renderDebug);
    };
    requestAnimationFrame(renderDebug);
  }

  root.append(look, stick, buttons, mute);
  container.appendChild(root);
}