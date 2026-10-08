/**
 * The Core Rush room -- authoritative server
 *
 * This room owns: the course, the match clock, every racer's position, who
 * holds the Core, and the score. Clients send intent and render state; they
 * never decide where anybody is or who has the Core.
 *
 * The room is still registered as `'race'`, the name clients join by. It is a
 * name on the wire, not a description, and renaming it would strand every
 * client built before the rename.
 *
 * The determinism contract with the client is `src/shared/sim.ts`. This room
 * calls `applyInput` and `world.step()` exactly the way the client's
 * `predict.sim` callbacks do, in the same order, with the same dt. If those two
 * ever diverge, prediction produces constant rubber-banding and nothing throws,
 * so the timestep wiring below is deliberately loud about it.
 *
 * The rules themselves -- pickup, steal, ranking, phase flow -- are pure
 * functions in ./rules.ts. This file gathers positions, asks, and applies.
 */

import type { Client } from '@colyseus/core';
import { Room } from '@colyseus/core';
import type { RigidBody, World } from '@dimforge/rapier3d-compat';

import { CORE, FIXED_TIMESTEP } from '../src/constants.ts';
import type { Course, Vec3 } from '../src/shared/course.ts';
import { MoveInput, idleInput } from '../src/shared/input.ts';
import type { MoveInputInstance } from '../src/shared/input.ts';
import {
  applyInput,
  buildCourseColliders,
  createSimBody,
  destroySimBody,
  moveSimBody,
  type SimBody,
} from '../src/shared/sim.ts';
import { GameState, MapInfo, PlayerState } from '../src/shared/state.ts';
import type { GameStateInstance, MatchPhase, PlayerStateInstance } from '../src/shared/state.ts';
import { createPhysicsWorld, initPhysics } from '../src/physics/world.ts';
import { DEFAULT_COURSE_PATH, loadCourse } from './course.ts';
import { catalogEntry, loadCatalog, type CatalogEntry } from './catalog.ts';
import {
  advancePhase,
  chooseStealer,
  choosePickup,
  chooseMapVote,
  hasSkipMajority,
  rankStandings,
  resolveTimings,
  type Challenger,
  type MatchTimings,
  type PhaseClock,
  type RacerPoint,
} from './rules.ts';

/** Join options a client may send. */
export interface RaceJoinOptions {
  name?: string;
}

/**
 * Creation options. These come from `gameServer.define(...)`, NOT from the
 * client: Colyseus merges the define-time options OVER whatever the client
 * sent, and `createGameServer` always supplies `timings`, so a client cannot
 * create a room with a one-second match by passing its own.
 */
export interface RaceCreateOptions {
  timings?: Partial<MatchTimings>;
  /** Always set at define time (server/index.ts); never trusted from a client. */
  coursePath?: string;
}

/**
 * Room options, which is how the base class learns what this room is.
 *
 * `input` is what types `this.inputs`. Without it declared here the base class
 * types the property as `InputAPI<never>` and every read comes back `never`.
 * `state` does the same for `this.state`, so a stale field name from the race
 * era is a compile error rather than a silently-undefined write.
 */
interface RaceRoomOptions {
  input: MoveInputInstance;
  client: Client;
  state: GameStateInstance;
}

export class RaceRoom extends Room<RaceRoomOptions> {
  /**
   * Per-client input stream.
   *
   * `stepSeconds` is what clients predict at, and it is the value the shared
   * step is integrated with -- set once here so client and server cannot pick
   * different timesteps.
   *
   * `sanitize` clamps the movement axes to the legal range before anything
   * reads them. A client could otherwise send `moveZ: 1e9` and, because the
   * integration normalises by magnitude, walk at a speed nobody tuned.
   *
   * `idle: true` synthesizes an all-zero input on a tick with no packet, so the
   * simulation never has to branch on an empty stream. It does not advance the
   * reconciliation ack, which is correct: the server genuinely did not simulate
   * that input.
   */
  inputs = this.defineInput(MoveInput, {
    stepSeconds: FIXED_TIMESTEP,
    sanitize: { moveX: [-1, 1], moveZ: [-1, 1] },
    idle: true,
  });

  private course!: Course;
  /** The course's collider body, kept so a map swap can remove it. */
  private courseBody!: RigidBody;
  private coreSpawn!: Vec3;
  private world!: World;
  private timings!: MatchTimings;
  /** Every map this room may be voted to. `path` never leaves the server. */
  private catalog: CatalogEntry[] = [];

  /**
   * The match clock, in fixed ticks. See `PhaseClock` in rules.ts for why it
   * is not wall-clock time.
   */
  private clockState: PhaseClock = { phase: 'ready', ticks: 0 };

  private readonly racers = new Map<string, SimBody>();

  override async onCreate(options?: RaceCreateOptions): Promise<void> {
    this.course = loadCourse(options?.coursePath);

    // Fail at creation, loudly, rather than run a match with no Core. The
    // course format allows a missing coreSpawn so race courses still parse;
    // this room cannot play one.
    if (!this.course.coreSpawn) {
      throw new Error(`course "${this.course.id}" has no coreSpawn; Core Rush cannot run on it`);
    }
    this.coreSpawn = this.course.coreSpawn;
    this.timings = resolveTimings(options?.timings);

    await initPhysics();
    this.world = createPhysicsWorld();
    this.courseBody = buildCourseColliders(this.world, this.course);

    this.setState(new GameState());

    // The course definition. The client parses and validates it with the
    // same `parseCourse` the server used, then builds identical colliders
    // from it via the shared builder. Rewritten on a map swap, and that
    // rewrite is the client's signal to rebuild.
    this.state.courseJson = JSON.stringify(this.course);

    // --- the ballot --------------------------------------------------------
    // Every playable map next to the default course, plus this room's own
    // course if it lives elsewhere (a path-form `COURSE`, or the harness's
    // pinned file). Shipped to clients as UI; the paths behind it stay here.
    this.catalog = loadCatalog();
    if (!this.catalog.some((entry) => entry.id === this.course.id)) {
      this.catalog.unshift(catalogEntry(this.course, options?.coursePath ?? DEFAULT_COURSE_PATH));
    }
    for (const entry of this.catalog) {
      const info = new MapInfo();
      info.id = entry.id;
      info.name = entry.name;
      info.solids = entry.solids;
      info.pads = entry.pads;
      this.state.catalog.push(info);
    }

    // --- map votes ---------------------------------------------------------
    // Accepted only in the two lobby windows, and only for ids the catalog
    // ships. Both checks live here: the wire message is a bare course id, so
    // a client can never vote for a file, for a phase it is not in, or for a
    // map this room never offered.
    this.onMessage('vote', (client, message: unknown) => {
      if (this.state.phase !== 'ready' && this.state.phase !== 'results') return;

      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      const courseId = (message as { courseId?: unknown } | null)?.courseId;
      if (typeof courseId !== 'string') return;
      if (!this.catalog.some((entry) => entry.id === courseId)) return;

      player.votedFor = courseId;
      log(`${player.name} voted for "${courseId}"`);
    });

    // --- mid-match skip -----------------------------------------------------
    // The mirror of the vote, with its window inverted: this one exists only
    // while a match is running, and it carries the explicit desired value
    // rather than a flip, so a stale click or a reconnect cannot invert what
    // was meant. `value: false` is how a vote is withdrawn.
    this.onMessage('skip', (client, message: unknown) => {
      if (this.state.phase !== 'countdown' && this.state.phase !== 'playing') return;

      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      const value = (message as { value?: unknown } | null)?.value;
      if (typeof value !== 'boolean') return;

      player.votedToSkip = value;
      log(`${player.name} ${value ? 'voted to skip the match' : 'withdrew the skip'}`);
    });

    this.freeCore();

    // 20 state patches/sec. Position is predicted locally, so this only carries
    // corrections and other racers -- it does not need to be frame-rate.
    this.patchRate = 50;

    this.setFixedTimestep((ctx) => this.simulate(ctx), 1 / FIXED_TIMESTEP);

    log(
      `room "${this.course.id}" -- ${this.course.solids.length} solids, ` +
        `step ${(FIXED_TIMESTEP * 1000).toFixed(2)}ms, ` +
        `match ${this.timings.countdownMs}/${this.timings.durationMs}/${this.timings.resultsMs}ms`,
    );
  }

  override onJoin(client: Client, options?: RaceJoinOptions): void {
    const sim = createSimBody(this.world, this.course, FIXED_TIMESTEP);
    this.racers.set(client.sessionId, sim);

    const state = new PlayerState();
    state.name = sanitiseName(options?.name);
    publishBody(state, sim);

    this.state.players.set(client.sessionId, state);

    log(`${state.name} joined (${this.state.players.size} racing)`);
  }

  override onLeave(client: Client): void {
    // A carrier walking out drops the Core. Done before the body goes so the
    // drop reads like any other: one change of hands, Core back on its dais.
    if (this.state.carrierId === client.sessionId) this.dropCore();

    const sim = this.racers.get(client.sessionId);
    if (sim) {
      destroySimBody(this.world, sim);
      this.racers.delete(client.sessionId);
    }
    this.state.players.delete(client.sessionId);

    // The last racer out resets the match. Nobody is left to finish it, and the
    // next joiner should not land in the middle of somebody else's clock.
    if (this.racers.size === 0) this.enterReady();

    log(`player left (${this.state.players.size} racing)`);
  }

  override onDispose(): void {
    this.racers.clear();
  }

  // ------------------------------------------------------------ simulation

  /**
   * One authoritative fixed step.
   *
   * `ctx.dt` is the step the clients predict at, cascaded through the join
   * handshake from `defineInput({ stepSeconds })`. It is assigned to the Rapier
   * world rather than read from a constant so the engine can never silently
   * disagree with the input rate. The match clock counts these same ticks.
   */
  private simulate(ctx: { dt: number }): void {
    const dt = ctx.dt;
    const dtMs = dt * 1000;
    this.world.timestep = dt;

    let anyoneMoving = false;

    // --- integrate every racer, then advance the world exactly once --------
    // Order matters. One solver step moves every body together, so each racer
    // gets exactly one input per tick. That is why this loop uses `next()`
    // rather than draining the buffer: draining would apply every buffered
    // input, then advance the ack past inputs the server never simulated, which
    // snaps the client's reconciler.
    //
    // `sim.carrying` was set by last tick's rules, so the carrier's slower
    // speed and dash lock take effect on this step -- the same step at which
    // the client, adopting `carrierId` from that tick's state, replays it.
    for (const [sessionId, sim] of this.racers) {
      const input = this.inputs.get(sessionId).next() ?? idleInput();
      if (input.moveX !== 0 || input.moveZ !== 0) anyoneMoving = true;
      applyInput(sim, input, dt);
    }

    this.world.step();

    // --- the Core ---------------------------------------------------------
    // Only while playing, and against post-step positions: the step is what
    // moved everyone, so that is where everyone is.
    if (this.state.phase === 'playing') this.runCoreRules(dtMs);

    // --- match clock ------------------------------------------------------
    // After the rules, so the last playing tick still scores before results
    // freeze it.
    const advance = advancePhase(this.clockState, anyoneMoving, dtMs, this.timings);
    this.clockState = advance.clock;
    if (advance.entered) this.enterPhase(advance.entered);
    this.state.phaseRemainingMs = advance.remainingMs;

    // --- the mid-match skip -------------------------------------------------
    // After the clock, so a countdown that just ran out or a match that just
    // reached results has already moved on: this only ever cuts a match that
    // is still running. It lands in `enterReady`, which rewinds the clock
    // itself, clears the scores, and settles a ballot that cannot exist here
    // (the vote handler only runs in lobby windows) — skipping ends the
    // match, it never picks the next map.
    if (this.state.phase === 'countdown' || this.state.phase === 'playing') {
      let skips = 0;
      for (const player of this.state.players.values()) {
        if (player.votedToSkip) skips += 1;
      }
      if (hasSkipMajority(skips, this.state.players.size)) {
        log(`match skipped by vote (${skips}/${this.state.players.size} wanted out)`);
        this.enterPhase('ready');
      }
    }

    // --- publish ----------------------------------------------------------
    this.placeCore();
    for (const [sessionId, sim] of this.racers) {
      const state = this.state.players.get(sessionId);
      if (state) publishBody(state, sim);
    }
  }

  /**
   * One tick of Core rules: drop, pickup or steal, immunity, hold time.
   *
   * At most one change of hands per tick. A pickup or steal grants immunity,
   * so the same tick cannot then also rob the new carrier.
   */
  private runCoreRules(dtMs: number): void {
    const s = this.state;

    // Falling out costs the Core. `justRespawned` is set inside the shared
    // step, so this is the tick the carrier reappeared at spawn.
    if (s.carrierId !== '' && this.racers.get(s.carrierId)?.justRespawned) {
      this.dropCore();
    }

    s.immuneRemainingMs = Math.max(0, s.immuneRemainingMs - dtMs);

    if (s.carrierId === '') {
      const taker = choosePickup(arrayPoint(this.coreSpawn), this.racerPoints(), CORE.pickupRadius);
      if (taker !== '') this.giveCore(taker, 'picked up');
    } else {
      const carrier = this.racers.get(s.carrierId);
      if (carrier) {
        const challengers: Challenger[] = [];
        for (const [id, sim] of this.racers) {
          challengers.push({ id, ...sim.body.translation(), dashing: sim.dashedThisStep });
        }
        const thief = chooseStealer(
          { id: s.carrierId, ...carrier.body.translation() },
          challengers,
          CORE.stealRadius,
          s.immuneRemainingMs,
        );
        if (thief !== '') this.giveCore(thief, 'stole');
      }
    }

    // Hold time, for whoever ends the tick holding it -- including a racer who
    // took it this tick. `lastHeldAtMs` is the match clock at the END of this
    // tick, so it agrees with `holdMs` for a racer who held from the start.
    if (s.carrierId !== '') {
      const holder = s.players.get(s.carrierId);
      if (holder) {
        holder.holdMs += dtMs;
        holder.lastHeldAtMs = (this.clockState.ticks + 1) * dtMs;
      }
    }
  }

  private racerPoints(): RacerPoint[] {
    const out: RacerPoint[] = [];
    for (const [id, sim] of this.racers) out.push({ id, ...sim.body.translation() });
    return out;
  }

  /** Hand the Core to `sessionId` by pickup or steal. */
  private giveCore(sessionId: string, how: string): void {
    const previous = this.state.carrierId;
    if (previous !== '') {
      const old = this.racers.get(previous);
      if (old) old.carrying = false;
    }
    const sim = this.racers.get(sessionId);
    if (sim) sim.carrying = true;

    this.state.carrierId = sessionId;
    this.state.immuneRemainingMs = CORE.immunityMs;
    this.state.coreTransfers += 1;

    log(`${this.state.players.get(sessionId)?.name ?? sessionId} ${how} the Core`);
  }

  /** The carrier loses the Core; it returns to its spawn. Counts as a transfer. */
  private dropCore(): void {
    if (this.state.carrierId === '') return;
    this.freeCore();
    this.state.coreTransfers += 1;
  }

  /**
   * Make the Core free and clear every `carrying` flag. Does not count a
   * transfer on its own -- callers decide whether this is a change of hands.
   */
  private freeCore(): void {
    for (const sim of this.racers.values()) sim.carrying = false;
    this.state.carrierId = '';
    this.state.immuneRemainingMs = 0;
    this.placeCore();
  }

  /** Free: on its spawn. Carried: above the carrier's body centre. */
  private placeCore(): void {
    const carrier = this.state.carrierId !== '' ? this.racers.get(this.state.carrierId) : undefined;
    if (carrier) {
      const p = carrier.body.translation();
      this.state.coreX = p.x;
      this.state.coreY = p.y + CORE.carryHeight;
      this.state.coreZ = p.z;
    } else {
      this.state.coreX = this.coreSpawn[0];
      this.state.coreY = this.coreSpawn[1];
      this.state.coreZ = this.coreSpawn[2];
    }
  }

  // ------------------------------------------------------------ match flow

  private enterPhase(phase: MatchPhase): void {
    switch (phase) {
      case 'countdown':
        // Whoever moved also committed the lobby: the ready-window's votes
        // settle exactly here, which may rebuild the room onto a new map —
        // everyone landing on its spawn before the countdown runs out.
        this.settleVotes();
        this.state.phase = 'countdown';
        log('countdown');
        break;
      case 'playing':
        this.enterPlaying();
        break;
      case 'results':
        this.enterResults();
        break;
      case 'ready':
        this.enterReady();
        break;
    }
  }

  /** Everyone back to spawn on zero, Core live on its dais. */
  private enterPlaying(): void {
    this.respawnAll();
    for (const state of this.state.players.values()) clearScore(state);
    this.freeCore();
    this.state.winnerId = '';
    this.state.phase = 'playing';
    log('match started');
  }

  /**
   * Time up. Ranks are final; the Core goes free.
   *
   * Freeing a carried Core here counts as a change of hands, like any drop, so
   * a client watching `coreTransfers` sees the Core leave the carrier.
   */
  private enterResults(): void {
    this.dropCore();

    const scores = [...this.state.players.entries()].map(([id, p]) => ({
      id,
      holdMs: p.holdMs,
      lastHeldAtMs: p.lastHeldAtMs,
    }));
    const standings = rankStandings(scores);
    standings.order.forEach((id, i) => {
      const p = this.state.players.get(id);
      if (p) p.rank = i + 1;
    });
    this.state.winnerId = standings.winnerId;
    this.state.phase = 'results';

    const winner = this.state.players.get(standings.winnerId);
    log(winner ? `match over -- ${winner.name} wins with ${(winner.holdMs / 1000).toFixed(2)}s` : 'match over -- nobody held the Core');
  }

  /**
   * Back to waiting. Also the empty-room reset, which can arrive in any phase,
   * so it rewinds the clock itself rather than relying on `advancePhase`.
   * There are no timers to cancel: every phase deadline is a tick count.
   */
  private enterReady(): void {
    this.clockState = { phase: 'ready', ticks: 0 };
    // The results-window's votes settle here, before the reset: on a swap
    // that means the respawn below already uses the new map's spawn.
    this.settleVotes();
    this.respawnAll();
    // Scores and skip flags both die with the lobby reset: the flags are how
    // the previous match ended, not a standing request about the next one.
    for (const state of this.state.players.values()) {
      clearScore(state);
      state.votedToSkip = false;
    }
    this.freeCore();
    this.state.winnerId = '';
    this.state.phase = 'ready';
    this.state.phaseRemainingMs = 0;
    log('reset to ready');
  }

  private respawnAll(): void {
    for (const [sessionId, sim] of this.racers) {
      moveSimBody(sim, sim.respawn.x, sim.respawn.y, sim.respawn.z);
      const state = this.state.players.get(sessionId);
      if (state) publishBody(state, sim);
    }
  }

  // ------------------------------------------------------------------ lobby

  /**
   * Settle the pending map vote and clear it, whichever way it goes.
   *
   * Called at exactly the two points a lobby window closes — ready →
   * countdown and results → ready — so a vote is consumed by one transition
   * and can never linger into a window where it would mean something else.
   * A tie, an empty ballot, or votes for a map that went missing all keep
   * the current course; that is `chooseMapVote`'s call, not this one's.
   *
   * Returns whether the room actually swapped maps.
   */
  private settleVotes(): boolean {
    const votes: string[] = [];
    for (const player of this.state.players.values()) votes.push(player.votedFor);

    const winnerId = chooseMapVote(votes, this.catalog.map((entry) => entry.id), this.course.id);

    // Consumed either way. Even a tie that keeps the map is a decision, and
    // holding the votes over would let them stack into the next window.
    for (const player of this.state.players.values()) player.votedFor = '';

    if (winnerId === this.course.id) return false;
    const entry = this.catalog.find((candidate) => candidate.id === winnerId);
    if (!entry) return false;
    return this.swapCourse(entry);
  }

  /**
   * Rebuild the room onto another course.
   *
   * Every racer's body is destroyed and recreated rather than patched in
   * place: `SimBody.respawn` and `pads` are baked from the course at
   * creation, so a body left over from the old map would respawn into
   * geometry that no longer exists. The bodies keep their session ids, so
   * the players map, the score records and every client's truth keep
   * working untouched — only the world under them changed.
   *
   * The Core is freed as part of the swap. Both swap points are match
   * boundaries where it belongs on its dais anyway, and its dais just moved.
   *
   * Returns false — staying put — if the file went away or lost its
   * `coreSpawn` between the catalog being read and this swap: a stale vote
   * is not worth crashing a live room over.
   */
  private swapCourse(entry: CatalogEntry): boolean {
    let next: Course;
    try {
      next = loadCourse(entry.path);
    } catch (err) {
      log(
        `map "${entry.id}" is unreadable (${err instanceof Error ? err.message : String(err)}); ` +
          `staying on "${this.course.id}"`,
      );
      return false;
    }
    if (!next.coreSpawn) {
      log(`map "${entry.id}" has no coreSpawn; staying on "${this.course.id}"`);
      return false;
    }

    for (const sim of this.racers.values()) destroySimBody(this.world, sim);
    this.world.removeRigidBody(this.courseBody);

    this.course = next;
    this.coreSpawn = next.coreSpawn;
    this.courseBody = buildCourseColliders(this.world, next);
    for (const [sessionId] of this.racers) {
      this.racers.set(sessionId, createSimBody(this.world, next, FIXED_TIMESTEP));
    }

    // The rebuild signal: the client re-parses this string, swaps its own
    // colliders and body, and rebuilds the course visuals to match.
    this.state.courseJson = JSON.stringify(next);
    this.freeCore();
    // The fresh bodies sit at the nominal spawn; this lands them on its
    // surface and publishes the cut, so every client sees the truth at once.
    this.respawnAll();

    log(`map swapped to "${next.id}" -- ${next.solids.length} solids, ${next.pads.length} pads`);
    return true;
  }
}

/** Copy a body's simulation state onto its replicated record. */
function publishBody(state: PlayerStateInstance, sim: SimBody): void {
  const p = sim.body.translation();
  state.x = p.x;
  state.y = p.y;
  state.z = p.z;
  state.vx = sim.velocity.x;
  state.vy = sim.velocity.y;
  state.vz = sim.velocity.z;
  state.grounded = sim.grounded;
  state.speed = sim.horizontalSpeed;
  state.dashTicks = sim.dashTicks;
  state.dashCooldownTicks = sim.dashCooldownTicks;
  state.boostTicks = sim.boostTicks;
}

function clearScore(state: PlayerStateInstance): void {
  state.holdMs = 0;
  state.lastHeldAtMs = -1;
  state.rank = 0;
}

function arrayPoint(v: Vec3): { x: number; y: number; z: number } {
  return { x: v[0], y: v[1], z: v[2] };
}

/** Trim a client-supplied name to something safe to render. */
function sanitiseName(raw: unknown): string {
  if (typeof raw !== 'string') return 'racer';

  // Strip control characters and the characters that could close an HTML tag in
  // the standings board, then clamp the length.
  const clean = raw.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
  return clean.length > 0 ? clean : 'racer';
}

/** Room logging. Colyseus rooms have no logger of their own in 0.18. */
function log(message: string): void {
  console.info(`[race] ${message}`);
}
