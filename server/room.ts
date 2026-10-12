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

import { CORE, FIXED_TIMESTEP, HUNT, PICKUP } from '../src/constants.ts';
import type { Course, GameMode, Vec3 } from '../src/shared/course.ts';
import { courseMode, isPlayableCourse } from '../src/shared/course.ts';
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
import { GameState, MapInfo, PickupState, PlayerState } from '../src/shared/state.ts';
import type { GameStateInstance, MatchPhase, PlayerStateInstance } from '../src/shared/state.ts';
import {
  STARTER_TRAILS,
  isTrail,
  STARTER_BODY_COLORS,
  isBodyColor,
  STARTER_HATS,
  isHat,
  STARTER_GEARS,
  isGear,
  itemKind,
} from '../src/shared/cosmetics.ts';
import { createPhysicsWorld, initPhysics } from '../src/physics/world.ts';
import { DEFAULT_COURSE_PATH, loadCourse } from './course.ts';
import { catalogEntry, loadCatalog, type CatalogEntry } from './catalog.ts';
import { popcount, recordMatch, ZERO_WALLET } from './matchRecord.ts';
import {
  advancePhase,
  chooseStealer,
  choosePickup,
  chooseMapVote,
  coresInReach,
  hasSkipMajority,
  racersWithin,
  rankByFinish,
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
  /**
   * Off-chain prototype identity. In the real build this is the verified Privy
   * account id; here it is the local account's handle, and it is only ever
   * used as a label — nothing security-bearing keys off it yet.
   */
  accountId?: string;
  /**
   * Trail ids the client claims to own, and the one it wants to wear.
   *
   * There is no database in the prototype, so ownership arrives with the join
   * and is held in memory per session. That is what makes the flow runnable;
   * it is NOT a trust model. In the real build ownership is read from the
   * account's server-side record (DB or chain) and these fields are ignored —
   * see `server/room.ts` on the `equip` handler for where that swap lands.
   */
  trails?: string[];
  trail?: string;
  /**
   * Body-colour ids the client claims to own, and the one it wants to wear.
   *
   * Exactly the same trust model as `trails`/`trail`: the claim is normalised
   * against the catalog on arrival and held per session; a stale or malicious
   * join option degrades to Stock rather than to a colour the racer does not
   * own.
   */
  colors?: string[];
  color?: string;
  /**
   * Hat ids the client claims to own, and the one it wants to wear.
   *
   * Same trust model as `trails`/`colors`: the claim is normalised against
   * the catalog on arrival and held per session; a stale or malicious join
   * option degrades to Stock (no hat) rather than to a hat the racer does not
   * own.
   */
  hats?: string[];
  hat?: string;
  /**
   * Gear ids the client claims to own, and the piece it wants to wear.
   *
   * Same trust model as `trails`/`hats`: the claim is normalised against the
   * catalog on arrival and held per session; a stale or malicious join option
   * degrades to Stock (no gear) rather than to a piece the racer does not own.
   */
  gears?: string[];
  gear?: string;
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
  /**
   * The game mode the running course declares, read off the loaded file (never
   * off replicated state). Stored rather than consulted per tick because a map
   * swap changes it and the rules branch on it every step.
   */
  private mode: GameMode = 'hold';
  /** `hold`/`reach`: where the single Core sits when free. Undefined on `hunt`. */
  private coreSpawn?: Vec3;
  private world!: World;
  private timings!: MatchTimings;
  /** Every map this room may be voted to. `path` never leaves the server. */
  private catalog: CatalogEntry[] = [];

  /**
   * `hunt` only: which cores each racer has collected, keyed by session id.
   *
   * Server truth for the found set; the replicated `PlayerState.coreMask`
   * mirrors it as a bitmask. Per-racer on purpose — a hunt core is a
   * checkpoint, not a contested pickup, so one racer finding one denies nobody.
   * Cleared at the top of every match (`enterPlaying`) and dropped per session
   * on leave.
   */
  private readonly huntFound = new Map<string, Set<number>>();

  /**
   * Per-session cosmetic ownership.
   *
   * Presentational only, but still owned by the server: an `equip` is checked
   * against the set stored here rather than against whatever the wire claims,
   * so the validation site is in the right place for the DB/chain lookup the
   * real build will put behind it. Keyed by session id and dropped on leave.
   */
  private readonly cosmetics = new Map<
    string,
    {
      accountId: string;
      ownedTrails: Set<string>;
      ownedColors: Set<string>;
      ownedHats: Set<string>;
      ownedGears: Set<string>;
    }
  >();

  /**
   * The pickup balls on the current map, and who has taken each.
   *
   * Server truth for capture; the replicated `state.pickups` mirrors it. The
   * list is rebuilt from the course whenever the room (re)builds a map, and
   * importantly NOT when a match restarts on the same map: a taken ball stays
   * taken for the life of the map, per the collect model — a new map is what
   * refreshes everyone's chance at a ball (see `refreshPickups`).
   */
  private pickupEntities: Array<{
    id: string;
    item: string;
    x: number;
    y: number;
    z: number;
    taken: boolean;
    takenBy: string;
  }> = [];

  /**
   * The match clock, in fixed ticks. See `PhaseClock` in rules.ts for why it
   * is not wall-clock time.
   */
  private clockState: PhaseClock = { phase: 'ready', ticks: 0 };

  private readonly racers = new Map<string, SimBody>();

  override async onCreate(options?: RaceCreateOptions): Promise<void> {
    this.course = loadCourse(options?.coursePath);

    // Fail at creation, loudly, rather than run a match that cannot be played.
    // Which field the mode needs is `isPlayableCourse`'s call, so the catalog
    // (which filters on the same function) and this check can never disagree.
    this.mode = courseMode(this.course);
    if (!isPlayableCourse(this.course)) {
      throw new Error(
        `course "${this.course.id}" is not playable: mode "${this.mode}" needs ` +
          (this.mode === 'hunt' ? 'a non-empty cores list' : 'a coreSpawn'),
      );
    }
    this.coreSpawn = this.course.coreSpawn;
    this.timings = resolveTimings(options?.timings);

    await initPhysics();
    this.world = createPhysicsWorld();
    this.courseBody = buildCourseColliders(this.world, this.course);

    this.setState(new GameState());
    this.state.mode = this.mode;

    // The course definition. The client parses and validates it with the
    // same `parseCourse` the server used, then builds identical colliders
    // from it via the shared builder. Rewritten on a map swap, and that
    // rewrite is the client's signal to rebuild.
    this.state.courseJson = JSON.stringify(this.course);

    // The cosmetic pickup balls for this map. Refilled only when the room
    // (re)builds a map: a map swap is what refreshes taken balls.
    this.refreshPickups();

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
      info.mode = entry.mode;
      this.state.catalog.push(info);
    }

    // --- map votes ---------------------------------------------------------
    // Accepted in the two lobby windows as the ballot — and while a match
    // runs as the change-map vote, because the panel that draws this ballot
    // is the same panel the player picks from mid-match. Either way only ids
    // the catalog ships: the wire message is a bare course id, so a client
    // can never vote for a file or for a map this room never offered.
    this.onMessage('vote', (client, message: unknown) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      const courseId = (message as { courseId?: unknown } | null)?.courseId;
      if (typeof courseId !== 'string') return;
      if (!this.catalog.some((entry) => entry.id === courseId)) return;

      const midMatch = this.state.phase === 'countdown' || this.state.phase === 'playing';
      if (!midMatch && this.state.phase !== 'ready' && this.state.phase !== 'results') return;

      if (midMatch) {
        // A pick mid-match is both a map wish and a vote to end the run: when
        // a strict majority picks (see the tick below), the match cancels back
        // to `ready` and these very votes settle the next map. Re-picking the
        // card already voted for withdraws the whole thing, so one card can
        // never quietly accumulate two votes from the same racer.
        if (player.votedFor === courseId) {
          player.votedFor = '';
          player.votedToSkip = false;
          log(`${player.name} withdrew the change-map vote`);
        } else {
          player.votedFor = courseId;
          player.votedToSkip = true;
          log(`${player.name} voted to change map to "${courseId}"`);
        }
      } else {
        player.votedFor = courseId;
        log(`${player.name} voted for "${courseId}"`);
      }
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

    // --- equip a cosmetic ----------------------------------------------------
    // Presentational: what a racer wears feeds nothing into the sim, so this
    // message exists in every phase, including the lobby. The server still
    // validates both ways — the id must name a real trail, body colour, hat or
    // gear, and the racer must own it — so a client can never self-declare a
    // look it did not acquire. Ownership is the claim carried at join for now
    // (no DB); the real build swaps the owned sets for a lookup against the
    // account's record, and this handler does not change one line.
    this.onMessage('equip', (client, message: unknown) => {
      const player = this.state.players.get(client.sessionId);
      const wardrobe = this.cosmetics.get(client.sessionId);
      if (!player || !wardrobe) return;

      const body = (message ?? null) as {
        trailId?: unknown;
        colorId?: unknown;
        hatId?: unknown;
        gearId?: unknown;
      } | null;
      const trailId = body?.trailId;
      if (isTrail(trailId) && wardrobe.ownedTrails.has(trailId)) {
        player.equippedTrailId = trailId;
        log(`${player.name} equipped trail "${trailId}"`);
        return;
      }
      const colorId = body?.colorId;
      if (isBodyColor(colorId) && wardrobe.ownedColors.has(colorId)) {
        player.equippedBodyColorId = colorId;
        log(`${player.name} equipped body colour "${colorId}"`);
        return;
      }
      const hatId = body?.hatId;
      if (isHat(hatId) && wardrobe.ownedHats.has(hatId)) {
        player.equippedHatId = hatId;
        log(`${player.name} equipped hat "${hatId}"`);
        return;
      }
      const gearId = body?.gearId;
      if (isGear(gearId) && wardrobe.ownedGears.has(gearId)) {
        player.equippedGearId = gearId;
        log(`${player.name} equipped gear "${gearId}"`);
        return;
      }
    });

    // --- rename yourself ----------------------------------------------------
    // Display-only, like `equip`: nothing on the sim path reads the name, so
    // this is legal in every phase. The server keeps owning the value — a
    // rename passes through the same `sanitiseName` that sanitised the join —
    // so a racer can pick a name it likes, but never one that breaks the
    // standings board's rendering.
    this.onMessage('rename', (client, message: unknown) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      const name = (message as { name?: unknown } | null)?.name;
      const next = sanitiseName(name);
      if (next === player.name) return;
      player.name = next;
      log(`${player.name} renamed themselves`);
    });

    this.freeCore();

    // 20 state patches/sec. Position is predicted locally, so this only carries
    // corrections and other racers -- it does not need to be frame-rate.
    this.patchRate = 50;

    this.setFixedTimestep((ctx) => this.simulate(ctx), 1 / FIXED_TIMESTEP);

    log(
      `room "${this.course.id}" -- ${this.course.solids.length} solids, ` +
        `${this.course.pickups.length} pickups, ` +
        `step ${(FIXED_TIMESTEP * 1000).toFixed(2)}ms, ` +
        `match lobby=${this.timings.lobbyMs}ms, ` +
        `${this.timings.countdownMs}/${this.timings.durationMs}/${this.timings.resultsMs}ms`,
    );
  }

  override onJoin(client: Client, options?: RaceJoinOptions): void {
    const sim = createSimBody(this.world, this.course, FIXED_TIMESTEP);
    this.racers.set(client.sessionId, sim);

    // The claimed wardrobe is normalised against the catalog and the worn ids
    // are re-validated against it, so a stale or malicious join option
    // degrades to stock rather than to a trail or colour the racer does not
    // own.
    const ownedTrails = normaliseOwnedTrails(options?.trails);
    const requestedTrail = options?.trail;
    const equippedTrail =
      isTrail(requestedTrail) && ownedTrails.includes(requestedTrail)
        ? requestedTrail
        : ownedTrails[0]!;

    const ownedColors = normaliseOwnedColors(options?.colors);
    const requestedColor = options?.color;
    const equippedColor =
      isBodyColor(requestedColor) && ownedColors.includes(requestedColor)
        ? requestedColor
        : ownedColors[0]!;

    const ownedHats = normaliseOwnedHats(options?.hats);
    const requestedHat = options?.hat;
    const equippedHat =
      isHat(requestedHat) && ownedHats.includes(requestedHat)
        ? requestedHat
        : ownedHats[0]!;

    const ownedGears = normaliseOwnedGears(options?.gears);
    const requestedGear = options?.gear;
    const equippedGear =
      isGear(requestedGear) && ownedGears.includes(requestedGear)
        ? requestedGear
        : ownedGears[0]!;

    this.cosmetics.set(client.sessionId, {
      accountId: typeof options?.accountId === 'string' ? options.accountId : '',
      ownedTrails: new Set(ownedTrails),
      ownedColors: new Set(ownedColors),
      ownedHats: new Set(ownedHats),
      ownedGears: new Set(ownedGears),
    });

    const state = new PlayerState();
    state.name = sanitiseName(options?.name);
    state.equippedTrailId = equippedTrail;
    state.equippedBodyColorId = equippedColor;
    state.equippedHatId = equippedHat;
    state.equippedGearId = equippedGear;
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
    this.cosmetics.delete(client.sessionId);
    this.huntFound.delete(client.sessionId);

    // The last racer out resets the match. Nobody is left to finish it, and the
    // next joiner should not land in the middle of somebody else's clock.
    if (this.racers.size === 0) this.enterReady();

    log(`player left (${this.state.players.size} racing)`);
  }

  override onDispose(): void {
    this.racers.clear();
    this.cosmetics.clear();
    this.huntFound.clear();
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
    //
    // Input only exists inside a live match (playing, and the results stroll
    // that follows it). During the ready lobby and the countdown the racers
    // stand frozen at their spawns: a W held through the lobby must not leave
    // the gate, and a false start must be impossible by construction.
    for (const [sessionId, sim] of this.racers) {
      const input = this.inputs.get(sessionId).next() ?? idleInput();
      if (this.state.phase !== 'ready' && this.state.phase !== 'countdown') {
        applyInput(sim, input, dt);
      }
    }

    this.world.step();

    // --- the Core ---------------------------------------------------------
    // Only while playing, and against post-step positions: the step is what
    // moved everyone, so that is where everyone is. Which rule set runs is the
    // course's game mode: `hold` contests one Core, `reach` clocks a touch of a
    // fixed one, `hunt` clocks collecting every checkpoint. All three are
    // server-side and post-step, exactly like the cosmetic pickup capture that
    // rides alongside them — the shared sim never sees any of it.
    if (this.state.phase === 'playing') {
      if (this.mode === 'hold') this.runCoreRules(dtMs);
      else if (this.mode === 'reach') this.runReachRules(dtMs);
      else this.runHuntRules(dtMs);
      this.runPickupRules();
    }

    // --- match clock ------------------------------------------------------
    // After the rules, so the last playing tick still scores before results
    // freeze it. The lobby window only ticks while the room is occupied, and
    // a full ballot ends it early: the moment every player here has voted,
    // the countdown begins at once — the window is only the fallback when
    // somebody abstains. 'Everyone' is everyone currently in the room: a
    // racer who joins mid-lobby holds the countdown until they vote too.
    let allVoted = this.state.players.size > 0;
    if (allVoted) {
      for (const player of this.state.players.values()) {
        if (player.votedFor === '') {
          allVoted = false;
          break;
        }
      }
    }

    // A racing match's early exit, the mirror of the lobby's full ballot: once
    // every racer here has finished, `advancePhase` cuts to results rather than
    // waiting out the clock. Only `reach`/`hunt` have a finish (`hold` plays
    // the whole match), and an empty room never counts as "everyone done".
    let allDone = false;
    if (this.mode !== 'hold' && this.state.players.size > 0) {
      allDone = true;
      for (const player of this.state.players.values()) {
        if (player.finishMs < 0) {
          allDone = false;
          break;
        }
      }
    }

    const advance = advancePhase(this.clockState, this.racers.size > 0, allVoted, dtMs, this.timings, allDone);
    this.clockState = advance.clock;
    if (advance.entered) {
      if (advance.entered === 'countdown') {
        log(allVoted ? 'countdown -- everyone voted' : 'countdown -- lobby window up');
      }
      this.enterPhase(advance.entered);
    }
    this.state.phaseRemainingMs = advance.remainingMs;

    // --- the mid-match change-map vote -------------------------------------
    // After the clock, so a countdown that just ran out or a match that just
    // reached results has already moved on: this only ever cuts a match that
    // is still running. It lands in `enterReady`, which rewinds the clock
    // itself, clears the scores, and settles the votes — and those can exist
    // here, because a pick mid-match counts as a change-map vote (see the
    // `vote` handler), so the majority that ends the run is also the pick
    // that chooses what comes next. The `skip` message drives the same flag
    // for clients that only want out without a map in mind.
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
    // Only ever reached on a `hold`/`reach` course, both of which the room
    // refuses to run without a coreSpawn — but the field is optional now, so
    // narrow it here rather than assert.
    if (!this.coreSpawn) return;

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

  /**
   * One tick of Reach rules: the Core sits at `coreSpawn` and never moves, and
   * the first racer to touch it finishes.
   *
   * Every unfinished racer within `CORE.pickupRadius` of the Core is stamped on
   * the same tick — a genuine tie — and `rankByFinish` breaks that tie by
   * sessionId, so the result never depends on Map iteration order. A racer
   * finishes once: revisiting the Core does nothing, which is why the loop
   * skips anyone already stamped.
   */
  private runReachRules(dtMs: number): void {
    if (!this.coreSpawn) return;
    const touching = racersWithin(arrayPoint(this.coreSpawn), this.racerPoints(), CORE.pickupRadius);

    for (const sessionId of touching) {
      const state = this.state.players.get(sessionId);
      if (!state || state.finishMs >= 0) continue;
      state.finishMs = (this.clockState.ticks + 1) * dtMs;
      log(`${state.name} reached the Core in ${(state.finishMs / 1000).toFixed(2)}s`);
    }
  }

  /**
   * One tick of Hunt rules: each racer collects any checkpoint Core they are
   * standing on, and the tick they collect their last one is their finish.
   *
   * Cores are per-racer checkpoints — nobody can deny anybody — so a racer's
   * found set is theirs alone and a Core another racer took is still live for
   * everyone else. One tick can collect several at once if the layout stacks
   * them, which is fine: the finish is `found.size === cores.length`, whenever
   * that happens. The replicated `coreMask` mirrors the set so the client can
   * dim the cores this racer has already found.
   */
  private runHuntRules(dtMs: number): void {
    const cores = this.course.cores;
    if (!cores || cores.length === 0) return;

    for (const [sessionId, sim] of this.racers) {
      const state = this.state.players.get(sessionId);
      if (!state || state.finishMs >= 0) continue;

      const found = this.huntFoundFor(sessionId);
      if (found.size >= cores.length) continue;

      const hits = coresInReach(cores, sim.body.translation(), found, HUNT.captureRadius);
      if (hits.length === 0) continue;
      for (const i of hits) found.add(i);

      state.coreMask = maskOf(found);
      if (found.size >= cores.length) {
        state.finishMs = (this.clockState.ticks + 1) * dtMs;
        log(`${state.name} found all ${cores.length} cores in ${(state.finishMs / 1000).toFixed(2)}s`);
      }
    }
  }

  private huntFoundFor(sessionId: string): Set<number> {
    let found = this.huntFound.get(sessionId);
    if (!found) {
      found = new Set<number>();
      this.huntFound.set(sessionId, found);
    }
    return found;
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
    } else if (this.coreSpawn) {
      this.state.coreX = this.coreSpawn[0];
      this.state.coreY = this.coreSpawn[1];
      this.state.coreZ = this.coreSpawn[2];
    } else {
      // `hunt` has no single Core; park the replicated point at the origin so a
      // client that draws before reading the mode shows nothing stray.
      this.state.coreX = 0;
      this.state.coreY = 0;
      this.state.coreZ = 0;
    }
  }

  // ------------------------------------------------------------ pickups

  /**
   * Point every pickup ball at the current course, freshly untaken, and mirror
   * it into the replicated state.
   *
   * Called at room creation and on every map swap — and nowhere else. That is
   * the collect model: a taken ball stays taken for the life of the map, and
   * only a NEW map refreshes everyone's chance at it. Re-collecting an item
   * you already own is an idempotent no-op (the grant is a Set add), so
   * nothing here needs per-match bookkeeping.
   */
  private refreshPickups(): void {
    const entities = this.course.pickups.map((pickup) => ({
      id: pickup.id,
      item: pickup.item,
      x: pickup.position[0],
      y: pickup.position[1],
      z: pickup.position[2],
      taken: false,
      takenBy: '',
    }));
    this.pickupEntities = entities;

    this.state.pickups.splice(0, this.state.pickups.length);
    for (const entity of entities) {
      const record = new PickupState();
      record.id = entity.id;
      record.item = entity.item;
      record.x = entity.x;
      record.y = entity.y;
      record.z = entity.z;
      this.state.pickups.push(record);
    }
  }

  /**
   * One tick of pickup capture: an untaken ball within `PICKUP.captureRadius`
   * of a racer's body centre is granted to them, then marked taken for the
   * life of this map.
   *
   * Server-side only — the shared sim never sees the balls — so this runs
   * after the step, against post-step positions, exactly like the Core rules.
   * At most one taker per ball per tick (the first in iteration order wins).
   * The grant lands in the collector's owned set, which is the same set the
   * `equip` handler validates against, so a collected item is equippable with
   * no further plumbing. The client learns who got what from `takenBy`.
   */
  private runPickupRules(): void {
    for (const entity of this.pickupEntities) {
      if (entity.taken) continue;

      for (const [sessionId, sim] of this.racers) {
        const p = sim.body.translation();
        const dx = p.x - entity.x;
        const dy = p.y - entity.y;
        const dz = p.z - entity.z;
        if (dx * dx + dy * dy + dz * dz > PICKUP.captureRadius * PICKUP.captureRadius) {
          continue;
        }

        const wardrobe = this.cosmetics.get(sessionId);
        if (!wardrobe) continue;

        entity.taken = true;
        entity.takenBy = sessionId;
        const record = this.state.pickups.find((candidate) => candidate.id === entity.id);
        if (record) {
          record.taken = true;
          record.takenBy = sessionId;
        }

        const kind = itemKind(entity.item);
        if (kind === 'trail') wardrobe.ownedTrails.add(entity.item);
        else if (kind === 'color') wardrobe.ownedColors.add(entity.item);
        else if (kind === 'hat') wardrobe.ownedHats.add(entity.item);
        else if (kind === 'gear') wardrobe.ownedGears.add(entity.item);

        const name = this.state.players.get(sessionId)?.name ?? sessionId;
        log(`${name} picked up "${entity.item}"`);
        break;
      }
    }
  }

  // ------------------------------------------------------------ match flow

  private enterPhase(phase: MatchPhase): void {
    switch (phase) {
      case 'countdown':
        // The ready-window's votes settle exactly here, whether the ballot
        // completed or the window ran out: on a swap everyone lands on the
        // new map's spawn before the countdown runs out, frozen until GO.
        this.settleVotes();
        this.respawnAll();
        this.state.phase = 'countdown';
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

  /** Everyone back to spawn on zero, Core live (one Core, or the hunt set). */
  private enterPlaying(): void {
    this.respawnAll();
    this.huntFound.clear();
    for (const state of this.state.players.values()) clearScore(state);
    this.freeCore();
    this.state.winnerId = '';
    this.state.phase = 'playing';
    log(this.mode === 'hold' ? 'match started' : `match started -- mode ${this.mode}`);
  }

  /**
   * Time up (or everyone finished). Ranks are final; the Core goes free.
   *
   * The score is mode-shaped: `hold` ranks by banked hold time, while `reach`
   * and `hunt` rank by finish time (`rankByFinish`). Freeing a carried Core
   * here counts as a change of hands, like any drop, so a client watching
   * `coreTransfers` sees the Core leave the carrier.
   */
  private enterResults(): void {
    this.dropCore();

    const scores = [...this.state.players.entries()].map(([id, p]) => ({
      id,
      holdMs: p.holdMs,
      lastHeldAtMs: p.lastHeldAtMs,
      finishMs: p.finishMs,
    }));
    const standings = this.mode === 'hold' ? rankStandings(scores) : rankByFinish(scores);
    standings.order.forEach((id, i) => {
      const p = this.state.players.get(id);
      if (p) p.rank = i + 1;
    });
    this.state.winnerId = standings.winnerId;
    this.state.phase = 'results';

    const winner = this.state.players.get(standings.winnerId);
    if (!winner) {
      log(
        this.mode === 'hold'
          ? 'match over -- nobody held the Core'
          : 'match over -- nobody finished',
      );
    } else if (this.mode === 'hold') {
      log(`match over -- ${winner.name} wins with ${(winner.holdMs / 1000).toFixed(2)}s`);
    } else {
      log(`match over -- ${winner.name} wins in ${(winner.finishMs / 1000).toFixed(2)}s`);
    }

    // On-chain record (Stage 1): one tx per finished match. Gated by
    // MATCH_RECORD_ENABLED + MONAD_RPC_URL + MATCH_SIGNER_KEY +
    // MATCH_RECORD_ADDRESS in tekk2/.env; without them this is a silent
    // no-op, so local dev and the harness never touch the chain. Wallets are
    // zeroed until Stage 3 (Privy) attaches real addresses.
    const racers = [...this.state.players.values()];
    if (racers.length > 0) {
      recordMatch({
        courseId: this.course.id,
        mode: this.mode,
        winner: null,
        players: racers.map((p) => ({
          wallet: ZERO_WALLET,
          holdMs: p.holdMs,
          finishMs: p.finishMs,
          coresFound: popcount(p.coreMask),
        })),
      });
    }
  }

  /**
   * Back to waiting. Also the empty-room reset, which can arrive in any phase,
   * so it rewinds the clock itself rather than relying on `advancePhase`.
   * There are no timers to cancel: every phase deadline is a tick count.
   */
  private enterReady(): void {
    this.clockState = { phase: 'ready', ticks: 0 };
    // The ballot settles here, before the reset: the results-window's votes
    // in the normal loop, and a mid-match change-map majority on a cancel.
    // On a swap the respawn below already uses the new map's spawn.
    this.settleVotes();
    this.respawnAll();
    // Scores and skip flags both die with the lobby reset: the flags are how
    // the previous match ended, not a standing request about the next one.
    this.huntFound.clear();
    for (const state of this.state.players.values()) {
      clearScore(state);
      state.votedToSkip = false;
    }
    this.freeCore();
    this.state.winnerId = '';
    this.state.phase = 'ready';
    this.state.phaseRemainingMs = this.timings.lobbyMs;
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
   * Called wherever a window closes: ready → countdown and results → ready
   * in the normal loop, and the mid-match change-map majority's landing in
   * `enterReady` — so a vote is consumed by one transition and can never
   * linger into a window where it would mean something else.
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
   * Returns false — staying put — if the file went away or is no longer
   * playable between the catalog being read and this swap: a stale vote is not
   * worth crashing a live room over.
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
    if (!isPlayableCourse(next)) {
      log(
        `map "${entry.id}" is not playable (${courseMode(next)} needs its layout); ` +
          `staying on "${this.course.id}"`,
      );
      return false;
    }

    for (const sim of this.racers.values()) destroySimBody(this.world, sim);
    this.world.removeRigidBody(this.courseBody);

    this.course = next;
    this.mode = courseMode(next);
    this.coreSpawn = next.coreSpawn;
    this.courseBody = buildCourseColliders(this.world, next);
    for (const [sessionId] of this.racers) {
      this.racers.set(sessionId, createSimBody(this.world, next, FIXED_TIMESTEP));
    }

    // The rebuild signal: the client re-parses this string, swaps its own
    // colliders and body, and rebuilds the course visuals to match.
    this.state.courseJson = JSON.stringify(next);
    // The mode travels with the new course: a hunt map's per-racer found sets
    // mean nothing on the next one, and the HUD reads its labels off this.
    this.state.mode = this.mode;
    this.huntFound.clear();
    // A new map brings fresh pickup balls: taken stays per map, so a swap is
    // the only thing that refreshes them.
    this.refreshPickups();
    this.freeCore();
    // The fresh bodies sit at the nominal spawn; this lands them on its
    // surface and publishes the cut, so every client sees the truth at once.
    this.respawnAll();

    log(`map swapped to "${next.id}" (${this.mode}) -- ${next.solids.length} solids, ${next.pads.length} pads`);
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
  // The springboard bounce is LIVE (WALL.bounce), so its arming state must
  // survive a rollback like the rest of the replicated sim state -- otherwise
  // the first replayed step after a correction would differ from the server.
  state.wallRunTicks = sim.wallTicks;
  state.wallCooldownTicks = sim.wallCooldownTicks;
  state.wallNX = sim.wallNX;
  state.wallNY = sim.wallNY;
  state.wallNZ = sim.wallNZ;
  state.wallLocked = sim.wallLocked;
  state.prevJump = sim.prevJump;
  state.bounceArmed = sim.bounceArmed;
}

function clearScore(state: PlayerStateInstance): void {
  state.holdMs = 0;
  state.lastHeldAtMs = -1;
  state.rank = 0;
  state.finishMs = -1;
  state.coreMask = 0;
}

/** Pack a set of core indices into the replicated bitmask. */
function maskOf(indices: Iterable<number>): number {
  let mask = 0;
  for (const i of indices) mask |= 1 << i;
  return mask;
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

/**
 * Keep only ids the current catalog still ships, falling back to the starter
 * set when the claim is empty — a fresh account and a malicious client both
 * end up with exactly what they may have.
 */
function normaliseOwnedTrails(raw: unknown): string[] {
  const owned = Array.isArray(raw) ? raw.filter(isTrail) : [];
  if (owned.length === 0) owned.push(...STARTER_TRAILS);
  return [...new Set(owned)];
}

/**
 * Keep only ids the current catalog still ships, falling back to the starter
 * set when the claim is empty — same rule as the trails above.
 */
function normaliseOwnedColors(raw: unknown): string[] {
  const owned = Array.isArray(raw) ? raw.filter(isBodyColor) : [];
  if (owned.length === 0) owned.push(...STARTER_BODY_COLORS);
  return [...new Set(owned)];
}

/**
 * Keep only ids the current catalog still ships, falling back to the starter
 * set when the claim is empty — same rule as the trails and colours above.
 */
function normaliseOwnedHats(raw: unknown): string[] {
  const owned = Array.isArray(raw) ? raw.filter(isHat) : [];
  if (owned.length === 0) owned.push(...STARTER_HATS);
  return [...new Set(owned)];
}

/**
 * Keep only ids the current catalog still ships, falling back to the starter
 * set when the claim is empty — same rule as the trails, colours and hats.
 */
function normaliseOwnedGears(raw: unknown): string[] {
  const owned = Array.isArray(raw) ? raw.filter(isGear) : [];
  if (owned.length === 0) owned.push(...STARTER_GEARS);
  return [...new Set(owned)];
}

/** Room logging. Colyseus rooms have no logger of their own in 0.18. */
function log(message: string): void {
  console.info(`[race] ${message}`);
}
