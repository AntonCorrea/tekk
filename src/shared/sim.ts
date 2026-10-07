/**
 * Deterministic simulation core
 *
 * This module is the contract between client and server. Both import these
 * exact functions and run them with the same dt, which is what makes rollback
 * prediction reproduce the server instead of rubber-banding.
 *
 * Rules for anything added here:
 *   - No Three.js, no DOM, no timers, no randomness that isn't seeded.
 *   - No `Date.now()` / `performance.now()`. Time arrives as `dt`.
 *   - `applyInput` must not call `world.step()`. The caller decides when the
 *     world advances: the server steps once per tick after every player has
 *     been integrated, the client steps once per predicted input.
 *
 * Breaking any of those breaks prediction, and the symptom is a player who
 * jitters constantly rather than an error message. That is why it is worth
 * being strict here.
 */

import type {
  World,
  RigidBody,
  Collider,
  KinematicCharacterController,
} from '@dimforge/rapier3d-compat';
import { ColliderDesc, Cuboid, RigidBodyDesc } from '@dimforge/rapier3d-compat';
import { BOOST, CORE, DASH, GRAVITY, JUMP_PAD, MOVE, PHYSICS, PLAYER, WORLD } from '../constants.ts';
import type { Course, PadKind, Vec3 } from './course.ts';
import type { MoveInputData } from './input.ts';

/**
 * Collision groups.
 *
 * Racers pass THROUGH each other, and that has to be a property of the shared
 * step rather than a server-side nicety. The server holds every racer's capsule
 * in one world; the client holds only its own. If the server's controller let
 * one capsule block another, the client could never predict the shove -- it
 * has no capsule to collide with -- and every brush past a rival would land as
 * a correction. So a racer's controller sees course geometry and nothing else,
 * which makes a body's trajectory identical whether it is alone or in a crowd.
 *
 * Rapier packs membership into the high 16 bits and the filter mask into the
 * low 16; two colliders interact only if each one's membership is in the
 * other's mask.
 */
const GROUP_COURSE = 0x0001;
const GROUP_RACER = 0x0002;
const groups = (membership: number, filter: number): number => (membership << 16) | filter;

/** Course solids: members of COURSE, willing to touch anything. */
const COURSE_GROUPS = groups(GROUP_COURSE, 0xffff);
/** Racer capsules: members of RACER, touching only COURSE -- never each other. */
const RACER_GROUPS = groups(GROUP_RACER, GROUP_COURSE);

/**
 * Below this horizontal speed, units/s, a dash with no stick input has no
 * direction to borrow from momentum and does not fire. Small enough that any
 * deliberate drift counts; large enough that friction's last crawl to zero
 * cannot aim a 22 u/s dash at an arbitrary angle.
 */
const DASH_MIN_MOMENTUM = 0.5;

/** Object-shaped 3-vector — the shape Rapier uses. */
export interface Vec3Obj {
  x: number;
  y: number;
  z: number;
}

/**
 * One simulated character.
 *
 * Velocity lives here rather than in Rapier because a kinematic body has no
 * velocity of its own — it is driven, and the drive has to be remembered so
 * rollback can reproduce it.
 */
export interface SimBody {
  readonly body: RigidBody;
  readonly collider: Collider;
  readonly controller: KinematicCharacterController;
  readonly velocity: Vec3Obj;
  /** True when the controller found ground under the capsule this step. */
  grounded: boolean;
  /** Magnitude of horizontal velocity, for HUD and effects. */
  horizontalSpeed: number;
  /** Feet position this body returns to when it falls out of the world. */
  readonly respawn: Vec3Obj;
  /** Body-centre Y below which the body has fallen out of the world. */
  readonly killY: number;
  /** True only on the step this body was returned to its spawn point. */
  justRespawned: boolean;
  /**
   * Fixed ticks of dash remaining; greater than zero means dashing now.
   *
   * Integer ticks, never seconds: rollback restores these from PlayerState and
   * a counter restores exactly where an accumulated float would drift. There is
   * no stored dash DIRECTION -- during a dash the horizontal velocity IS the
   * direction scaled to `DASH.speed`, and velocity is already part of truth.
   */
  dashTicks: number;
  /** Fixed ticks until the next dash may start. Counts only while not dashing. */
  dashCooldownTicks: number;
  /**
   * Holding the Core: slower, and cannot start a dash. Written from OUTSIDE --
   * the server room on a pickup or steal, `adoptTruth` on the client -- and
   * only ever read by the step.
   */
  carrying: boolean;
  /**
   * True if this body flew a dash step during the most recent `applyInput`.
   *
   * Output only -- the step never reads it, so it cannot change a trajectory.
   * It exists for the server's steal rule: `dashTicks` already reads 0 after
   * the LAST dash step, so "dashTicks > 0 after the step" would miss the final
   * tick of every dash, the one most likely to land on the carrier.
   */
  dashedThisStep: boolean;
  /**
   * Fixed ticks of boosted top speed left after touching a boost pad. Synced
   * and restored like the dash counters.
   */
  boostTicks: number;
  /** The course's pads, pre-resolved to world AABBs once at creation. */
  readonly pads: readonly SimPad[];
}

/** A pad as the step uses it: a world-space box plus its effect. */
export interface SimPad {
  readonly kind: PadKind;
  readonly min: Vec3Obj;
  readonly max: Vec3Obj;
  /** Boost direction, unit length; zero for jump pads. */
  readonly dirX: number;
  readonly dirZ: number;
}

/**
 * Create a character capsule.
 *
 * Both sides call this with the same course and `stepSeconds` so the capsule is
 * bit-identical, and so both resolve a fall to the same place.
 *
 * `stepSeconds` is the engine timestep — it MUST equal the `dt` later passed to
 * `applyInput`, because a kinematic body only lands where its next translation
 * says, and Rapier integrates internal state per step.
 */
export function createSimBody(world: World, course: Course, stepSeconds: number): SimBody {
  const spawn = course.spawn;

  // Lift the capsule clear of the surface so the first step resolves a clean
  // landing instead of starting interpenetrated.
  const feetOffset = PLAYER.halfHeight + PLAYER.radius;

  const body = world.createRigidBody(
    RigidBodyDesc.kinematicPositionBased().setTranslation(
      spawn[0],
      feetOffset + spawn[1],
      spawn[2],
    ),
  );

  // Friction 0: friction on a kinematic capsule does nothing useful against a
  // static world and only muddies the character controller's own handling.
  const collider = world.createCollider(
    ColliderDesc.capsule(PLAYER.halfHeight, PLAYER.radius)
      .setFriction(0)
      .setCollisionGroups(RACER_GROUPS),
    body,
  );

  const controller = world.createCharacterController(PHYSICS.controllerOffset);
  controller.enableAutostep(PHYSICS.maxStepHeight, PLAYER.radius * 0.9, true);
  controller.enableSnapToGround(PHYSICS.snapToGround);
  controller.setMaxSlopeClimbAngle(PHYSICS.maxSlopeClimb);
  controller.setMinSlopeSlideAngle(PHYSICS.minSlopeSlide);
  controller.setApplyImpulsesToDynamicBodies(true);
  controller.setCharacterMass(PLAYER.mass);

  // Rapier needs the timestep on the world, not the controller. Set it here so
  // a caller cannot forget it and silently desync replay.
  world.timestep = stepSeconds;

  // Resolved once, here, rather than on every fall. The query walks the whole
  // collider set, and doing it per respawn would put an O(colliders) scan in the
  // middle of the fixed step — on both sides, in lockstep.
  const feet = respawnFeet(world, course);

  return {
    body,
    collider,
    controller,
    velocity: { x: 0, y: 0, z: 0 },
    grounded: false,
    horizontalSpeed: 0,
    respawn: { x: feet.x, y: feet.y, z: feet.z },
    killY: course.killY,
    justRespawned: false,
    dashTicks: 0,
    dashCooldownTicks: 0,
    carrying: false,
    dashedThisStep: false,
    boostTicks: 0,
    pads: course.pads.map((pad) => ({
      kind: pad.kind,
      min: {
        x: pad.position[0] - pad.size[0] / 2,
        y: pad.position[1] - pad.size[1] / 2,
        z: pad.position[2] - pad.size[2] / 2,
      },
      max: {
        x: pad.position[0] + pad.size[0] / 2,
        y: pad.position[1] + pad.size[1] / 2,
        z: pad.position[2] + pad.size[2] / 2,
      },
      dirX: pad.direction?.[0] ?? 0,
      dirZ: pad.direction?.[1] ?? 0,
    })),
  };
}

/**
 * Release a character's body, collider and controller.
 *
 * Removing the body takes its collider with it, but the character controller
 * is a separate WASM allocation the world tracks on its own. Without the second
 * call every join on the server leaks one.
 */
export function destroySimBody(world: World, sim: SimBody): void {
  world.removeCharacterController(sim.controller);
  world.removeRigidBody(sim.body);
}

/**
 * Integrate one fixed step of movement.
 *
 * Velocity is hand-integrated (accel, friction, gravity) while every contact is
 * delegated to Rapier's kinematic character controller. That split keeps game
 * feel tunable without reimplementing swept collision, which is where
 * hand-rolled physics goes wrong.
 *
 * Falling out of the world is resolved HERE rather than by the server, and that
 * is the whole point. A server-only teleport is a discontinuity the client
 * cannot predict: it arrives as a correction, and the reconciler smooths it, so
 * a racer who falls fifty units past the goal visibly slides back up the course.
 * Doing it in the shared step means both sides teleport on the same tick, from
 * the same state, and the respawn is part of the predicted timeline.
 *
 * Movement is world-axis aligned (forward = -Z). Camera-relative movement needs
 * camera yaw and stays deferred until the camera can actually orbit.
 *
 * This does NOT advance the world. The caller does that.
 */
export function applyInput(sim: SimBody, input: MoveInputData, dt: number): void {
  const { velocity } = sim;

  // --- fall out of the world ---------------------------------------------
  // Checked at the TOP of the step, against the position left by the previous
  // step. The one-tick lag is irrelevant and, more to the point, identical on
  // both sides — which is what keeps replay reproducing the server.
  sim.justRespawned = false;
  if (sim.body.translation().y < sim.killY) {
    moveSimBody(sim, sim.respawn.x, sim.respawn.y, sim.respawn.z);
    sim.justRespawned = true;
  }

  // --- pads ----------------------------------------------------------------
  // Tested against the position left by the previous step, like the fall
  // check above, and for the same reason: both sides see the same overlap on
  // the same tick. The capsule is treated as its AABB, which is exact enough
  // for flat trigger slabs lying on a surface.
  applyPads(sim);

  // --- horizontal intent -------------------------------------------------
  // `moveZ` is already signed forward-positive-negative (W = -Z), so it maps
  // straight onto the world axis.
  let wishX = input.moveX;
  let wishZ = input.moveZ;

  // Normalise so diagonals aren't faster than cardinals.
  const wishLength = Math.hypot(wishX, wishZ);
  const hasWish = wishLength > 1e-4;
  if (hasWish) {
    wishX /= wishLength;
    wishZ /= wishLength;
  }

  // --- dash --------------------------------------------------------------
  // While dashing, horizontal velocity is left exactly as the dash set it:
  // steering, accel and friction are all skipped, so the dash flies straight.
  // Once it ends the ordinary accel/friction below bleed the excess off.
  const dashing = sim.dashTicks > 0 || tryStartDash(sim, input, wishX, wishZ, hasWish);
  sim.dashedThisStep = dashing;

  if (!dashing) {
    // A boost raises the top speed for a moment, and while it lasts letting
    // go of the stick coasts instead of braking: a boost pad should carry you
    // even if you are not touching anything.
    const boosted = sim.boostTicks > 0;
    const topSpeed = boosted ? BOOST.speed : MOVE.runSpeed;
    const targetSpeed = sim.carrying ? topSpeed * CORE.carrierSpeedFactor : topSpeed;
    const control = sim.grounded ? 1 : MOVE.airControl;
    const accel = MOVE.accel * control;
    const decel = MOVE.friction * (sim.grounded ? 1 : MOVE.airControl);

    if (hasWish) {
      velocity.x = approach(velocity.x, wishX * targetSpeed, accel * dt);
      velocity.z = approach(velocity.z, wishZ * targetSpeed, accel * dt);
    } else if (boosted) {
      // Coast: keep the boost's velocity.
    } else {
      velocity.x = approach(velocity.x, 0, decel * dt);
      velocity.z = approach(velocity.z, 0, decel * dt);
    }
  }

  // --- jump and gravity --------------------------------------------------
  // Vertical motion is deliberately untouched by the dash: gravity keeps
  // acting and a jump still works mid-dash. A flat, gravity-free air dash
  // would turn every dash into a 4-unit hover across gaps the course was laid
  // out to make you jump, and would need its own rule for what "grounded"
  // means mid-air. Leaving Y alone keeps the dash a purely horizontal burst
  // with one rule: the horizontal velocity is frozen, nothing else changes.
  if (input.jump && sim.grounded) {
    velocity.y = MOVE.jumpSpeed;
    sim.grounded = false;
  }

  velocity.y += GRAVITY.y * dt;

  // --- resolve against the world ----------------------------------------
  const current = sim.body.translation();
  const desired: Vec3Obj = {
    x: velocity.x * dt,
    y: velocity.y * dt,
    z: velocity.z * dt,
  };

  // Filtered by the racer's own groups, so the sweep -- including autostep and
  // snap-to-ground -- sees course geometry only. See GROUP_RACER.
  sim.controller.computeColliderMovement(sim.collider, desired, undefined, RACER_GROUPS);
  const movement = sim.controller.computedMovement();
  sim.grounded = sim.controller.computedGrounded();

  // Landing cancels downward velocity; otherwise gravity accumulates and the
  // capsule sticks to the floor with a force it can never escape.
  if (sim.grounded && velocity.y < 0) {
    velocity.y = 0;
  }

  sim.body.setNextKinematicTranslation({
    x: current.x + movement.x,
    y: current.y + movement.y,
    z: current.z + movement.z,
  });

  sim.horizontalSpeed = Math.hypot(velocity.x, velocity.z);

  // --- dash bookkeeping ---------------------------------------------------
  // At the END of the step, so a dash lasts exactly `DASH.durationTicks`
  // moving steps, the published `dashTicks` is "steps still to fly", and the
  // tick a dash ends does not also burn a cooldown tick: the next dash can
  // start no sooner than `DASH.cooldownTicks` whole non-dashing steps later.
  if (dashing) {
    sim.dashTicks -= 1;
    if (sim.dashTicks === 0) sim.dashCooldownTicks = DASH.cooldownTicks;
  } else if (sim.dashCooldownTicks > 0) {
    sim.dashCooldownTicks -= 1;
  }
  if (sim.boostTicks > 0) sim.boostTicks -= 1;
}

/**
 * Start a dash if the rules allow one this step. Returns whether it started.
 *
 * Direction is the stick if there is one, else wherever momentum is already
 * carrying the body. With neither there is nothing to aim at, so nothing fires
 * and -- because no dash happened -- no cooldown is spent either; holding dash
 * while standing still must not quietly eat the next one.
 *
 * Air dashes are allowed. A carrier can never start one: that is the whole
 * cost of holding the Core. A dash already under way when the Core arrives
 * (the steal itself happens mid-dash) is left to finish; only the START is
 * gated, which keeps the rule a single check rather than a cancel path the
 * client would have to predict on the exact tick the server hands it the Core.
 */
function tryStartDash(
  sim: SimBody,
  input: MoveInputData,
  wishX: number,
  wishZ: number,
  hasWish: boolean,
): boolean {
  if (!input.dash || sim.carrying || sim.dashCooldownTicks !== 0) return false;

  let dirX = wishX;
  let dirZ = wishZ;
  if (!hasWish) {
    const speed = Math.hypot(sim.velocity.x, sim.velocity.z);
    if (speed < DASH_MIN_MOMENTUM) return false;
    dirX = sim.velocity.x / speed;
    dirZ = sim.velocity.z / speed;
  }

  sim.velocity.x = dirX * DASH.speed;
  sim.velocity.z = dirZ * DASH.speed;
  sim.dashTicks = DASH.durationTicks;
  return true;
}

/**
 * Teleport to an arbitrary feet position, zero all velocity and clear any dash.
 *
 * The dash counters reset with the velocity: a dash that survived a teleport
 * would fling the body out of its spawn at dash speed, and a leftover cooldown
 * would make a fresh start feel broken. `carrying` is NOT touched -- whether a
 * respawn costs the Core is a game rule the room owns.
 */
export function moveSimBody(sim: SimBody, feetX: number, feetY: number, feetZ: number): void {
  sim.dashTicks = 0;
  sim.dashCooldownTicks = 0;
  sim.boostTicks = 0;
  sim.velocity.x = 0;
  sim.velocity.y = 0;
  sim.velocity.z = 0;
  sim.grounded = false;
  sim.horizontalSpeed = 0;

  teleportBody(sim, { x: feetX, y: feetY + PLAYER.halfHeight + PLAYER.radius, z: feetZ });
}

/**
 * Cut the capsule to a body-centre position, instantly, body AND collider.
 *
 * setTranslation, not setNextKinematicTranslation: an instantaneous cut is not
 * a step the simulation should interpolate toward.
 *
 * The collider is moved explicitly because Rapier only re-derives a collider's
 * pose from its body inside `world.step()`. Moving the body alone leaves the
 * collider where it was, and the very next `computeColliderMovement` sweeps
 * from that stale pose. On the client that is a rollback bug: after adopting
 * truth the first replayed step tests walls from the MISPREDICTED position,
 * misses a rail the server hit, and the body ends up inside it. The harness
 * caught exactly that on a mid-dash rollback beside the start rail. The
 * capsule sits at the body origin, so the two translations are the same.
 */
export function teleportBody(sim: SimBody, centre: Vec3Obj): void {
  sim.body.setTranslation(centre, true);
  sim.collider.setTranslation(centre);
}

/**
 * Apply every pad the body overlaps this step.
 *
 * Boost: if the racer is already moving the pad's way (any positive component
 * along it), horizontal velocity snaps to the pad's direction at boost speed
 * and the boost timer refills, every tick the racer is on it -- so a strip of
 * boost pads is a conveyor that also straightens you out. Jump: a grounded racer is
 * launched up; the next tick it is airborne, so it cannot re-trigger mid-climb.
 */
function applyPads(sim: SimBody): void {
  if (sim.pads.length === 0) return;
  const p = sim.body.translation();
  const r = PLAYER.radius;
  const h = PLAYER.halfHeight + PLAYER.radius;

  for (const pad of sim.pads) {
    if (
      p.x + r <= pad.min.x || p.x - r >= pad.max.x ||
      p.y + h <= pad.min.y || p.y - h >= pad.max.y ||
      p.z + r <= pad.min.z || p.z - r >= pad.max.z
    ) {
      continue;
    }
    if (pad.kind === 'boost') {
      // Directional: a boost only grabs a racer already moving its way. Run
      // across it or against it and nothing happens. Without this, an outward
      // boost on a lane you must run IN along was a trap: it threw you back,
      // you ran at it again, it threw you back again.
      if (sim.velocity.x * pad.dirX + sim.velocity.z * pad.dirZ <= 0) continue;
      sim.velocity.x = pad.dirX * BOOST.speed;
      sim.velocity.z = pad.dirZ * BOOST.speed;
      sim.boostTicks = BOOST.ticks;
    } else if (sim.grounded) {
      sim.velocity.y = JUMP_PAD.speed;
      sim.grounded = false;
    }
  }
}

/**
 * Euler degrees (X, then Y, then Z) to a quaternion -- the same convention as
 * Three's default Euler order, so the collider and the mesh agree. Written out
 * here because this module may not import Three.
 */
export function eulerDegreesToQuat(rotation: Vec3): { x: number; y: number; z: number; w: number } {
  const half = Math.PI / 360;
  const c1 = Math.cos(rotation[0] * half);
  const c2 = Math.cos(rotation[1] * half);
  const c3 = Math.cos(rotation[2] * half);
  const s1 = Math.sin(rotation[0] * half);
  const s2 = Math.sin(rotation[1] * half);
  const s3 = Math.sin(rotation[2] * half);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  };
}

/** Move `current` toward `target` by at most `maxDelta`. */
function approach(current: number, target: number, maxDelta: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

// ---------------------------------------------------------------- course

/**
 * Build the course's colliders.
 *
 * Shared deliberately: if the client and server built these from separate code
 * they could disagree by a fraction of a unit, and the character controller
 * would resolve that disagreement as a phantom wall the client cannot see. One
 * function, one course, two identical worlds.
 *
 * All colliders live on a single fixed body at the origin, each offset by its
 * own translation. Rapier treats that as one compound static object, which is
 * cheaper than a body per solid.
 */
export function buildCourseColliders(world: World, course: Course): RigidBody {
  const staticBody = world.createRigidBody(RigidBodyDesc.fixed());

  for (const solid of course.solids) {
    const [sx, sy, sz] = solid.size;
    const [px, py, pz] = solid.position;

    world.createCollider(
      ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2)
        .setTranslation(px, py, pz)
        .setFriction(WORLD.friction)
        .setRestitution(WORLD.restitution)
        .setCollisionGroups(COURSE_GROUPS)
        .setRotation(eulerDegreesToQuat(solid.rotation ?? [0, 0, 0])),
      staticBody,
    );
  }

  return staticBody;
}

export interface GroundProbe {
  /** Topmost solid surface at or below `fromY`, or null if nothing is below. */
  topY: number | null;
}

/**
 * Find the highest solid surface beneath a point.
 *
 * Used to drop a respawning player onto whichever pad they fell from, so a
 * respawn never leaves them embedded inside geometry. Queries the collider set
 * directly rather than casting a ray — cheaper and needs no collision pipeline
 * state.
 */
export function probeGround(world: World, x: number, z: number, fromY: number): GroundProbe {
  let best = -Infinity;

  world.forEachCollider((collider) => {
    // Only boxes exist in the course format today. If a second primitive is
    // added this must grow a branch rather than silently ignoring it.
    if (!(collider.shape instanceof Cuboid)) return;
    // Ramps are rotated, and the containment test below is axis-aligned. A
    // respawn point is never on a ramp, so they are simply not candidates.
    if (Math.abs(collider.rotation().w) < 0.999999) return;
    const half = collider.shape.halfExtents;

    const t = collider.translation();
    // Horizontal containment test against the box.
    if (x < t.x - half.x || x > t.x + half.x) return;
    if (z < t.z - half.z || z > t.z + half.z) return;

    const top = t.y + half.y;
    if (top <= fromY && top > best) best = top;
  });

  return { topY: best === -Infinity ? null : best };
}

/**
 * The feet position a player respawns at: the real surface under the spawn
 * point, lifted by a hair so the capsule resolves a landing instead of
 * starting interpenetrated.
 *
 * The `spawn` Y in a course file is nominal. Only the colliders know where the
 * floor actually is, so the colliders get the final say.
 */
export function respawnFeet(
  world: World,
  course: Course,
  clearance = 0.05,
): { x: number; y: number; z: number } {
  const [sx, sy, sz] = course.spawn;
  const probe = probeGround(world, sx, sz, sy + 4);
  return {
    x: sx,
    y: probe.topY !== null ? probe.topY + clearance : sy,
    z: sz,
  };
}