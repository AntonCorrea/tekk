/**
 * The local player
 *
 * The prediction-facing view of your own racer. The physics itself lives in
 * shared/sim.ts, because the server runs the same code — what lives here is
 * only the translation between that body and the replicated state the server
 * sends back.
 *
 * Two directions, and both matter:
 *
 *   adoptTruth — server -> body. Called on every acknowledgement during a
 *                rollback. Velocity and the dash counters are restored
 *                alongside position; seeding position alone would throw away
 *                momentum on every correction and make the replay accelerate
 *                from a standstill.
 *   readPose   — body -> render. Read after prediction, so what you see is the
 *                predicted position, not the last one the server confirmed.
 */

import type { PlayerStateInstance } from '../shared/state.ts';
import { teleportBody, type SimBody } from '../shared/sim.ts';

export interface Pose {
  x: number;
  y: number;
  z: number;
}

/**
 * Overwrite the predicted body with the server's authoritative state.
 *
 * Called BEFORE unacknowledged inputs are replayed, so this is the restore
 * point the replay starts from.
 */
export function adoptTruth(sim: SimBody, truth: PlayerStateInstance, carrying: boolean): void {
  sim.velocity.x = truth.vx;
  sim.velocity.y = truth.vy;
  sim.velocity.z = truth.vz;
  sim.grounded = truth.grounded;
  sim.horizontalSpeed = truth.speed;

  // The dash counters are step state like velocity: restoring position but not
  // these would replay a dash the server already finished, or skip one it
  // started. They are integers, so the restore is exact.
  sim.dashTicks = truth.dashTicks;
  sim.dashCooldownTicks = truth.dashCooldownTicks;
  sim.boostTicks = truth.boostTicks;

  // The wall counters and the face normal, for the same reason: a rollback
  // into the middle of a clip must re-enter the clip (and its budget) against
  // the same face, or the first replayed step reads the stale sweep.
  sim.wallTicks = truth.wallRunTicks;
  sim.wallCooldownTicks = truth.wallCooldownTicks;
  sim.wallNX = truth.wallNX;
  sim.wallNY = truth.wallNY;
  sim.wallNZ = truth.wallNZ;
  sim.wallLocked = truth.wallLocked;
  // The springboard's arming state is step state like the counters above: a
  // rollback into an armed (or mid-bounce) window must replay the same gate.
  sim.prevJump = truth.prevJump;
  sim.bounceArmed = truth.bounceArmed;

  // Not a PlayerState field -- the server keeps one `carrierId` on GameState --
  // so the caller resolves it and passes it in. Replay then runs the carrier's
  // slower speed and dash lock from the ack forward, the same as the server.
  sim.carrying = carrying;

  // An instantaneous cut, not a queued next-position: queuing would leave the
  // body interpolating toward the corrected spot over the next step. Through
  // `teleportBody` so the collider moves too -- otherwise the first replayed
  // step sweeps for walls from the mispredicted spot.
  teleportBody(sim, { x: truth.x, y: truth.y, z: truth.z });
}

/** Current predicted position, for meshes and the camera. */
export function readPose(sim: SimBody): Pose {
  const t = sim.body.translation();
  return { x: t.x, y: t.y, z: t.z };
}

/** Is the local capsule standing on something? */
export function isGrounded(sim: SimBody): boolean {
  return sim.grounded;
}