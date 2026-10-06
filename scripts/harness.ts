/**
 * Day 3 verification harness.
 *
 * Three things get checked, in increasing order of how much they prove:
 *
 *   A. Determinism. Two worlds built by the shared builder, run through the
 *      same input script, must agree to the last bit. This is the claim the
 *      entire prediction design rests on.
 *   B. Rollback. A client that re-seeds from server truth and replays the
 *      unacknowledged inputs must land exactly where the server did. This is
 *      the claim that makes rollback invisible.
 *   C. Rules. The Core Rush decisions (pickup, steal, ranking, match clock)
 *      as pure functions, every tie-break pinned without a network.
 *   D. Wire. A real Colyseus server and two real SDK clients, in one process:
 *      schema encode/decode, input transport, sanitize, the phase flow, a
 *      pickup up the dais, a dash steal, a drop on leave, results and reset.
 *
 * Run it more than once. An earlier version of the wire suite gave its
 * end-to-end autopilot a flat 15s wall-clock budget, which made the whole
 * harness a measurement of machine load. The lesson carries over: the match
 * clock now counts server ticks rather than wall time, and every wire wait
 * polls for the state it needs instead of sleeping a fixed amount and hoping.
 */
import { Client } from '@colyseus/sdk';

import { loadCourse } from '../server/course.ts';
import { createPhysicsWorld, initPhysics } from '../src/physics/world.ts';
import { adoptTruth } from '../src/physics/player.ts';
import {
  applyInput,
  buildCourseColliders,
  createSimBody,
  respawnFeet,
  type SimBody,
} from '../src/shared/sim.ts';
import { MoveInput } from '../src/shared/input.ts';
import type { MoveInputData } from '../src/shared/input.ts';
import { PlayerState } from '../src/shared/state.ts';
import { CORE, DASH, FIXED_TIMESTEP, MATCH, MOVE, PLAYER } from '../src/constants.ts';
import {
  advancePhase,
  chooseStealer,
  choosePickup,
  DEFAULT_TIMINGS,
  rankStandings,
  resolveTimings,
  type Challenger,
  type PhaseClock,
  type RacerPoint,
} from '../server/rules.ts';

type Course = ReturnType<typeof loadCourse>;

let pass = 0;
let fail = 0;
let skipped = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`);
  }
}

/**
 * Record a check whose precondition did not hold, so it is neither passed nor
 * failed.
 *
 * Several checks are downstream of the autopilot actually finishing. When it
 * does not, `phase` correctly stays `running`, the results hold never begins,
 * and the auto-reset never fires -- so those checks FAIL for no reason of their
 * own. One root cause then reports as three defects, which overstates the damage
 * and buries the real signal. Skipped checks keep the tally honest about how
 * much was actually verified.
 */
function skip(label: string, why: string): void {
  skipped++;
  console.log(`  SKIP  ${label}  (${why})`);
}

const input = (moveX: number, moveZ: number, dash = false, jump = false): MoveInputData => ({
  moveX,
  moveZ,
  dash,
  jump,
});

/**
 * A deterministic, non-trivial input script: run, strafe, jump, idle, back,
 * and three dash windows that each exercise a different rule.
 *
 *   t 10..12   dash along the stick (forward).
 *   t 102..104 dash with NO stick, during the idle stretch: the direction has
 *              to come from the momentum the strafe left behind.
 *   t 186..188 diagonal dash. The t 102 dash ended at 111, so the cooldown
 *              has just expired.
 *
 * In the second 200-step cycle the t 10 window lands inside the t 186
 * cooldown, so the script also holds dash while it must NOT fire.
 */
function scriptAt(step: number): MoveInputData {
  const t = step % 200;
  if (t < 60) return input(0, -1, t >= 10 && t <= 12, t === 30);
  if (t < 100) return input(1, 0, false, false);
  if (t < 120) return input(0, 0, t >= 102 && t <= 104, false);
  if (t < 160) return input(-1, 0, false, t === 140);
  if (t < 180) return input(0, 1, false, t === 165);
  return input(0.7, -0.7, t >= 186 && t <= 188, t === 195);
}

/**
 * A course world holding one racer, or several. `others` are created BEFORE
 * the racer under test, so its body and collider handles differ from a
 * lone-racer world -- the pass-through check would otherwise be comparing two
 * worlds that differ only in an object nobody touches.
 */
function makeWorld(course: Course, others = 0) {
  const world = createPhysicsWorld();
  buildCourseColliders(world, course);
  const extra: SimBody[] = [];
  for (let i = 0; i < others; i++) extra.push(createSimBody(world, course, FIXED_TIMESTEP));
  const sim = createSimBody(world, course, FIXED_TIMESTEP);
  return { world, sim, extra };
}

const snap = (sim: SimBody) => {
  const t = sim.body.translation();
  return {
    x: t.x,
    y: t.y,
    z: t.z,
    vx: sim.velocity.x,
    vy: sim.velocity.y,
    vz: sim.velocity.z,
    grounded: sim.grounded,
    speed: sim.horizontalSpeed,
    dashTicks: sim.dashTicks,
    dashCooldownTicks: sim.dashCooldownTicks,
  };
};
type Snap = ReturnType<typeof snap>;

function identical(a: Snap, b: Snap): boolean {
  return (
    a.x === b.x && a.y === b.y && a.z === b.z &&
    a.vx === b.vx && a.vy === b.vy && a.vz === b.vz &&
    a.grounded === b.grounded && a.speed === b.speed &&
    a.dashTicks === b.dashTicks && a.dashCooldownTicks === b.dashCooldownTicks
  );
}

/** Run `steps` steps of `script` on a fresh one-racer world; returns every snap. */
function record(course: Course, steps: number, script: (step: number) => MoveInputData, carrying = false) {
  const w = makeWorld(course);
  w.sim.carrying = carrying;
  const log: Snap[] = [];
  for (let step = 0; step < steps; step++) {
    applyInput(w.sim, script(step), FIXED_TIMESTEP);
    w.world.step();
    log.push(snap(w.sim));
  }
  return log;
}

// ============================================================== A: determinism

async function testDeterminism(course: Course) {
  console.log('\n=== A. shared step determinism ===');

  const STEPS = 400;
  const a = makeWorld(course);
  const b = makeWorld(course);

  let firstDivergence = -1;
  let last: Snap | null = null;

  for (let step = 0; step < STEPS; step++) {
    const cmd = scriptAt(step);
    for (const side of [a, b]) {
      // Same call, same dt, same order on both sides.
      applyInput(side.sim, cmd, FIXED_TIMESTEP);
      side.world.step();
    }
    const sa = snap(a.sim);
    const sb = snap(b.sim);
    if (!identical(sa, sb) && firstDivergence === -1) firstDivergence = step;
    last = sa;
  }

  check(
    `400 steps (with dashes) agree bit-for-bit across two worlds`,
    firstDivergence === -1,
    firstDivergence === -1 ? `final z=${last!.z.toFixed(6)}` : `diverged at step ${firstDivergence}`,
  );

  // Rapier stores the timestep as an f32 internally, so reading it back gives
  // the f32-rounded value rather than the f64 we assigned. That is fine and
  // symmetric -- both sides round identically, which is why the bit-for-bit
  // check above passes -- but a strict `===` against 1/60 would never hold.
  check(
    'world.timestep is the dt we assigned, within f32 precision',
    Math.abs(a.world.timestep - FIXED_TIMESTEP) < 1e-9 &&
      Math.abs(b.world.timestep - FIXED_TIMESTEP) < 1e-9,
    `timestep=${a.world.timestep} vs dt=${FIXED_TIMESTEP}`,
  );

  // Repeating the same script from a fresh world must reproduce the same run.
  // Without this, "identical" could just mean a shared mutable default.
  const run = record(course, STEPS, scriptAt);
  check('a fresh world replays the run exactly', identical(snap(a.sim), run[STEPS - 1]!));

  // The run must actually have gone somewhere. A test where everything is 0
  // passes trivially, so assert the capsule really travelled, jumped and
  // dashed. Net displacement is small because the script strafes and
  // reverses, so measure the furthest point reached rather than the final one.
  const minZ = Math.min(...run.map((s) => s.z));
  const maxZ = Math.max(...run.map((s) => s.z));
  const peakY = Math.max(...run.map((s) => s.y));
  const peakDash = Math.max(...run.map((s) => s.dashTicks));
  const peakSpeed = Math.max(...run.map((s) => s.speed));
  const dashStarts = run.filter((s, i) => s.dashTicks === DASH.durationTicks - 1 &&
    (i === 0 || run[i - 1]!.dashTicks === 0)).length;
  check(
    'the capsule actually travelled along the lane',
    maxZ - minZ > 15,
    `z span ${minZ.toFixed(2)} .. ${maxZ.toFixed(2)}`,
  );
  check('the capsule actually left the ground', peakY > 1.2, `peak y=${peakY.toFixed(2)}`);
  check(
    'the script really dashed, past run speed',
    peakDash > 0 && peakSpeed > MOVE.runSpeed + 5,
    `${dashStarts} dash(es), peak dashTicks=${peakDash}, peak speed=${peakSpeed.toFixed(2)} ` +
      `(run ${MOVE.runSpeed}, dash ${DASH.speed})`,
  );
  // Three windows per 200 steps, minus the cycle-2 t 10 window that falls
  // inside the t 186 cooldown: 3 + 2 = 5 over 400 steps.
  check('held dash inside a cooldown does not fire', dashStarts === 5, `${dashStarts} starts, expected 5`);

  // The no-stick dash at t 102 must have borrowed the strafe's +X momentum.
  const borrowed = run[102]!;
  check(
    'a dash with no stick input takes the direction of momentum',
    borrowed.dashTicks > 0 && borrowed.vx === DASH.speed && borrowed.vz === 0,
    `step 102: dashTicks=${borrowed.dashTicks} v=(${borrowed.vx.toFixed(3)}, ${borrowed.vz.toFixed(3)})`,
  );

  testDashTiming(course);
  testPassThrough(course);
  testCarrying(course);
}

/**
 * Hold forward + dash from a standstill and read the counters off every step.
 * The tick arithmetic is the contract the server and HUD read, so pin it.
 */
function testDashTiming(course: Course) {
  const STEPS = 2 * (DASH.durationTicks + DASH.cooldownTicks) + 5;
  // Pushing into the start pad's right rail: the body stays on the pad for the
  // whole run (a fall would respawn and reset the counters), and a wall does
  // not change the hand-integrated velocity, so the speeds read clean.
  const log = record(course, STEPS, () => input(1, 0, true, false));

  const starts = log
    .map((s, i) => (s.dashTicks > 0 && (i === 0 || log[i - 1]!.dashTicks === 0) ? i : -1))
    .filter((i) => i >= 0);
  // Published `dashTicks` is "steps still to fly" after the step, so the last
  // dash step publishes 0. Count the steps that actually flew at dash speed.
  const firstLen = log.slice(starts[0]).findIndex((s) => s.speed !== DASH.speed);
  const period = starts[1]! - starts[0]!;

  check(
    'a dash lasts exactly DASH.durationTicks steps at DASH.speed',
    starts[0] === 0 && firstLen === DASH.durationTicks &&
      log.slice(0, DASH.durationTicks).every((s) => s.speed === DASH.speed),
    `started step ${starts[0]}, flew ${firstLen} steps`,
  );
  check(
    'held dash re-fires after exactly DASH.cooldownTicks idle steps',
    period === DASH.durationTicks + DASH.cooldownTicks,
    `period ${period} = ${DASH.durationTicks} dash + ${period - DASH.durationTicks} cooldown`,
  );
  check(
    'the dash ends at DASH.speed and run speed takes back over',
    log[DASH.durationTicks + 30]!.speed === MOVE.runSpeed,
    `speed ${log[DASH.durationTicks + 30]!.speed} 30 steps after`,
  );

  // Standing still with no stick: nothing to aim at, so no dash and no
  // cooldown spent.
  const idle = record(course, 30, () => input(0, 0, true, false));
  check(
    'dash with no stick and no momentum does nothing and costs nothing',
    idle.every((s) => s.dashTicks === 0 && s.dashCooldownTicks === 0 && s.speed === 0),
  );
}

/**
 * Racers pass through each other.
 *
 * The server holds every capsule in one world; the client holds only its own.
 * So the only way the client can predict the server is if a body's path in a
 * crowd is bit-identical to its path alone. Two other racers are spawned
 * INSIDE it (everyone shares the spawn) and then driven straight back through
 * it, while the body under test runs the dash script.
 */
function testPassThrough(course: Course) {
  const STEPS = 400;
  const alone = record(course, STEPS, scriptAt);

  const crowd = makeWorld(course, 2);
  const [rivalA, rivalB] = crowd.extra as [SimBody, SimBody];
  let firstDivergence = -1;
  let closest = Infinity;

  for (let step = 0; step < STEPS; step++) {
    // Server order: every racer integrated, then one world step.
    applyInput(rivalA, input(0, step < 60 ? -1 : 1, step % 90 === 20, step % 50 === 0), FIXED_TIMESTEP);
    applyInput(crowd.sim, scriptAt(step), FIXED_TIMESTEP);
    // Two steps ahead on the same script: a different path, but one that keeps
    // crossing the body under test at any tuning of run and dash speed.
    applyInput(rivalB, scriptAt(step + 2), FIXED_TIMESTEP);
    crowd.world.step();

    // Everyone starts overlapped on the shared spawn, which proves little on
    // its own; only count crossings after they have spread out.
    const me = crowd.sim.body.translation();
    if (step >= 60) for (const rival of [rivalA, rivalB]) {
      const r = rival.body.translation();
      closest = Math.min(closest, Math.hypot(me.x - r.x, me.y - r.y, me.z - r.z));
    }
    if (firstDivergence === -1 && !identical(snap(crowd.sim), alone[step]!)) firstDivergence = step;
  }

  check(
    'a racer among others moves exactly as it does alone',
    firstDivergence === -1,
    firstDivergence === -1 ? `400 steps identical` : `diverged at step ${firstDivergence}`,
  );
  // Without this the check above could pass because the rivals never came
  // near: assert their capsules really overlapped the body under test.
  check(
    'the rivals really passed through it',
    closest < PLAYER.radius,
    `closest centre distance after step 60: ${closest.toFixed(3)} (capsule radius ${PLAYER.radius})`,
  );
}

/** The carrier is slower and cannot dash. */
function testCarrying(course: Course) {
  const carrierTop = MOVE.runSpeed * CORE.carrierSpeedFactor;
  const log = record(course, 120, () => input(1, 0, true, false), true);
  const peak = Math.max(...log.map((s) => s.speed));
  check(
    'a carrier holding dash never dashes',
    log.every((s) => s.dashTicks === 0 && s.dashCooldownTicks === 0),
  );
  check(
    'a carrier tops out at the reduced speed',
    peak === carrierTop,
    `peak ${peak} (run ${MOVE.runSpeed} x ${CORE.carrierSpeedFactor} = ${carrierTop})`,
  );
}

// ================================================================ B: rollback

/**
 * The client's restore point, built the way the server publishes it: a real
 * PlayerState, written from the server body after its step.
 */
function truthOf(s: Snap) {
  const truth = new PlayerState();
  truth.x = s.x;
  truth.y = s.y;
  truth.z = s.z;
  truth.vx = s.vx;
  truth.vy = s.vy;
  truth.vz = s.vz;
  truth.grounded = s.grounded;
  truth.speed = s.speed;
  truth.dashTicks = s.dashTicks;
  truth.dashCooldownTicks = s.dashCooldownTicks;
  return truth;
}

/**
 * The client mispredicts up to `ack` (it runs `clientScript`, which differs
 * from what the server got), then a correction lands: it adopts server truth
 * for step `ack` through the real `adoptTruth` and replays the true inputs
 * ack+1..ack+horizon. Returns where it lands, against where the server was.
 *
 * `forget` drops the dash counters after adopting, to prove they matter.
 */
function rollback(
  course: Course,
  history: Snap[],
  ack: number,
  horizon: number,
  clientScript: (step: number) => MoveInputData,
  forget = false,
) {
  const client = makeWorld(course);
  for (let step = 0; step <= ack; step++) {
    applyInput(client.sim, clientScript(step), FIXED_TIMESTEP);
    client.world.step();
  }
  const stale = { dashTicks: client.sim.dashTicks, cd: client.sim.dashCooldownTicks };

  adoptTruth(client.sim, truthOf(history[ack]!), false);
  if (forget) {
    client.sim.dashTicks = stale.dashTicks;
    client.sim.dashCooldownTicks = stale.cd;
  }

  for (let replay = ack + 1; replay <= ack + horizon; replay++) {
    applyInput(client.sim, scriptAt(replay), FIXED_TIMESTEP);
    client.world.step();
  }
  return { client: snap(client.sim), server: history[ack + horizon]!, stale };
}

async function testRollback(course: Course) {
  console.log('\n=== B. rollback reproduces the server ===');

  // The server's full run, recorded.
  const history = record(course, 400, scriptAt);

  // 1. The original case: a quiet stretch, client predicted the same inputs.
  {
    const r = rollback(course, history, 200, 12, scriptAt);
    check(
      'replay from server truth lands on the server trajectory',
      identical(r.client, r.server),
      `step 212: z=${r.client.z.toFixed(6)} vs ${r.server.z.toFixed(6)}`,
    );
  }

  // 2. Mid-dash, after a misprediction. The client never saw the dash input
  //    (it predicted plain running), so at the ack it has no dash, the wrong
  //    velocity and the wrong position. Truth is a few ticks into the t 10
  //    forward dash down the open lane; the replay must fly the remaining
  //    ticks, end the dash, start the cooldown and land exactly on the server.
  const noDash = (step: number) => ({ ...scriptAt(step), dash: false });
  const ACK = 13;
  const HORIZON = 20;
  check(
    'the rollback point really is mid-dash',
    history[ACK]!.dashTicks > 0 && history[ACK + HORIZON]!.dashTicks === 0 &&
      history[ACK + HORIZON]!.dashCooldownTicks > 0,
    `truth dashTicks=${history[ACK]!.dashTicks}, ` +
      `after replay cooldown=${history[ACK + HORIZON]!.dashCooldownTicks}`,
  );
  {
    const r = rollback(course, history, ACK, HORIZON, noDash);
    check(
      'mid-dash rollback from a mispredicted client lands on the server',
      identical(r.client, r.server) && r.stale.dashTicks === 0,
      `client predicted dashTicks=${r.stale.dashTicks}; step ${ACK + HORIZON}: ` +
        `z=${r.client.z.toFixed(6)} vs ${r.server.z.toFixed(6)}, ` +
        `cooldown ${r.client.dashCooldownTicks} vs ${r.server.dashCooldownTicks}`,
    );
  }
  {
    // The bad case: position and velocity adopted, dash counters not. The
    // replay no longer holds the dash, accel pulls the speed back to a run,
    // and the client ends up somewhere the server never was. Compared on
    // POSITION, not the full snapshot, so the counters themselves differing
    // cannot pass this on their own.
    const r = rollback(course, history, ACK, HORIZON, noDash, true);
    check(
      'without the dash counters the same replay lands elsewhere (negative control)',
      r.client.z !== r.server.z,
      `z=${r.client.z.toFixed(4)} vs server ${r.server.z.toFixed(4)}`,
    );
  }

  // 3. Mid-dash INTO A WALL. The t 102 momentum dash drives +X into the start
  //    pad's right rail. This is the case that caught `adoptTruth` moving the
  //    body but not its collider: the first replayed sweep ran from the
  //    client's mispredicted spot, missed the rail, and the client finished
  //    inside it. Kept as the regression guard for that.
  {
    const r = rollback(course, history, 105, 20, noDash);
    check(
      'mid-dash rollback against a wall lands on the server',
      identical(r.client, r.server),
      `step 125: x=${r.client.x.toFixed(6)} vs ${r.server.x.toFixed(6)} ` +
        `(rail stops the centre at x=5.6)`,
    );
  }

  // 4. Mid-cooldown: the client wrongly predicted a SECOND dash fired (its
  //    script held dash during the cooldown and it thought the cooldown was
  //    over). Truth restores the cooldown, and the replay must not dash.
  {
    const ack2 = 150;
    const eager = (step: number) => ({ ...scriptAt(step), dash: step >= 140 });
    // `eager` skips the t 10 and t 102 dashes, so its cooldown is clear at 140
    // and it fires a dash the server, still cooling down from t 102, never did.
    const r = rollback(course, history, ack2, 30, eager);
    check(
      'mid-cooldown rollback lands on the server',
      identical(r.client, r.server),
      `client predicted dashTicks=${r.stale.dashTicks} cooldown=${r.stale.cd}, ` +
        `truth cooldown=${history[ack2]!.dashCooldownTicks}; step ${ack2 + 30}: ` +
        `z=${r.client.z.toFixed(6)} vs ${r.server.z.toFixed(6)}`,
    );
  }
}

// ==================================================================== C: rules

/**
 * The Core Rush rules as pure functions, with no network and no physics.
 * Every tie-break is pinned here, because on the wire ties are too rare to
 * observe and too consequential to leave to Map iteration order.
 */
function testRules(course: Course) {
  console.log('\n=== C. Core Rush rules (pure) ===');

  const at = (id: string, x: number, y = 0, z = 0): RacerPoint => ({ id, x, y, z });
  const dashing = (id: string, x: number, d = true): Challenger => ({ id, x, y: 0, z: 0, dashing: d });
  const core = { x: 0, y: 0, z: 0 };

  // --- pickup -----------------------------------------------------------
  check('pickup: nobody in range takes nothing',
    choosePickup(core, [at('a', 2), at('b', -1.3)], CORE.pickupRadius) === '');
  check('pickup: the nearest racer in range takes it',
    choosePickup(core, [at('a', 1.0), at('b', 0.5), at('c', 3)], CORE.pickupRadius) === 'b');
  check('pickup: distance is 3D, not just horizontal',
    choosePickup(core, [at('a', 0.1, 1.5)], CORE.pickupRadius) === '');
  check('pickup: the radius is inclusive',
    choosePickup(core, [at('a', CORE.pickupRadius)], CORE.pickupRadius) === 'a');
  check('pickup: an exact tie goes to the lowest sessionId, whatever the order',
    choosePickup(core, [at('zed', 0.5), at('amy', -0.5)], CORE.pickupRadius) === 'amy' &&
      choosePickup(core, [at('amy', -0.5), at('zed', 0.5)], CORE.pickupRadius) === 'amy');

  // --- steal ------------------------------------------------------------
  const carrier = at('car', 0);
  check('steal: a dashing racer in range takes it',
    chooseStealer(carrier, [dashing('car', 0), dashing('t', 1.0)], CORE.stealRadius, 0) === 't');
  check('steal: running through the carrier without a dash takes nothing',
    chooseStealer(carrier, [dashing('t', 0.2, false)], CORE.stealRadius, 0) === '');
  check('steal: a dash out of range takes nothing',
    chooseStealer(carrier, [dashing('t', CORE.stealRadius + 0.01)], CORE.stealRadius, 0) === '');
  check('steal: immunity blocks a dash that would otherwise steal',
    chooseStealer(carrier, [dashing('t', 0.3)], CORE.stealRadius, 1) === '');
  check('steal: the carrier cannot steal from itself mid-dash',
    chooseStealer(carrier, [dashing('car', 0)], CORE.stealRadius, 0) === '');
  check('steal: nearest dasher wins, then lowest sessionId',
    chooseStealer(carrier, [dashing('far', 1.2), dashing('near', 0.6)], CORE.stealRadius, 0) === 'near' &&
      chooseStealer(carrier, [dashing('yy', -0.6), dashing('bb', 0.6)], CORE.stealRadius, 0) === 'bb');
  check('steal: a non-dashing racer closer than the dasher does not shadow it',
    chooseStealer(carrier, [dashing('idle', 0.1, false), dashing('dash', 1.0)], CORE.stealRadius, 0) === 'dash');

  // --- ranking ------------------------------------------------------------
  const ranked = rankStandings([
    { id: 'a', holdMs: 5000, lastHeldAtMs: 10_000 },
    { id: 'b', holdMs: 9000, lastHeldAtMs: 20_000 },
    { id: 'c', holdMs: 5000, lastHeldAtMs: 90_000 },
    { id: 'd', holdMs: 0, lastHeldAtMs: -1 },
  ]);
  check('ranking: most hold time first; a tie goes to whoever held it last',
    ranked.order.join(',') === 'b,c,a,d' && ranked.winnerId === 'b', ranked.order.join(','));
  const fullTie = rankStandings([
    { id: 'q', holdMs: 3000, lastHeldAtMs: 50_000 },
    { id: 'p', holdMs: 3000, lastHeldAtMs: 50_000 },
  ]);
  check('ranking: a complete tie falls to the lowest sessionId', fullTie.order.join(',') === 'p,q');
  const nobody = rankStandings([
    { id: 'a', holdMs: 0, lastHeldAtMs: -1 },
    { id: 'b', holdMs: 0, lastHeldAtMs: -1 },
  ]);
  check('ranking: nobody wins when nobody held the Core',
    nobody.winnerId === '' && nobody.order.length === 2);
  check('ranking: an empty room has no winner', rankStandings([]).winnerId === '');

  // --- match clock ----------------------------------------------------------
  const dtMs = FIXED_TIMESTEP * 1000;
  const t = DEFAULT_TIMINGS;
  {
    const idle = advancePhase({ phase: 'ready', ticks: 0 }, false, dtMs, t);
    const moved = advancePhase({ phase: 'ready', ticks: 0 }, true, dtMs, t);
    check('clock: ready waits for movement and reports 0 remaining',
      idle.entered === null && idle.clock.phase === 'ready' && idle.remainingMs === 0);
    check('clock: movement in ready enters the countdown',
      moved.entered === 'countdown' && moved.remainingMs === MATCH.countdownMs);
  }
  {
    // Run each timed phase tick by tick and count exactly how long it lasts.
    const lengthInTicks = (phase: 'countdown' | 'playing' | 'results') => {
      let clock: PhaseClock = { phase, ticks: 0 };
      for (let n = 1; n < 100_000; n++) {
        const step = advancePhase(clock, false, dtMs, t);
        if (step.entered) return { n, next: step.entered };
        clock = step.clock;
      }
      return { n: -1, next: null };
    };
    const cd = lengthInTicks('countdown');
    const pl = lengthInTicks('playing');
    const rs = lengthInTicks('results');
    check('clock: each phase lasts exactly its MATCH length in fixed ticks',
      cd.n === MATCH.countdownMs / dtMs && pl.n === Math.round(MATCH.durationMs / dtMs) &&
        rs.n === Math.round(MATCH.resultsMs / dtMs),
      `countdown ${cd.n}, playing ${pl.n}, results ${rs.n} ticks`);
    check('clock: countdown -> playing -> results -> ready',
      cd.next === 'playing' && pl.next === 'results' && rs.next === 'ready');
  }
  check('timings: production defaults are the MATCH constants',
    resolveTimings(undefined).durationMs === MATCH.durationMs &&
      resolveTimings({}).countdownMs === MATCH.countdownMs);
  {
    let threw = false;
    try {
      resolveTimings({ durationMs: 0 });
    } catch {
      threw = true;
    }
    check('timings: a zero-length phase is rejected', threw);
  }

  // --- the dash flag the steal rule reads ----------------------------------
  // `dashTicks` publishes 0 after the last dash step, so the steal rule reads
  // `dashedThisStep` instead. Pin that it covers every flying step exactly.
  {
    const w = makeWorld(course);
    const flags: { flew: boolean; ticksAfter: number }[] = [];
    for (let step = 0; step < DASH.durationTicks + 5; step++) {
      applyInput(w.sim, input(0, -1, true, false), FIXED_TIMESTEP);
      w.world.step();
      flags.push({ flew: w.sim.dashedThisStep, ticksAfter: w.sim.dashTicks });
    }
    const flew = flags.filter((f) => f.flew).length;
    const last = flags[DASH.durationTicks - 1]!;
    check('sim: dashedThisStep is true on every dash step, including the last',
      flew === DASH.durationTicks && last.flew && last.ticksAfter === 0 &&
        !flags[DASH.durationTicks]!.flew,
      `${flew} flagged steps; last dash step published dashTicks=${last.ticksAfter}`);
  }
}

// ==================================================================== D: wire

/**
 * Short phases for the wire suite. The production MATCH timings would make one
 * match take two minutes. Passed through `createGameServer`, i.e. at define
 * time, which is the only path that can set them -- see server/index.ts.
 *
 * The countdown is long enough to sample a racer running during it, and the
 * match long enough to fit a pickup, the 1.5s steal immunity, a steal and a
 * drop with room for a loaded machine.
 */
const WIRE_TIMINGS = { countdownMs: 1500, durationMs: 16_000, resultsMs: 1500 };

async function testWire(course: Course) {
  console.log('\n=== D. live server + SDK clients ===');

  // Use the real bootstrap, not a stand-in. The HTTP handler is part of what
  // is under test: a well-meaning catch-all in either place collides with
  // Colyseus' own listener and only shows up at join time.
  const { createGameServer } = await import('../server/index.ts');

  const PORT = 25670 + Math.floor(Math.random() * 400);
  const { gameServer } = createGameServer({ matchTimings: WIRE_TIMINGS });
  await gameServer.listen(PORT, '127.0.0.1');

  check('server boots and listens', true, `port ${PORT}`);

  // Regression guard for a crash a browser caused and this harness did not.
  // Opening the page makes the browser GET `/` BEFORE any matchmaking call, and
  // a server-side handler answering that request used to kill the process via
  // ERR_HTTP_HEADERS_SENT. These are exactly the requests a real client makes.
  for (const path of ['/', '/health', '/favicon.ico']) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
      check(`survives a plain GET ${path}`, true, `HTTP ${res.status}`);
    } catch (err) {
      check(`survives a plain GET ${path}`, false, String(err).slice(0, 140));
    }
  }

  const client = new Client(`ws://localhost:${PORT}`);
  // A client-supplied `timings` must be ignored: define-time options win.
  const roomA = await client.joinOrCreate('race', { name: 'HarnessOtter', timings: { durationMs: 1 } });
  const roomB = await client.joinOrCreate('race', { name: 'HarnessLynx' });
  check('two clients join the same room',
    !!roomA.sessionId && !!roomB.sessionId && roomA.roomId === roomB.roomId,
    `A=${roomA.sessionId.slice(0, 6)} B=${roomB.sessionId.slice(0, 6)}`);

  const A = roomA.sessionId;
  const B = roomB.sessionId;
  // Every read goes through A's view of the room; B only sends input.
  const s = () => roomA.state;
  const me = (id: string) => roomA.state.players.get(id);

  // --- the course arrives -------------------------------------------------
  let courseJson = '';
  for (let i = 0; i < 100 && !courseJson; i++) {
    courseJson = roomA.state?.courseJson ?? '';
    if (!courseJson) await sleep(20);
  }
  check('server ships the course to the client', courseJson.length > 0, `${courseJson.length} bytes`);

  const { parseCourse } = await import('../src/shared/course.ts');
  let received: Course | null = null;
  try {
    received = parseCourse(JSON.parse(courseJson), 'server');
  } catch (err) {
    check('client can validate the received course', false, String(err).slice(0, 120));
  }
  check(
    'client validates the course, it matches the server file, and it has a coreSpawn',
    received !== null &&
      JSON.stringify(received) === JSON.stringify(course) &&
      Array.isArray(received.coreSpawn) &&
      received.coreSpawn.join(',') === course.coreSpawn!.join(','),
    received ? `${received.solids.length} solids, coreSpawn ${received.coreSpawn?.join(',')}` : '',
  );

  check(
    'server advertises the input step rate to the client',
    roomA.input({ mode: 'reliable' }).stepSeconds !== undefined,
    `stepSeconds=${roomA.input({ mode: 'reliable' }).stepSeconds}`,
  );

  const coreAtSpawn = () =>
    Math.abs(s().coreX - course.coreSpawn![0]) < 1e-6 &&
    Math.abs(s().coreY - course.coreSpawn![1]) < 1e-6 &&
    Math.abs(s().coreZ - course.coreSpawn![2]) < 1e-6;

  check('the free Core sits on its spawn in ready', coreAtSpawn() && s().carrierId === '',
    `core (${s().coreX}, ${s().coreY}, ${s().coreZ})`);

  // --- drive real inputs --------------------------------------------------
  const hA = roomA.input({ type: MoveInput, mode: 'reliable' });
  const hB = roomB.input({ type: MoveInput, mode: 'reliable' });
  const send = (h: typeof hA, moveZ: number, dash = false) => {
    h.data.moveX = 0;
    h.data.moveZ = moveZ;
    h.data.dash = dash;
    h.data.jump = false;
    h.send();
  };
  const both = (zA: number, zB: number) => {
    send(hA, zA);
    send(hB, zB);
  };
  /** Poll until `cond` or the deadline; keeps both clients sending idle. */
  const waitFor = async (cond: () => boolean, ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !cond()) {
      both(0, 0);
      await sleep(16);
    }
    return cond();
  };

  // 1. Idle: the match must NOT start.
  for (let i = 0; i < 30; i++) {
    both(0, 0);
    await sleep(16);
  }
  check('idle input does not start the match',
    s().phase === 'ready' && s().phaseRemainingMs === 0,
    `phase=${s().phase} remaining=${s().phaseRemainingMs}`);

  // 2. Move: the countdown starts. The axis is wildly out of range, which also
  //    proves sanitize clamps it -- racers may move during the countdown.
  const z0 = me(A)!.z;
  let peakSpeed = 0;
  let sawCountdown = false;
  let countdownRemaining = -1;
  for (let i = 0; i < 40; i++) {
    send(hA, -9999);
    send(hB, 0);
    await sleep(16);
    peakSpeed = Math.max(peakSpeed, me(A)!.speed);
    if (s().phase === 'countdown' && !sawCountdown) {
      sawCountdown = true;
      countdownRemaining = s().phaseRemainingMs;
    }
  }
  check('movement starts the countdown',
    sawCountdown && countdownRemaining > 0 && countdownRemaining <= WIRE_TIMINGS.countdownMs,
    `phase=${s().phase}, remaining at first sight ${countdownRemaining.toFixed(0)}ms`);
  check('racers move during the countdown', me(A)!.z < z0 - 1, `z ${z0.toFixed(2)} -> ${me(A)!.z.toFixed(2)}`);
  check('out-of-range input is clamped, not trusted',
    peakSpeed > 1 && peakSpeed <= MOVE.runSpeed + 0.5,
    `peak speed=${peakSpeed.toFixed(2)} (tuned run is ${MOVE.runSpeed})`);
  check('the Core is not live during the countdown', s().carrierId === '' && coreAtSpawn());

  // 3. Countdown -> playing, everyone back on spawn.
  const playing = await waitFor(() => s().phase === 'playing', 10_000);
  check('the countdown runs out into playing', playing, `phase=${s().phase}`);
  // Phase and teleported position may land in different patches; wait for both.
  await waitFor(() => Math.abs(me(A)!.z - course.spawn[2]) < 1, 2000);
  check('entering playing returns racers to spawn',
    Math.abs(me(A)!.z - course.spawn[2]) < 1 && Math.abs(me(B)!.z - course.spawn[2]) < 1,
    `A z=${me(A)!.z.toFixed(2)} B z=${me(B)!.z.toFixed(2)} spawn z=${course.spawn[2]}`);
  // A 1ms match from the client's `timings` option would already be over.
  check('the match clock counts down from the define-time length, not the client\'s',
    s().phaseRemainingMs > WIRE_TIMINGS.durationMs - 3000 && s().phaseRemainingMs <= WIRE_TIMINGS.durationMs,
    `remaining=${s().phaseRemainingMs.toFixed(0)}ms of ${WIRE_TIMINGS.durationMs}`);
  check('a new match starts with clean scores and a free Core',
    me(A)!.holdMs === 0 && me(A)!.lastHeldAtMs === -1 && me(A)!.rank === 0 &&
      s().carrierId === '' && s().immuneRemainingMs === 0 && coreAtSpawn());

  // 4. A runs straight north from spawn, up the dais steps, onto the Core.
  const transfers0 = s().coreTransfers;
  {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && s().carrierId !== A && s().phase === 'playing') {
      send(hA, -1);
      send(hB, 0);
      await sleep(16);
    }
  }
  const picked = s().carrierId === A;
  check('running north up the dais picks up the Core', picked,
    `carrier=${s().carrierId.slice(0, 6) || "''"} A at z=${me(A)!.z.toFixed(2)} y=${me(A)!.y.toFixed(2)}`);

  if (!picked) {
    for (const label of ['pickup counts one transfer and grants immunity', 'the carrier accrues hold time',
      'the carried Core rides above the carrier', 'a dash into the carrier steals the Core',
      'dash counters are published', 'a carrier leaving drops the Core', 'time up enters results with ranks',
      'results expire back to ready with scores cleared']) skip(label, 'A never picked up the Core');
    await roomA.leave();
    await roomB.leave();
    await gameServer.gracefullyShutdown(false);
    return;
  }

  check('pickup counts one transfer and grants immunity',
    s().coreTransfers === transfers0 + 1 && s().immuneRemainingMs > 0 &&
      s().immuneRemainingMs <= CORE.immunityMs,
    `transfers ${transfers0} -> ${s().coreTransfers}, immunity ${s().immuneRemainingMs.toFixed(0)}ms`);

  // A stops. Hold time must accrue while it stands there.
  const h1 = me(A)!.holdMs;
  await waitFor(() => false, 600);
  const h2 = me(A)!.holdMs;
  check('the carrier accrues hold time',
    h2 > h1 + 300 && me(A)!.lastHeldAtMs > 0,
    `holdMs ${h1.toFixed(0)} -> ${h2.toFixed(0)} over ~600ms, lastHeldAtMs=${me(A)!.lastHeldAtMs.toFixed(0)}`);
  check('the carried Core rides above the carrier',
    Math.abs(s().coreY - (me(A)!.y + CORE.carryHeight)) < 1e-3 &&
      Math.abs(s().coreX - me(A)!.x) < 1e-3 && Math.abs(s().coreZ - me(A)!.z) < 1e-3,
    `core y=${s().coreY.toFixed(3)} carrier y=${me(A)!.y.toFixed(3)} + ${CORE.carryHeight}`);

  // 5. The steal. Deterministic enough because it does not depend on timing a
  //    single tick: A stands still on the dais, B runs straight up the same
  //    line and holds dash from 3.5 units out. A dash covers ~4 units in
  //    0.37-unit steps, straight through A (racers pass through each other),
  //    so some step of it lands inside the 1.4 steal radius wherever within a
  //    unit or so of latency the dash actually starts. Immunity is waited out
  //    first; a dash into an immune carrier is covered by the pure tests.
  await waitFor(() => s().immuneRemainingMs === 0, 5000);
  const transfers1 = s().coreTransfers;
  let peakDash = 0;
  let peakCooldown = 0;
  {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && s().carrierId === A && s().phase === 'playing') {
      const gap = me(B)!.z - me(A)!.z;
      send(hA, 0);
      send(hB, -1, gap < 3.5);
      await sleep(16);
      peakDash = Math.max(peakDash, me(B)!.dashTicks);
      peakCooldown = Math.max(peakCooldown, me(B)!.dashCooldownTicks);
      // B has run well past A without stealing: no point continuing.
      if (gap < -6) break;
    }
  }
  const stolen = s().carrierId === B;
  check('a dash into the carrier steals the Core',
    stolen && s().coreTransfers === transfers1 + 1 && s().immuneRemainingMs > 0,
    `carrier=${s().carrierId.slice(0, 6) || "''"} transfers ${transfers1} -> ${s().coreTransfers}, ` +
      `B z=${me(B)!.z.toFixed(2)} A z=${me(A)!.z.toFixed(2)}`);

  // The cooldown starts when the dash ends and lasts 1.2s, so it is visible
  // in patches even when the 11-tick dash itself falls between two of them.
  await waitFor(() => me(B)!.dashCooldownTicks > 0 || peakCooldown > 0, 1000);
  peakCooldown = Math.max(peakCooldown, me(B)!.dashCooldownTicks);
  check('dash counters are published',
    (peakDash > 0 || peakCooldown > 0) && peakDash <= DASH.durationTicks && peakCooldown <= DASH.cooldownTicks,
    `peak dashTicks=${peakDash}, peak dashCooldownTicks=${peakCooldown}`);

  if (stolen) {
    const aFrozen = me(A)!.holdMs;
    await waitFor(() => false, 300);
    check('the robbed racer stops accruing', me(A)!.holdMs === aFrozen && me(B)!.holdMs > 0,
      `A holdMs ${aFrozen.toFixed(0)} -> ${me(A)!.holdMs.toFixed(0)}, B holdMs ${me(B)!.holdMs.toFixed(0)}`);
  }

  // 6. The carrier leaves: the Core drops. A may be standing within pickup
  //    range of the Core's spawn and re-take it the same tick, so this checks
  //    "B no longer has it and at least one change of hands", not "free".
  const transfers2 = s().coreTransfers;
  const carrierBeforeLeave = s().carrierId;
  await roomB.leave();
  await waitFor(() => !s().players.has(B), 2000);
  check('a carrier leaving drops the Core',
    carrierBeforeLeave === B && s().carrierId !== B && s().coreTransfers >= transfers2 + 1,
    `carrier before=${carrierBeforeLeave.slice(0, 6)} after=${s().carrierId.slice(0, 6) || "''"}, ` +
      `transfers ${transfers2} -> ${s().coreTransfers}`);

  // 7. Time up.
  const results = await waitFor(() => s().phase === 'results', WIRE_TIMINGS.durationMs + 10_000);
  // Ranks and winner may trail the phase by one patch.
  await waitFor(() => me(A)!.rank !== 0, 1000);
  check('time up enters results with ranks',
    results && me(A)!.rank === 1 && s().winnerId === A && s().carrierId === '' && coreAtSpawn() &&
      s().phaseRemainingMs > 0 && s().phaseRemainingMs <= WIRE_TIMINGS.resultsMs,
    `phase=${s().phase} rank=${me(A)!.rank} winner=${s().winnerId.slice(0, 6) || "''"} ` +
      `A holdMs=${me(A)!.holdMs.toFixed(0)} remaining=${s().phaseRemainingMs.toFixed(0)}`);

  // 8. Results expire.
  const ready = await waitFor(() => s().phase === 'ready', WIRE_TIMINGS.resultsMs + 10_000);
  await waitFor(() => me(A)!.holdMs === 0 && Math.abs(me(A)!.z - course.spawn[2]) < 1, 2000);
  check('results expire back to ready with scores cleared',
    ready && me(A)!.holdMs === 0 && me(A)!.lastHeldAtMs === -1 && me(A)!.rank === 0 &&
      s().winnerId === '' && s().phaseRemainingMs === 0 && coreAtSpawn() &&
      Math.abs(me(A)!.z - course.spawn[2]) < 1,
    `phase=${s().phase} holdMs=${me(A)!.holdMs} rank=${me(A)!.rank} z=${me(A)!.z.toFixed(2)}`);

  // 9. Respawn: is the spawn point on solid ground?
  const probe = respawnFeet(
    (() => {
      const w = createPhysicsWorld();
      buildCourseColliders(w, course);
      return w;
    })(),
    course,
  );
  check(
    'respawn lands on a real surface, not the nominal spawn Y',
    probe.y > 0 && probe.y < 3,
    `feet y=${probe.y.toFixed(2)} (JSON spawn y=${course.spawn[1]})`,
  );

  await roomA.leave();
  await gameServer.gracefullyShutdown(false);
}

// ====================================================================== main

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  await initPhysics();
  const course = loadCourse();

  console.log(`\nTEKK Day 3 harness - course "${course.id}" (${course.name}), ` +
    `${course.solids.length} solids, step ${(FIXED_TIMESTEP * 1000).toFixed(2)}ms`);

  await testDeterminism(course);
  await testRollback(course);
  // Guarded so a crash in the wire suite still prints the tally for A and B,
  // which do not depend on the server room at all.
  testRules(course);
  try {
    await testWire(course);
  } catch (err) {
    check('wire suite ran to completion', false, `crashed: ${String(err).slice(0, 160)}`);
  }

  // A skipped check is unverified, not passing. Say so in the tally rather than
  // letting "N passed" imply more coverage than actually happened.
  const skippedNote = skipped > 0 ? `, ${skipped} skipped` : '';
  console.log(`\n${pass} passed, ${fail} failed${skippedNote}`);
  if (fail > 0) {
    console.log('failures:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('\nharness crashed:', err);
    process.exit(1);
  },
);