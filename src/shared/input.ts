/**
 * The wire input
 *
 * This is the entire vocabulary a client has for influencing the simulation.
 * Anything not on this schema cannot reach the server, which is the point: a
 * client that wants to teleport declares it here, visibly, instead of quietly.
 *
 * The server never trusts these values — see `sanitize` in server/room.ts.
 */

import { schema, t } from '@colyseus/schema';

/**
 * One tick of player intent.
 *
 * `jump` is level-triggered rather than edge-triggered, and that is a
 * deliberate consequence of rollback: a queued keypress is consumed by
 * whichever step reads it, and after a rewind that step may not be the one
 * that ran originally. A replayed `jump: true` re-jumps deterministically; a
 * consumed-once edge would be silently lost on every correction.
 */
export const MoveInput = schema(
  {
    /** Strafe, -1 (left) .. 1 (right) on X. */
    moveX: t.number().default(0),
    /** Forward, -1 (back) .. 1 (forward). Forward is -Z. */
    moveZ: t.number().default(0),
    sprint: t.boolean().default(false),
    jump: t.boolean().default(false),
  },
  'MoveInput',
);

export type MoveInputInstance = InstanceType<typeof MoveInput>;

/**
 * The plain field object, with the `Schema` machinery stripped away.
 *
 * This — not `MoveInputInstance` — is what travels. On the server the room
 * hands you a real schema instance (structurally compatible, since it carries
 * these four fields); on the client `InputHandle.data` is only ever the plain
 * shape. Typing the shared step against this is what lets one function accept
 * both.
 */
export interface MoveInputData {
  moveX: number;
  moveZ: number;
  sprint: boolean;
  jump: boolean;
}

/** A fresh, all-zero input. Also what the server synthesizes for an idle tick. */
export function idleInput(): MoveInputInstance {
  return new MoveInput();
}

/**
 * The client's live input needs a name to race under. Trivial, but it turns an
 * anonymous capsule into a person, which matters when the point of the demo is
 * that other people are in the room with you.
 */
export function randomRacerName(): string {
  const adjectives = ['Swift', 'Quiet', 'Bold', 'Lucky', 'Rapid', 'Keen', 'Wild', 'Calm'];
  const nouns = ['Comet', 'Falcon', 'Otter', 'Ember', 'Vector', 'Mantis', 'Lynx', 'Onyx'];
  const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)]!;
  return `${pick(adjectives)} ${pick(nouns)}`;
}