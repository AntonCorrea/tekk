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
import { GRAVITY, MOVE, PHYSICS, PLAYER, WORLD } from '../constants.ts';
import type { Course } from './course.ts';
import type { MoveInputData } from './input.ts';

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
    ColliderDesc.capsule(PLAYER.halfHeight, PLAYER.radius).setFriction(0),
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

  // --- horizontal intent -------------------------------------------------
  // `moveZ` is already signed forward-positive-negative (W = -Z), so it maps
  // straight onto the world axis.
  let wishX = input.moveX;
  let wishZ = input.moveZ;

  // Normalise so diagonals aren't faster than cardinals.
  const wishLength = Math.hypot(wishX, wishZ);
  if (wishLength > 1e-4) {
    wishX /= wishLength;
    wishZ /= wishLength;
  }

  const targetSpeed = input.sprint ? MOVE.sprintSpeed : MOVE.walkSpeed;
  const control = sim.grounded ? 1 : MOVE.airControl;
  const accel = MOVE.accel * control;
  const decel = MOVE.friction * (sim.grounded ? 1 : MOVE.airControl);

  const targetVx = wishX * targetSpeed;
  const targetVz = wishZ * targetSpeed;

  if (wishLength > 1e-4) {
    velocity.x = approach(velocity.x, targetVx, accel * dt);
    velocity.z = approach(velocity.z, targetVz, accel * dt);
  } else {
    velocity.x = approach(velocity.x, 0, decel * dt);
    velocity.z = approach(velocity.z, 0, decel * dt);
  }

  // --- jump and gravity --------------------------------------------------
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

  sim.controller.computeColliderMovement(sim.collider, desired);
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
}

/** Teleport to an arbitrary feet position and zero all velocity. */
export function moveSimBody(sim: SimBody, feetX: number, feetY: number, feetZ: number): void {
  sim.velocity.x = 0;
  sim.velocity.y = 0;
  sim.velocity.z = 0;
  sim.grounded = false;
  sim.horizontalSpeed = 0;

  // setTranslation, not setNextKinematicTranslation: an instantaneous cut is
  // not a step the simulation should interpolate toward.
  sim.body.setTranslation(
    {
      x: feetX,
      y: feetY + PLAYER.halfHeight + PLAYER.radius,
      z: feetZ,
    },
    true,
  );
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
        .setRestitution(WORLD.restitution),
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