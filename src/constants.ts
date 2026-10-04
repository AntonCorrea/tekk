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
export const MAX_FRAME_DELTA = 0.25;

/** Max physics steps per frame before we give up catching up. */
export const MAX_STEPS_PER_FRAME = 5;

// ---------------------------------------------------------------- world

export const GRAVITY = { x: 0, y: -26, z: 0 };

export const WORLD = {
  /** Half-extent of the ground plane on X and Z. */
  groundHalf: 120,
  /** Full thickness of the ground slab. */
  groundThickness: 2,
  /** Top face of the ground slab sits at y = 0. */
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
  spawn: { x: 0, y: 1, z: 6 },
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
  distance: 9,
  height: 5,
  /** Look-at offset above the player's feet. */
  lookAtHeight: 1.2,
  /** Exponential smoothing factor per second. Higher = tighter follow. */
  smoothing: 9,
} as const;