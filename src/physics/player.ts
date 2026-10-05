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
 *                rollback. Velocity is restored alongside position; seeding
 *                position alone would throw away momentum on every correction
 *                and make the replay accelerate from a standstill.
 *   readPose   — body -> render. Read after prediction, so what you see is the
 *                predicted position, not the last one the server confirmed.
 */

import type { PlayerStateInstance } from '../shared/state.ts';
import type { SimBody } from '../shared/sim.ts';

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
export function adoptTruth(sim: SimBody, truth: PlayerStateInstance): void {
  sim.velocity.x = truth.vx;
  sim.velocity.y = truth.vy;
  sim.velocity.z = truth.vz;
  sim.grounded = truth.grounded;
  sim.horizontalSpeed = truth.speed;

  // setTranslation, not setNextKinematicTranslation: an authoritative restore
  // is an instantaneous cut. Queuing it as a next-position would leave the body
  // interpolating toward the corrected spot over the next step.
  sim.body.setTranslation({ x: truth.x, y: truth.y, z: truth.z }, true);
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