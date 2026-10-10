/**
 * TEKK — tuning constants
 *
 * Single source of truth for movement, physics and camera feel.
 * Every value here is meant to be tuned by hand during playtesting.
 */

// ---------------------------------------------------------------- time

/** Simulation runs at a fixed rate. Never derive dt from frame time. */
export const FIXED_TIMESTEP = 1 / 60;

/** Clamp on how much wall-clock time one frame may advance the sim. */
/**
 * Max seconds a single animation frame may report.
 *
 * Caps the cosmetic delta after a backgrounded tab or a long GC pause. The
 * simulation does not read it -- `predict.tick` owns the fixed step -- so
 * there is no catch-up spiral to guard against here.
 */
export const MAX_FRAME_DELTA = 0.25;

// ---------------------------------------------------------------- world

/**
 * Heavy on purpose. Paired with a fast jump it keeps the apex where the arena
 * was laid out for (jumpSpeed^2 / 2g ~= 1.57) while halving the hang time:
 * floaty jumps read as slow, snappy ones as fast.
 */
export const GRAVITY = { x: 0, y: -40, z: 0 };

/** Contact material for course colliders. */
export const WORLD = {
  friction: 1.0,
  restitution: 0.0,
} as const;

// ---------------------------------------------------------------- player

export const PLAYER = {
  radius: 0.4,
  /** Half-height of the capsule's cylindrical section (caps excluded). */
  halfHeight: 0.5,
  /** Total standing height = halfHeight * 2 + radius * 2. */
  get height() {
    return this.halfHeight * 2 + this.radius * 2;
  },
  mass: 80,
} as const;

export const MOVE = {
  /**
   * Top running speed, units/s. One speed, no sprint: in an arena the size of
   * a Core Rush map a sprint key is noise, and Shift now belongs to the dash.
   */
  runSpeed: 13,
  /** Ground acceleration, units/s^2. Higher = snappier starts. */
  accel: 160,
  /** Ground deceleration when no input, units/s^2. */
  friction: 110,
  /** Fraction of acceleration usable while airborne. */
  airControl: 0.5,
  jumpSpeed: 11.2,
} as const;

/**
 * The dash -- the only way to steal the Core.
 *
 * Durations are in fixed TICKS, not seconds, on purpose: tick counts are
 * integers that rollback restores exactly, where accumulated float seconds
 * would drift between the client's replay and the server.
 */
export const DASH = {
  /** Horizontal speed during the dash, units/s. */
  speed: 32,
  /** Length of the dash. 9 ticks at 60 Hz is 0.15s, ~4.8 units. */
  durationTicks: 9,
  /** Ticks after a dash ENDS before the next one may start. 48 is 0.8s. */
  cooldownTicks: 48,
} as const;

/**
 * Boost pads. Touching one snaps horizontal velocity to the pad's direction at
 * `speed`, then the racer keeps that top speed (steerable) for `ticks` after
 * leaving it. Integer ticks, synced, for rollback -- see DASH.
 */
export const BOOST = {
  speed: 26,
  /** 36 ticks is 0.6s of boosted top speed after the last pad contact. */
  ticks: 36,
} as const;

/** Jump pads launch a grounded racer up at this speed: apex ~3.6 at GRAVITY -40. */
export const JUMP_PAD = {
  speed: 17,
} as const;

/** Core Rush rules. All tunable; none of these are final until playtested. */
export const CORE = {
  /** A dashing racer this close (centre to centre) to the carrier steals the Core. */
  stealRadius: 1.4,
  /** A free Core is picked up by any racer this close, no dash needed. */
  pickupRadius: 1.2,
  /** After a steal, the new carrier cannot be robbed for this long. */
  immunityMs: 1500,
  /** The carrier runs at this fraction of `MOVE.runSpeed`, and cannot dash. */
  carrierSpeedFactor: 0.9,
  /** Height of the Core above the carrier's body centre. */
  carryHeight: 1.6,
} as const;

/** Match flow: ready -> countdown -> playing -> results -> ready. */
export const MATCH = {
  countdownMs: 3_000,
  durationMs: 120_000,
  resultsMs: 10_000,
} as const;

export const PHYSICS = {
  /** Skin width of the character controller collision offset. */
  controllerOffset: 0.02,
  /** Auto-step up to this height without jumping. */
  maxStepHeight: 0.4,
  /** Snap to ground within this distance when walking downhill. */
  snapToGround: 0.4,
  /** Slopes steeper than this cannot be climbed. */
  maxSlopeClimb: Math.PI / 4,
  /** Slopes gentler than this do not cause sliding. */
  minSlopeSlide: Math.PI / 8,
} as const;

/**
 * Wall-run and wall-jump.
 *
 * One state with two verbs and a springboard out. A racer who carries speed
 * into a wall while airborne clips to the face: steer ALONG it (horizontal
 * wall-run), hold TOWARD it to run up it (vertical climb), jump to kick off
 * (wall-jump). The wall is a tool, not a road -- the budget caps every clip,
 * so the value is in chaining: run, climb, wall-jump, next wall.
 *
 * All tick counts are fixed integers, like DASH: rollback restores them
 * exactly, where accumulated float seconds would drift.
 */
export const WALL = {
  /**
   * Master switch for the full wall-run/wall-jump CLIP feature. FALSE = the
   * clip feature is SLEEPING: no attach, no riding the face, no budget, no
   * lock -- walls are plain solid obstacles again. Every constant and test
   * stays intact for the next revision; flip to true to wake it.
   */
  enabled: false,
  /**
   * Springboard bounce, independent of `enabled`: while the clip feature is
   * asleep, PRESS jump a fresh time while ALREADY airborne and inbound to a
   * wall face and the racer kicks with the wall-jump vector (UP + the held
   * direction). The horizontal kick follows the STICK: pressing INTO the wall
   * pops you forward into it; pressing AWAY (or holding nothing) bounces you
   * off it -- same height either way, only the direction changes. Holding the
   * launch jump from the ground into a face does nothing -- the bounce needs
   * its own mid-air press. No ride, no climb: one kick per press, and the wall
   * lock means one bounce per airtime -- touching the ground is the only reset.
   */
  bounce: true,
  /**
   * Minimum approach angle, degrees from the wall's SURFACE, at which the
   * springboard bounce is available: 90 = straight into the face, 30 = hitting
   * it at a 30-degree skim. A shallower approach skates past (no bounce). The
   * bounce probe's reach is derived from this (radius / sin(angle)): a
   * straight-in grab stays short, a shallow angle needs to reach further out
   * to register, so tune down for a forgiving skim-bounce. Range 5..90.
   */
  bounceMinAngleDeg: 30,
  /**
   * Minimum horizontal speed, units/s, to attach. Below run speed (13) on
   * purpose: a plain fast hop into a wall is enough; a walk is not.
   */
  minSpeedToAttach: 8,
  /** Max `|normal.y|` of a surface that counts as a wall. Vertical face = 0. */
  maxWallSlope: 0.25,
  /**
   * How far the attach/refresh probe casts, units. The capsule rides a face at
   * exactly one radius (0.4) out, so 0.55 is the face plus a hair of slack:
   * long enough to grab a racer a step short of touching, short enough that a
   * wall you aimed at the next step over never magnet-attracts from the air.
   */
  probeDist: 0.55,
  /** While clipped and steering along the face, the top speed (run is 13). */
  runSpeed: 13,//15,
  /** While clipped and holding toward the wall, the climb speed. */
  climbSpeed: 10,
  /** How fast the climb ramps in, units/s^2. */
  climbAccel: 80,
  /** The gentle slide down the face while running along it, units/s. */
  slideSpeed: 1.5,
  /** How fast the wall's slide-down ramps in, units/s^2. */
  slideAccel: 20,
  /** Total ticks a clip lasts. 30 at 60Hz is 0.5s: ~7.5 units of run or ~4.5 of climb. */
  budgetTicks: 30,
  /**
   * Ticks after a detach before a new attach may start. 12 at 60Hz is 0.2s:
   * long enough to stop same-face jump-spam (holding jump would otherwise
   * re-clip the wall it just left), short enough that a cross-alley chain --
   * always > 0.2s of airtime -- is untouched.
   */
  cooldownTicks: 12,
  /**
   * Hold the stick this far TOWARD the wall (wish . normal <= -this) and the
   * run becomes a climb.
   */
  climbThreshold: 0.5,
  /**
   * Hold the stick this far AWAY from the wall (wish . normal >= +this) and
   * the racer peels off the face.
   */
  peelThreshold: 0.4,
  /**
   * Wall-jump kick when jumping while clipped: `jumpOut` along the wall's
   * outward normal, `jumpUp` straight up. Together about one jump's apex
   * worth of height plus a clean push clear of the face.
   */
  jumpOut: 19,
  jumpUp: 19,
} as const;

// ---------------------------------------------------------------- goal

export const GOAL = {
  color: 0x2ecc71,
  emissive: 0x0d3d1c,
  frameColor: 0xf5f5f5,
  opacity: 0.28,
  frameThickness: 0.35,
  /** Pulse rate in Hz, purely cosmetic. */
  pulseHz: 0.8,
} as const;

// ---------------------------------------------------------------- camera

export const CAMERA = {
  fov: 72,
  near: 0.1,
  far: 600,

  /**
   * Orbit radius from the focus point, in world units.
   *
   * Replaces the old `distance`/`height` pair. Those described a fixed offset on
   * one axis, which cannot orbit; a radius and a pitch can.
   */
  distance: 8,
  /** Starting pitch in radians. Positive puts the camera above, looking down. */
  pitch: 0.42,
  /**
   * Pitch limits, radians.
   *
   * The lower bound is above zero on purpose: at pitch 0 the camera sits level
   * with the racer's chest and the horizon cuts the course in half. Keeping a
   * little elevation preserves the sense of where the ground is.
   */
  minPitch: 0.06,
  maxPitch: 1.3,

  /** Radians of yaw per pixel of mouse movement. */
  yawSensitivity: 0.0025,
  /** Radians of pitch per pixel. Slightly lower than yaw, which is usual. */
  pitchSensitivity: 0.0022,

  /** Look-at offset above the player's feet. */
  lookAtHeight: 1.2,

  /**
   * How fast the focus point chases the racer, per second. Higher = tighter.
   *
   * Must be applied against the real frame delta, never FIXED_TIMESTEP. This is
   * per-second smoothing, and `sync` runs once per rendered frame, so a fixed
   * constant only produces this feel at exactly 60fps -- see render/scene.ts.
   */
  smoothing: 9,

  /**
   * How fast AUTO mode swings the camera yaw/pitch toward the racer's heading,
   * per second. Same frame-delta rule as `smoothing`.
   *
   * Deliberately modest, because movement is staged against this heading
   * (main.ts): the chase turns toward the velocity, and the wish turns with
   * the camera, so the steady orbit rate from a stick offset is
   * k*a/(k+a) x offset with a ~ MOVE.accel/runSpeed ~ 12/s — effectively k
   * itself. The old 10 whirled even a near-straight nudge (~55°/s at 10°);
   * at 1.2 a full strafe arcs at ~100°/s and forward play stays straight.
   * Transients (reversals, wall-kicks) are capped by `followMaxRate`.
   */
  followSmoothing: 3,

  /**
   * Hard cap on AUTO's per-frame yaw step, radians per second.
   *
   * The ease above scales with the gap, so a big one — a reversal, or
   * pushing directly away from the camera — would take seconds to come
   * around at the low followSmoothing. The cap bounds every step: 180° in
   * ~1.2s, and nothing can whip the view faster than this.
   */
  followMaxRate: 2.6,

  /**
   * How fast DRAG mode blends the camera toward the pointer's angle, per
   * second. Below 1:1 on purpose: it keeps a mode switch or a freshly parked
   * drag from snapping the view across the course, while staying responsive
   * enough that a drag never feels laggy.
   */
  dragSmoothing: 20,

  /**
   * Seed height for the pre-first-frame camera in core/stage.ts.
   *
   * Placeholder only. The camera rig overwrites the position on its first
   * `sync`, before anything is rendered, so this value is never seen.
   */
  height: 5,
} as const;