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
 *
 * The same holds for the dash counters. They are simulation state the shared
 * step reads, so a rollback that restored position but not `dashTicks` would
 * replay a dash the server already finished, or skip one it started.
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

    /** Fixed ticks of dash remaining. Greater than zero means dashing now. */
    dashTicks: t.number().default(0),
    /** Fixed ticks until the next dash may start. */
    dashCooldownTicks: t.number().default(0),

    /** Total time this racer has held the Core this match, in ms. The score. */
    holdMs: t.number().default(0),
    /**
     * Match clock (ms since `playing` began) at which this racer last held the
     * Core, or -1 if never. The tiebreak: equal `holdMs` goes to whoever held
     * it more recently.
     */
    lastHeldAtMs: t.number().default(-1),
    /** Final standing, 1-based. 0 until the match reaches `results`. */
    rank: t.number().default(0),
  },
  'PlayerState',
);

export type PlayerStateInstance = InstanceType<typeof PlayerState>;

/**
 * Match phases, in the order they occur.
 *
 * `ready`     — waiting; the first movement input starts the countdown.
 * `countdown` — racers may move to warm up; the Core is not live yet.
 * `playing`   — the Core is live and `holdMs` accrues.
 * `results`   — ranks are final; the room resets to `ready` when it expires.
 */
export type MatchPhase = 'ready' | 'countdown' | 'playing' | 'results';

export const GameState = schema(
  {
    phase: t.string().default('ready'),
    /**
     * Time left in the current phase, in ms, written by the server every tick.
     * Countdown, match clock and results hold all read from this one field.
     * 0 during `ready`, which has no deadline.
     */
    phaseRemainingMs: t.number().default(0),

    /**
     * The course, verbatim as JSON. Written once at room creation and never
     * touched again, so it costs one packet at join and nothing thereafter.
     * The client validates it through `parseCourse` before building a collider.
     */
    courseJson: t.string().default(''),

    /** sessionId of whoever holds the Core, or '' when it is free. */
    carrierId: t.string().default(''),
    /**
     * Where the Core is, authoritative. When carried the server keeps this
     * above the carrier, so a client may render it from here for remote
     * carriers and from its own predicted pose when it is the carrier.
     */
    coreX: t.number().default(0),
    coreY: t.number().default(0),
    coreZ: t.number().default(0),
    /** Remaining steal immunity for the current carrier, in ms. */
    immuneRemainingMs: t.number().default(0),
    /**
     * Increments every time the Core changes hands (pickup, steal, or reset).
     * Clients watch it to fire the energy wave exactly once per change, which
     * comparing `carrierId` cannot do when the same racer re-takes it.
     */
    coreTransfers: t.number().default(0),

    /** sessionId of the match winner during `results`, '' otherwise. */
    winnerId: t.string().default(''),

    players: t.map(PlayerState),
  },
  'GameState',
);

export type GameStateInstance = InstanceType<typeof GameState>;
