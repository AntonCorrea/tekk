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
    /**
     * Fixed ticks of boosted top speed left after a boost pad. Synced for the
     * same reason as the dash counters: replay must know a boost is running.
     */
    boostTicks: t.number().default(0),

    /** Fixed ticks of wall clip remaining; > 0 means clipped to a wall. */
    wallRunTicks: t.number().default(0),
    /** Fixed ticks until a new wall attach may start after a detach. */
    wallCooldownTicks: t.number().default(0),
    /**
     * The clipped wall's unit outward normal (world); zeros when not clipped.
     *
     * Synced even though it is derivable, because the first replayed step
     * after a rollback would otherwise read the controller's STALE sweep --
     * the same trap sync restores velocity and the dash counters against.
     */
    wallNX: t.number().default(0),
    wallNY: t.number().default(0),
    wallNZ: t.number().default(0),
    /**
     * Wall lock: once a clip ends it cannot restart until the racer touches
     * the ground. Synced so a rollback replays the same gating.
     */
    wallLocked: t.boolean().default(false),
    /**
     * The previous step's raw `jump` input. Lets the step tell a FRESH press
     * edge from the level-triggered held state (see `MoveInput`), which is
     * what arms the springboard bounce. Synced because a rollback replays the
     * same gate.
     */
    prevJump: t.boolean().default(false),
    /**
     * The springboard bounce is armed by a jump pressed while ALREADY airborne
     * and consumed when it fires (or when the racer lands). Synced so a
     * rollback replays the same armed-or-not decision.
     */
    bounceArmed: t.boolean().default(false),

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

    /**
     * Course id this racer has voted for in the current lobby window, or ''
     * for no vote. A client may only ever name an id the server shipped in
     * `GameState.catalog`; the server resolves ids to files itself.
     */
    votedFor: t.string().default(''),

    /**
     * Whether this racer wants to abandon the running match. Accepted only
     * during `countdown`/`playing`, carried as an explicit boolean so a
     * reconnect cannot invert the intent, and cleared when the lobby resets.
     * A strict majority of the connected racers cancels the match straight
     * back to `ready`.
     */
    votedToSkip: t.boolean().default(false),
  },
  'PlayerState',
);

export type PlayerStateInstance = InstanceType<typeof PlayerState>;

/**
 * One entry of the room's map catalog — what the lobby may vote on.
 *
 * Deliberately thin: id, display name and the two counts a card shows. The
 * file path stays on the server (see server/catalog.ts); a vote is an id, and
 * the server resolves it, so a client can never name a file on the server's
 * disk.
 */
export const MapInfo = schema(
  {
    /** The course id clients vote on, and the key `votedFor` matches. */
    id: t.string().default(''),
    name: t.string().default(''),
    solids: t.number().default(0),
    pads: t.number().default(0),
  },
  'MapInfo',
);

export type MapInfoInstance = InstanceType<typeof MapInfo>;

/**
 * Match phases, in the order they occur.
 *
 * `ready`     — the lobby: vote for the next map. Nobody can move, and the
 *               countdown starts the moment every player has voted — the
 *               window is only the fallback for abstentions.
 * `countdown` — the countdown number, racers frozen at their spawns until GO;
 *               the Core is not live yet.
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
     * The course, verbatim as JSON. Sent at room creation and again whenever
     * the room swaps maps (see the lobby vote); the client re-validates it
     * through `parseCourse` and rebuilds on every change.
     */
    courseJson: t.string().default(''),

    /**
     * The maps this room may vote to, in card order. Filled once at room
     * creation — the catalog itself never changes mid-room, only which map is
     * running does.
     */
    catalog: t.array(MapInfo),

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
