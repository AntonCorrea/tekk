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

export const GRAVITY = { x: 0, y: -26, z: 0 };

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
  walkSpeed: 7,
  sprintSpeed: 12,
  /** Ground acceleration, units/s^2. Higher = snappier starts. */
  accel: 70,
  /** Ground deceleration when no input, units/s^2. */
  friction: 55,
  /** Fraction of acceleration usable while airborne. */
  airControl: 0.3,
  jumpSpeed: 9,
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
  fov: 70,
  near: 0.1,
  far: 600,

  /**
   * Orbit radius from the focus point, in world units.
   *
   * Replaces the old `distance`/`height` pair. Those described a fixed offset on
   * one axis, which cannot orbit; a radius and a pitch can.
   */
  distance: 10.3,
  /** Starting pitch in radians. Positive puts the camera above, looking down. */
  pitch: 0.5,
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
   * Seed height for the pre-first-frame camera in core/stage.ts.
   *
   * Placeholder only. The camera rig overwrites the position on its first
   * `sync`, before anything is rendered, so this value is never seen.
   */
  height: 5,
} as const;