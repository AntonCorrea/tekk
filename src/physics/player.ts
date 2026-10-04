/**
 * Player character
 *
 * Velocity is integrated here by hand (accel, friction, gravity) but every
 * collision resolution is delegated to Rapier's kinematic character
 * controller. That split keeps game feel tunable without reimplementing
 * swept collision, which is where hand-rolled physics goes wrong.
 */

import type {
  World,
  RigidBody,
  Collider,
  KinematicCharacterController,
} from '@dimforge/rapier3d-compat';
import { RigidBodyDesc, ColliderDesc } from '@dimforge/rapier3d-compat';
import { MOVE, PHYSICS, PLAYER, GRAVITY } from '../constants.ts';
import type { Vec3 as Vec3Tuple } from '../shared/course.ts';
import type { InputState } from '../input.ts';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Player {
  readonly body: RigidBody;
  readonly collider: Collider;
  readonly controller: KinematicCharacterController;
  readonly velocity: Vec3;
  /** True when the controller found ground under the capsule this step. */
  grounded: boolean;
  /** Magnitude of horizontal velocity, for HUD and effects. */
  horizontalSpeed: number;
}

export function createPlayer(world: World, spawn: Vec3Tuple): Player {
  // The capsule is lifted clear of the surface so the first step resolves
  // a clean landing instead of starting interpenetrated.
  const spawnY = PLAYER.halfHeight + PLAYER.radius + spawn[1];

  const body = world.createRigidBody(
    RigidBodyDesc.kinematicPositionBased().setTranslation(spawn[0], spawnY, spawn[2]),
  );

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

  return {
    body,
    collider,
    controller,
    velocity: { x: 0, y: 0, z: 0 },
    grounded: false,
    horizontalSpeed: 0,
  };
}

/**
 * Advance the player one fixed step and step the world.
 *
 * Movement is world-axis aligned for now (W = -Z). Camera-relative movement
 * needs camera yaw and is deliberately deferred until the camera can
 * actually orbit.
 */
export function stepPlayer(world: World, player: Player, input: InputState, dt: number): void {
  const { velocity } = player;

  // --- horizontal intent -------------------------------------------------
  // Normalise so diagonals aren't faster than cardinals.
  let wishX = input.strafe;
  let wishZ = -input.forward;
  const wishLength = Math.hypot(wishX, wishZ);
  if (wishLength > 1e-4) {
    wishX /= wishLength;
    wishZ /= wishLength;
  }

  const targetSpeed = input.sprint ? MOVE.sprintSpeed : MOVE.walkSpeed;
  const control = player.grounded ? 1 : MOVE.airControl;
  const accel = MOVE.accel * control;
  const decel = MOVE.friction * (player.grounded ? 1 : MOVE.airControl);

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
  if (input.jumpPressed && player.grounded) {
    velocity.y = MOVE.jumpSpeed;
    player.grounded = false;
  }

  velocity.y += GRAVITY.y * dt;

  // --- resolve against the world ----------------------------------------
  const current = player.body.translation();
  const desired: Vec3 = {
    x: velocity.x * dt,
    y: velocity.y * dt,
    z: velocity.z * dt,
  };

  player.controller.computeColliderMovement(player.collider, desired);
  const movement = player.controller.computedMovement();
  player.grounded = player.controller.computedGrounded();

  // Landing cancels downward velocity; otherwise gravity accumulates and
  // the capsule sticks to the floor with force it can never escape.
  if (player.grounded && velocity.y < 0) {
    velocity.y = 0;
  }

  player.body.setNextKinematicTranslation({
    x: current.x + movement.x,
    y: current.y + movement.y,
    z: current.z + movement.z,
  });

  world.step();
  player.horizontalSpeed = Math.hypot(velocity.x, velocity.z);
}

/** Teleport back to the spawn point and zero all velocity. */
/** Teleport to an arbitrary feet position and zero all velocity. */
export function movePlayerTo(player: Player, feetX: number, feetY: number, feetZ: number): void {
  player.velocity.x = 0;
  player.velocity.y = 0;
  player.velocity.z = 0;
  player.grounded = false;
  player.horizontalSpeed = 0;
  // setTranslation, not setNextKinematicTranslation: this is an
  // instantaneous cut, not a step the simulation should interpolate.
  player.body.setTranslation({
    x: feetX,
    y: feetY + PLAYER.halfHeight + PLAYER.radius,
    z: feetZ,
  }, true);
}

/** Move `current` toward `target` by at most `maxDelta`. */
function approach(current: number, target: number, maxDelta: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}