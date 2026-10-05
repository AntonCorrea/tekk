/**
 * Client network session
 *
 * Owns the Colyseus connection and the whole prediction stack:
 *
 *   - YOUR racer   → `predict.sim(...)`. Applied locally the instant you press
 *                    a key, rewound and replayed when the server disagrees.
 *                    Zero input latency, at the cost of a rollback loop.
 *   - OTHER racers → `predict.attachAll('players', ...)`. Passively smoothed
 *                    toward whatever the server last sent. No prediction, no
 *                    rollback — you see other people a beat behind, which is
 *                    correct and cheap.
 *
 * The Rapier world on this side contains the course colliders and your own
 * capsule, and nothing else. Other racers are drawn from interpolated state
 * and are never simulated locally, so `world.step()` here advances exactly one
 * body — which is what makes it match the server's ordering.
 */

import { Client, Room } from '@colyseus/sdk';
import type { InputHandle } from '@colyseus/sdk';
import { Predict } from '@colyseus/sdk/predict';

import { FIXED_TIMESTEP } from '../constants.ts';
import { parseCourse } from '../shared/course.ts';
import type { Course } from '../shared/course.ts';
import { MoveInput, randomRacerName } from '../shared/input.ts';
import type { MoveInputData } from '../shared/input.ts';
import {
  applyInput,
  buildCourseColliders,
  createSimBody,
  type SimBody,
} from '../shared/sim.ts';
import { adoptTruth, readPose } from '../physics/player.ts';
import type { Pose } from '../physics/player.ts';
import type { GameStateInstance, PlayerStateInstance } from '../shared/state.ts';
import type { World } from '@dimforge/rapier3d-compat';
import type { RigidBody } from '@dimforge/rapier3d-compat';

/** The client room's view of the replicated state. */
type SessionRoom = Room<unknown, GameStateInstance>;

export interface SessionOptions {
  /** Where the game server is, e.g. `ws://localhost:2567`. */
  endpoint: string;
  /** Display name. A racer is anonymous but not nameless. */
  name?: string;
}

export interface Session {
  readonly room: SessionRoom;
  readonly course: Course;
  readonly predict: Predict<GameStateInstance>;
  readonly input: InputHandle<MoveInputData>;
  /** Your predicted capsule. `body.translation()` is where you actually are. */
  readonly sim: SimBody;
  readonly sessionId: string;

  /**
   * Drive one render frame: reconcile, then send this frame's inputs.
   *
   * Returns the number of fixed steps actually sent. Zero means the frame was
   * faster than the step rate and there is nothing to transmit — that is
   * normal at high refresh rates and must not be forced.
   */
  pump(now: number): number;

  /**
   * Interpolated, correction-smoothed render pose for YOUR racer.
   *
   * Call once per rendered frame, AFTER `pump()`. This is what the mesh and the
   * camera should follow — not `sim.body.translation()`.
   *
   * The distinction is the whole reason remotes look smooth and the local racer
   * did not: `adoptTruth` cuts the body straight to server truth on every
   * acknowledgement (~20/sec), so the raw body is discontinuous by design. The
   * reconciler interpolates between fixed steps and bleeds the correction off
   * over a few frames instead.
   */
  renderPose(): Pose;

  /** Authoritative state for your own racer, or undefined before the first patch. */
  self(): PlayerStateInstance | undefined;

  /** Interpolated render position for any racer, including your own. */
  positionOf(player: PlayerStateInstance): { x: number; y: number; z: number };

  leave(): Promise<void>;
}

/**
 * Join (or create) a race and wire prediction.
 *
 * `world` must already contain the course colliders — build them with the
 * shared `buildCourseColliders` from the same course definition the server
 * used, or the character controller will resolve disagreement between the two
 * worlds as a wall you cannot see.
 */
export async function connectSession(
  world: World,
  options: SessionOptions,
): Promise<Session> {
  const client = new Client(options.endpoint);

  const room = await client.joinOrCreate<GameStateInstance>('race', {
    name: options.name ?? randomRacerName(),
  });

  // --- wait for the authoritative course ---------------------------------
  // The state arrives asynchronously after join, so the course is not available
  // on the line below. Polling the field is the honest option here; the wait is
  // a single round trip and normally resolves immediately.
  const course = await waitForCourse(room);

  // --- course colliders ---------------------------------------------------
  // Built from the shared builder so the client's collision geometry is the
  // same function of the same data as the server's.
  const courseBody: RigidBody = buildCourseColliders(world, course);

  // --- your predicted body ------------------------------------------------
  const sim = createSimBody(world, course, FIXED_TIMESTEP);

  const predict = Predict.get(room, { mode: 'lerp', delay: 100 });

  // Other racers: smoothed server stream, rendered ~100ms in the past.
  predict.attachAll('players', { fields: ['x', 'y', 'z'], mode: 'lerp' });

  // WebSocket has no datagram channel, so `unreliable` would only add a
  // redundancy ring to an already-ordered stream. Reliable is the documented
  // choice for ws and every input arrives exactly once.
  const input = room.input<MoveInputData>({ type: MoveInput, mode: 'reliable' });

  // --- your racer: server-reconciled rollback over Rapier -----------------
  // The documented engine-backed shape. `world` holds two OPAQUE entries — a
  // Rapier world and our SimBody — so nothing is auto-bound and `adopt` is
  // mandatory: without a restore point, construction throws.
  //
  // The returned SimReconciler is kept, not discarded. It owns the render pose:
  // the prediction interpolated between fixed steps, plus a decaying offset that
  // absorbs each correction so mispredictions never pop. Reading the Rapier body
  // directly instead is what made the local racer jitter while remotes -- which
  // go through the same machinery via `predict.value` -- stayed smooth.
  const simReconciler = predict.sim({
    input,
    world: { world, sim },

    // SHARED with the server, via src/shared/sim.ts. Same function, same dt,
    // same order. If this ever stops being literally the server's call, the
    // symptom is permanent rubber-banding.
    step: (ctx, w, command) => {
      applyInput(w.sim, command, ctx.dt);
      w.world.step();
    },

    // Re-seed from the server's truth on every acknowledgement, BEFORE the
    // unacknowledged inputs replay on top.
    adopt: (w) => {
      const truth = room.state.players.get(room.sessionId);
      if (truth) adoptTruth(w.sim, truth);
    },

    // Render pose -- the numbers interpolation and smooth correction apply to.
    // Returned as an object literal rather than the named `Pose` interface: the
    // prediction signature wants an index-signature type, and an interface
    // without one is not assignable to it.
    pose: (w) => {
      const p = readPose(w.sim);
      return { x: p.x, y: p.y, z: p.z };
    },
  });

  const session: Session = {
    room,
    course,
    predict,
    input,
    sim,
    sessionId: room.sessionId,

    pump(now: number) {
      // Reconciles against any new server truth, then reports how many fixed
      // input steps this frame owes. Both are driven by this one call.
      return predict.tick(now);
    },

    renderPose() {
      // `pose()` returns a record the reconciler REUSES, so it has to be copied
      // before it outlives the frame that produced it.
      const p = simReconciler.pose();
      return { x: p.x, y: p.y, z: p.z };
    },

    self() {
      return room.state.players.get(room.sessionId);
    },

    positionOf(player: PlayerStateInstance) {
      return {
        x: predict.value(player, 'x'),
        y: predict.value(player, 'y'),
        z: predict.value(player, 'z'),
      };
    },

    async leave() {
      predict.dispose();
      world.removeRigidBody(courseBody);
      await room.leave();
    },
  };

  return session;
}

/**
 * Resolve once the room state carries a course.
 *
 * A rejected join would otherwise leave this hanging forever, so the disconnect
 * event breaks the wait and surfaces the real reason.
 */
function waitForCourse(room: SessionRoom): Promise<Course> {
  const existing = room.state?.courseJson;
  if (existing) return Promise.resolve(parseCourse(JSON.parse(existing), 'server'));

  return new Promise<Course>((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      room.onLeave.remove(onGone);
      fn();
    };

    // The state is a decoded schema, so there is no `onChange` hook on a plain
    // field. Polling is the escape hatch the SDK leaves for exactly this.
    const poll = setInterval(() => {
      const json = room.state?.courseJson;
      if (!json) return;
      finish(() => {
        try {
          resolve(parseCourse(JSON.parse(json), 'server'));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    }, 20);

    const onGone = (code: number): void => {
      finish(() => reject(new Error(`Disconnected before the course arrived (code ${code})`)));
    };

    room.onLeave.once(onGone);
  });
}