/**
 * Replicated room state
 *
 * Everything here is synced to every client. Two rules keep the wire honest:
 *
 *   - Every field needs an explicit `.default()`. `t.number(0)` looks like it
 *     sets a default and does not — the field reads `undefined` until first
 *     assignment, which propagates NaN through the physics.
 *   - Nothing derived goes here. The server computes it; clients display it.
 */

import { schema, t } from '@colyseus/schema';

/**
 * One racer's authoritative state.
 *
 * Velocity is synced as well as position because rollback re-seeds from this
 * record: adopting position without velocity would zero the player's momentum
 * on every correction, and replay would then accelerate from a standstill.
 */
export const PlayerState = schema(
  {
    name: t.string().default('racer'),

    // Body centre, which is what Rapier reports.
    x: t.number().default(0),
    y: t.number().default(0),
    z: t.number().default(0),

    vx: t.number().default(0),
    vy: t.number().default(0),
    vz: t.number().default(0),

    grounded: t.boolean().default(false),
    speed: t.number().default(0),

    /** Race time in ms when this player reached the goal, or -1 if still racing. */
    finishedMs: t.number().default(-1),
    /** Finishing order, 1-based. 0 until they finish. */
    place: t.number().default(0),
  },
  'PlayerState',
);

export type PlayerStateInstance = InstanceType<typeof PlayerState>;

/**
 * Race phases, in the order they occur.
 *
 * `ready`   — everyone is on the start pad, clock not running.
 * `running` — at least one racer has moved; the clock is authoritative.
 * `finished`— every racer still in the room has crossed the goal.
 */
export type RacePhase = 'ready' | 'running' | 'finished';

export const GameState = schema(
  {
    phase: t.string().default('ready'),
    /** Server clock value at which the race began. */
    startedAtMs: t.number().default(0),
    /** Authoritative elapsed race time in ms. Written by the server each tick. */
    elapsedMs: t.number().default(0),

    /**
     * The course, verbatim as JSON. Written once at room creation and never
     * touched again, so it costs one packet at join and nothing thereafter.
     *
     * A typed `SolidState` collection would be the more Colyseus-native shape,
     * and it would buy reflection and cross-language codegen. Neither is worth
     * ~40 lines of hand-written mirror fields today: the data is immutable
     * mid-room, so patch size is irrelevant, and the client still validates it
     * through `parseCourse` before building a single collider. The server is
     * the source of truth either way — it is the one sending these bytes.
     *
     * Revisit if the course ever becomes editable at runtime.
     */
    courseJson: t.string().default(''),

    players: t.map(PlayerState),
  },
  'GameState',
);

export type GameStateInstance = InstanceType<typeof GameState>;

export function isFinished(state: GameStateInstance): boolean {
  return state.phase === 'finished';
}

/**
 * Elapsed race time, preferring the finished stamp for this player.
 *
 * Reads the shared race phase rather than trusting a client-side clock — the
 * whole point of a server-authoritative race is that nobody's stopwatch
 * disagrees.
 */
export function displayTime(state: GameStateInstance, sessionId: string): number | null {
  const player = state.players.get(sessionId);
  if (!player) return null;
  if (player.finishedMs >= 0) return player.finishedMs;
  return state.phase === 'running' ? state.elapsedMs : null;
}