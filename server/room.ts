/**
 * The race room -- authoritative server
 *
 * This room owns: the course, the race clock, every racer's position, and the
 * finish order. Clients send intent and render state; they never decide where
 * anybody is.
 *
 * The determinism contract with the client is `src/shared/sim.ts`. This room
 * calls `applyInput` and `world.step()` exactly the way the client's
 * `predict.sim` callbacks do, in the same order, with the same dt. If those two
 * ever diverge, prediction produces constant rubber-banding and nothing throws,
 * so the timestep wiring below is deliberately loud about it.
 */

import type { Client } from '@colyseus/core';
import { Room } from '@colyseus/core';
import type { Delayed } from '@colyseus/timer';
import type { World } from '@dimforge/rapier3d-compat';

import { FIXED_TIMESTEP, PLAYER } from '../src/constants.ts';
import { hasReachedGoal } from '../src/game/race.ts';
import type { Course } from '../src/shared/course.ts';
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
import { GameState, PlayerState } from '../src/shared/state.ts';
import { createPhysicsWorld, initPhysics } from '../src/physics/world.ts';
import { loadCourse } from './course.ts';

/** Join options a client may send. */
export interface RaceJoinOptions {
  name?: string;
}

/** How long a finished race sits on the results before resetting. */
const RESULTS_HOLD_MS = 10_000;

/**
 * Room options, which is how the base class learns what this room is.
 *
 * `input` is what types `this.inputs`. Without it declared here the base class
 * types the property as `InputAPI<never>` and every read comes back `never`.
 */
interface RaceRoomOptions {
  input: MoveInputInstance;
  client: Client;
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
  private world!: World;
  private finishCounter = 0;
  private resultsTimer: Delayed | null = null;

  private readonly racers = new Map<string, SimBody>();

  override async onCreate(): Promise<void> {
    this.course = loadCourse();

    await initPhysics();
    this.world = createPhysicsWorld();
    buildCourseColliders(this.world, this.course);

    this.setState(new GameState());

    // The course definition, sent once. The client parses and validates it with
    // the same `parseCourse` the server used, then builds identical colliders
    // from it via the shared builder.
    this.state.courseJson = JSON.stringify(this.course);

    // 20 state patches/sec. Position is predicted locally, so this only carries
    // corrections and other racers -- it does not need to be frame-rate.
    this.patchRate = 50;

    this.setFixedTimestep((ctx) => this.simulate(ctx), 1 / FIXED_TIMESTEP);

    log(
      `race room "${this.course.id}" -- ${this.course.solids.length} solids, ` +
        `step ${(FIXED_TIMESTEP * 1000).toFixed(2)}ms`,
    );
  }

  override onJoin(client: Client, options?: RaceJoinOptions): void {
    const sim = createSimBody(this.world, this.course, FIXED_TIMESTEP);
    this.racers.set(client.sessionId, sim);

    const state = new PlayerState();
    state.name = sanitiseName(options?.name);

    const p = sim.body.translation();
    state.x = p.x;
    state.y = p.y;
    state.z = p.z;

    this.state.players.set(client.sessionId, state);

    log(`${state.name} joined (${this.state.players.size} racing)`);
  }

  override onLeave(client: Client): void {
    const sim = this.racers.get(client.sessionId);
    if (sim) {
      destroySimBody(this.world, sim);
      this.racers.delete(client.sessionId);
    }
    this.state.players.delete(client.sessionId);

    // If the last racer walked out mid-race there is nobody to reset for, but
    // the phase would otherwise stay stuck on 'finished' for whoever joins next.
    if (this.racers.size === 0 && this.state.phase !== 'ready') {
      this.resetRace();
    }

    log(`player left (${this.state.players.size} racing)`);
  }

  override onDispose(): void {
    this.cancelResultsReset();
    this.racers.clear();
  }

  // ------------------------------------------------------------ simulation

  /**
   * One authoritative fixed step.
   *
   * `ctx.dt` is the step the clients predict at, cascaded through the join
   * handshake from `defineInput({ stepSeconds })`. It is assigned to the Rapier
   * world rather than read from a constant so the engine can never silently
   * disagree with the input rate.
   */
  private simulate(ctx: { dt: number }): void {
    const dt = ctx.dt;
    this.world.timestep = dt;

    let anyoneMoving = false;

    // --- integrate every racer, then advance the world exactly once --------
    // Order matters. One solver step moves every body together, so each racer
    // gets exactly one input per tick. That is why this loop uses `next()`
    // rather than draining the buffer: draining would apply every buffered
    // input, then advance the ack past inputs the server never simulated, which
    // snaps the client's reconciler.
    for (const [sessionId, sim] of this.racers) {
      const input = this.inputs.get(sessionId).next() ?? idleInput();
      if (input.moveX !== 0 || input.moveZ !== 0) anyoneMoving = true;
      applyInput(sim, input, dt);
    }

    this.world.step();

    // --- clock ------------------------------------------------------------
    const elapsedMs = this.tickClock(anyoneMoving);
    this.state.elapsedMs = elapsedMs;

    // --- publish ----------------------------------------------------------
    // The clock only means something while the race is actually running. Both
    // the finish test and the round-close test are gated on this: a racer who
    // wanders across the goal during 'ready' or 'finished' has not run a timed
    // lap, and banking a time then would record 0.00s against a frozen clock.
    const racing = this.state.phase === 'running';
    let stillRacing = 0;

    for (const [sessionId, sim] of this.racers) {
      const state = this.state.players.get(sessionId);
      if (!state) continue;

      // Falling is handled inside `applyInput`, on both sides, so there is no
      // teleport to publish here. A racer who fell is still RACING -- counting
      // only finished racers is a bug that lets one missed jump close the race
      // for the whole room.
      if (racing && state.finishedMs < 0) stillRacing++;

      const p = sim.body.translation();
      state.x = p.x;
      state.y = p.y;
      state.z = p.z;
      state.vx = sim.velocity.x;
      state.vy = sim.velocity.y;
      state.vz = sim.velocity.z;
      state.grounded = sim.grounded;
      state.speed = sim.horizontalSpeed;

      if (racing && state.finishedMs < 0) {
        if (hasReachedGoal(p, PLAYER.radius, PLAYER.halfHeight, this.course.goal)) {
          state.finishedMs = elapsedMs;
          state.place = ++this.finishCounter;
          log(`${state.name} finished in ${(elapsedMs / 1000).toFixed(2)}s`);
        }
      }
    }

    // The round closes when everyone still in the room has crossed the line, so
    // a fast racer never has their time cut off by a slow one.
    if (racing && stillRacing === 0 && this.racers.size > 0) {
      this.closeRace();
    }
  }

  /**
   * The authoritative race clock.
   *
   * Returns the elapsed race time and freezes it once the round closes, so the
   * replicated `elapsedMs` holds the final time rather than decaying to zero.
   * That matters because it is a public field: a client that reads it after the
   * finish would otherwise see a clock that went backwards.
   *
   * Per-player `finishedMs` is the lap time; this is the room clock. They agree
   * for whoever crossed first, which is the number the winner is given.
   */
  private tickClock(anyoneMoving: boolean): number {
    if (this.state.phase === 'finished') return this.state.elapsedMs;

    const now = this.clock.elapsedTime;

    if (this.state.phase === 'ready') {
      if (!anyoneMoving) return 0;
      this.state.phase = 'running';
      this.state.startedAtMs = now;
      log('race started');
      return 0;
    }

    return now - this.state.startedAtMs;
  }

  private closeRace(): void {
    // Idempotent. `simulate` runs every tick and re-arms this timer each time,
    // so without the guard a racer idling past the goal would hold the results
    // screen open forever.
    if (this.state.phase === 'finished') return;

    this.state.phase = 'finished';
    log('race closed -- resetting shortly');

    this.cancelResultsReset();
    this.resultsTimer = this.clock.setTimeout(() => {
      this.resultsTimer = null;
      this.resetRace();
    }, RESULTS_HOLD_MS);
  }

  private cancelResultsReset(): void {
    // `Delayed.clear()` cancels one timer. `clock.clear()` would drop every
    // pending timer on the room, which is not ours to do.
    this.resultsTimer?.clear();
    this.resultsTimer = null;
  }

  private resetRace(): void {
    for (const [sessionId, sim] of this.racers) {
      moveSimBody(sim, sim.respawn.x, sim.respawn.y, sim.respawn.z);

      const state = this.state.players.get(sessionId);
      if (!state) continue;

      const p = sim.body.translation();
      state.x = p.x;
      state.y = p.y;
      state.z = p.z;
      state.vx = 0;
      state.vy = 0;
      state.vz = 0;
      state.grounded = false;
      state.speed = 0;
      state.finishedMs = -1;
      state.place = 0;
    }

    this.state.phase = 'ready';
    this.state.startedAtMs = 0;
    this.state.elapsedMs = 0;
    this.finishCounter = 0;
    log('race reset');
  }
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