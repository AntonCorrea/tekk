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

import { DEFAULT_COURSE_PATH, loadCourse } from '../server/course.ts';
import { dirname, join } from 'node:path';
import { createPhysicsWorld, initPhysics } from '../src/physics/world.ts';
import { adoptTruth } from '../src/physics/player.ts';
import {
  applyInput,
  buildCourseColliders,
  createSimBody,
  moveSimBody,
  respawnFeet,
  teleportBody,
  type SimBody,
} from '../src/shared/sim.ts';
import { MoveInput } from '../src/shared/input.ts';
import type { MoveInputData } from '../src/shared/input.ts';
import { PlayerState } from '../src/shared/state.ts';
import { BOOST, CORE, DASH, FIXED_TIMESTEP, GRAVITY, MATCH, MOVE, PLAYER, WALL } from '../src/constants.ts';
import {
  advancePhase,
  chooseStealer,
  choosePickup,
  chooseMapVote,
  DEFAULT_TIMINGS,
  hasSkipMajority,
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
    boostTicks: sim.boostTicks,
    wallTicks: sim.wallTicks,
    wallCooldownTicks: sim.wallCooldownTicks,
    wallNX: sim.wallNX,
    wallNY: sim.wallNY,
    wallNZ: sim.wallNZ,
    wallLocked: sim.wallLocked,
    prevJump: sim.prevJump,
    bounceArmed: sim.bounceArmed,
  };
};
type Snap = ReturnType<typeof snap>;

function identical(a: Snap, b: Snap): boolean {
  return (
    a.x === b.x && a.y === b.y && a.z === b.z &&
    a.vx === b.vx && a.vy === b.vy && a.vz === b.vz &&
    a.grounded === b.grounded && a.speed === b.speed &&
    a.dashTicks === b.dashTicks && a.dashCooldownTicks === b.dashCooldownTicks &&
    a.boostTicks === b.boostTicks &&
    a.wallTicks === b.wallTicks && a.wallCooldownTicks === b.wallCooldownTicks &&
    a.wallNX === b.wallNX && a.wallNY === b.wallNY && a.wallNZ === b.wallNZ &&
    a.wallLocked === b.wallLocked &&
    a.prevJump === b.prevJump &&
    a.bounceArmed === b.bounceArmed
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
  truth.boostTicks = s.boostTicks;
  truth.wallRunTicks = s.wallTicks;
  truth.wallCooldownTicks = s.wallCooldownTicks;
  truth.wallNX = s.wallNX;
  truth.wallNY = s.wallNY;
  truth.wallNZ = s.wallNZ;
  truth.wallLocked = s.wallLocked;
  truth.prevJump = s.prevJump;
  truth.bounceArmed = s.bounceArmed;
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

  // 3. Mid-dash INTO A WALL. This is the case that caught `adoptTruth` moving
  //    the body but not its collider: the first replayed sweep ran from the
  //    client's mispredicted spot, missed the rail, and the client finished
  //    inside it. Kept as the regression guard for that.
  //
  //    An explicit scenario, not a moment in `scriptAt`: the first version
  //    relied on the scripted t 102 dash happening to reach the start pad's
  //    right rail, and after the speed retune it silently stopped reaching it
  //    -- the check still passed while testing an open floor. So the wall hit
  //    is now asserted, not assumed.
  {
    const RAIL_STOP = 6 - PLAYER.radius; // rail inner face x=6, minus the capsule
    const feet: [number, number, number] = [1, 0.05, 9];
    const intoRail = (step: number) => input(1, 0, step >= 3 && step <= 4);
    const runFrom = (script: (step: number) => MoveInputData, steps: number) => {
      const w = makeWorld(course);
      moveSimBody(w.sim, feet[0], feet[1], feet[2]);
      const log: Snap[] = [];
      for (let step = 0; step < steps; step++) {
        applyInput(w.sim, script(step), FIXED_TIMESTEP);
        w.world.step();
        log.push(snap(w.sim));
      }
      return { w, log };
    };
    const server = runFrom(intoRail, 30).log;
    const ack = server.findIndex((s) => s.dashTicks > 0 && s.dashTicks < DASH.durationTicks - 2);
    const client = runFrom(() => input(0, 0), ack + 1).w;
    adoptTruth(client.sim, truthOf(server[ack]!), false);
    for (let step = ack + 1; step < 30; step++) {
      applyInput(client.sim, intoRail(step), FIXED_TIMESTEP);
      client.world.step();
    }
    const end = server[29]!;
    check(
      'the wall scenario really ends against the rail',
      Math.abs(end.x - RAIL_STOP) < 0.05,
      `server centre x=${end.x.toFixed(3)}, rail stops it at ${RAIL_STOP.toFixed(2)}`,
    );
    check(
      'mid-dash rollback against a wall lands on the server',
      ack > 0 && identical(snap(client.sim), end),
      `ack at step ${ack}; x=${snap(client.sim).x.toFixed(6)} vs ${end.x.toFixed(6)}`,
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

// ===================================================================== P: pads

/**
 * Boost and jump pads, on the production map. Pads are resolved inside the
 * shared step, so they carry the same burden as the dash: bit-identical on both
 * sides, and a rollback that lands mid-boost must reproduce the server.
 */
function testPads(course: Course) {
  console.log(`\n=== P. pads (${course.id}) ===`);
  const boostPad = course.pads.find((p) => p.kind === 'boost' && p.direction?.[1] === -1);
  const jumpPad = course.pads.find((p) => p.kind === 'jump');
  if (!boostPad || !jumpPad) {
    skip('pads', `${course.id} lacks a north boost pad or a jump pad`);
    return;
  }

  // A world whose racer starts at `feet`, then runs `script`.
  const run = (feet: [number, number, number], steps: number, script: (step: number) => MoveInputData) => {
    const w = makeWorld(course);
    moveSimBody(w.sim, feet[0], feet[1], feet[2]);
    const log: Snap[] = [];
    for (let step = 0; step < steps; step++) {
      applyInput(w.sim, script(step), FIXED_TIMESTEP);
      w.world.step();
      log.push(snap(w.sim));
    }
    return log;
  };

  // Run north up the lane, onto the outward boost, then cut across.
  const boostStart: [number, number, number] = [boostPad.position[0], 0.05, boostPad.position[2] + 6];
  const boostScript = (step: number) => (step < 45 ? input(0, -1) : input(1, 0));
  const a = run(boostStart, 90, boostScript);
  const b = run(boostStart, 90, boostScript);
  const diverged = a.findIndex((s, i) => !identical(s, b[i]!));
  const peakBoost = Math.max(...a.map((s) => s.boostTicks));
  const peakSpeed = Math.max(...a.map((s) => s.speed));
  check('a boost pad run is bit-identical across two worlds', diverged === -1,
    diverged === -1 ? '90 steps identical' : `diverged at step ${diverged}`);
  // The counter is refilled and then ticks down at the end of the same step,
  // so the published peak is one under the constant.
  check('the boost pad really boosted', peakBoost === BOOST.ticks - 1 && peakSpeed > MOVE.runSpeed + 5,
    `peak boostTicks=${peakBoost}, peak speed=${peakSpeed.toFixed(1)}`);

  // Rollback mid-boost, after the pad: the client predicted standing still.
  const ack = a.findIndex((s, i) => i > 0 && s.boostTicks > 0 && s.boostTicks < BOOST.ticks - 3);
  const HORIZON = 20;
  const replay = (forget: boolean) => {
    const client = makeWorld(course);
    moveSimBody(client.sim, boostStart[0], boostStart[1], boostStart[2]);
    for (let step = 0; step <= ack; step++) {
      applyInput(client.sim, input(0, 0), FIXED_TIMESTEP);
      client.world.step();
    }
    adoptTruth(client.sim, truthOf(a[ack]!), false);
    if (forget) client.sim.boostTicks = 0;
    for (let step = ack + 1; step <= ack + HORIZON; step++) {
      applyInput(client.sim, boostScript(step), FIXED_TIMESTEP);
      client.world.step();
    }
    return snap(client.sim);
  };
  check('mid-boost rollback lands on the server', ack > 0 && identical(replay(false), a[ack + HORIZON]!),
    `ack at step ${ack}, truth boostTicks=${a[ack]?.boostTicks}`);
  {
    const lost = replay(true);
    const server = a[ack + HORIZON]!;
    check('without boostTicks the same replay lands elsewhere (negative control)',
      lost.x !== server.x || lost.z !== server.z,
      `x=${lost.x.toFixed(4)} z=${lost.z.toFixed(4)} vs server x=${server.x.toFixed(4)} z=${server.z.toFixed(4)}`);
  }

  // Running AGAINST a boost does nothing: it used to throw you back, forever.
  const against = run([boostPad.position[0], 0.05, boostPad.position[2] - 5], 50, () => input(0, 1));
  check('running against a boost pad is not boosted',
    Math.max(...against.map((s) => s.boostTicks)) === 0 && against[49]!.z > boostPad.position[2] + 2,
    `ended z=${against[49]!.z.toFixed(2)}, past the pad at ${boostPad.position[2]}`);

  // Jump pad: a racer running across it is launched well above a normal jump.
  const jumpRun = run([jumpPad.position[0] - 3.5, 0.05, jumpPad.position[2]], 60, () => input(1, 0));
  const startY = jumpRun[0]!.y;
  const peakY = Math.max(...jumpRun.map((s) => s.y));
  const jumpApex = (MOVE.jumpSpeed * MOVE.jumpSpeed) / 80;
  check('a jump pad launches far above a normal jump', peakY - startY > jumpApex * 1.8,
    `rose ${(peakY - startY).toFixed(2)} vs a normal jump's ${jumpApex.toFixed(2)}`);
  const jumpAgain = run([jumpPad.position[0] - 3.5, 0.05, jumpPad.position[2]], 60, () => input(1, 0));
  check('a jump pad run is bit-identical across two worlds',
    jumpRun.every((s, i) => identical(s, jumpAgain[i]!)));
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

  // --- the lobby's map vote -----------------------------------------------
  // Plurality of the votes cast. Every non-decision -- a tie, an empty ballot,
  // votes only for ids the catalog never shipped -- abstains to the current
  // map, and the tally is walked in catalog order so the winner cannot depend
  // on who happened to vote first.
  {
    const catalog = ['alpha', 'beta', 'gamma'];
    check('vote: a plurality of the votes cast wins',
      chooseMapVote(['beta', 'alpha', 'beta'], catalog, 'alpha') === 'beta');
    check('vote: a tie abstains to the current map',
      chooseMapVote(['alpha', 'gamma'], catalog, 'beta') === 'beta');
    check('vote: an all-abstain ballot keeps the current map',
      chooseMapVote(['', ''], catalog, 'gamma') === 'gamma');
    check('vote: abstentions do not dilute a real vote',
      chooseMapVote(['', 'beta'], catalog, 'alpha') === 'beta' &&
        chooseMapVote(['beta', ''], catalog, 'alpha') === 'beta');
    check('vote: ids outside the catalog neither win nor steal a win',
      chooseMapVote(['nuke', 'nuke', 'beta'], catalog, 'alpha') === 'beta' &&
        chooseMapVote(['nuke', 'nuke'], catalog, 'alpha') === 'alpha');
    check('vote: the result does not depend on the order votes arrived in',
      chooseMapVote(['gamma', 'alpha', 'gamma'], catalog, 'beta') === 'gamma' &&
        chooseMapVote(['alpha', 'gamma', 'gamma'], catalog, 'beta') === 'gamma');
  }

  // --- the mid-match skip threshold ---------------------------------------
  // Strict majority of the whole room: half is not a majority, abstaining
  // counts as a vote to play on, and an empty room cannot vote itself out.
  {
    check('skip: no votes never cancels a match',
      !hasSkipMajority(0, 1) && !hasSkipMajority(0, 2) && !hasSkipMajority(0, 0));
    check('skip: half the room is not a majority',
      !hasSkipMajority(1, 2) && !hasSkipMajority(2, 4));
    check('skip: one vote over half cancels',
      hasSkipMajority(2, 3) && hasSkipMajority(3, 5) && hasSkipMajority(1, 1));
    check('skip: a unanimous room always cancels',
      hasSkipMajority(2, 2) && hasSkipMajority(3, 3) && hasSkipMajority(6, 6));
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
  // Pinned to Arena 01: these checks walk a straight line from the spawn to
  // the Core, which is that course's layout. The production map is covered by
  // the smoke test's production-room check.
  const { gameServer } = createGameServer({
    matchTimings: WIRE_TIMINGS,
    coursePath: join(dirname(DEFAULT_COURSE_PATH), 'takk-arena.json'),
  });
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
  // Client-supplied `timings` and `coursePath` must both be ignored: define-time
  // options win. A honoured `coursePath` would be a client choosing which file
  // on the server's disk to read -- here a path that does not exist, so if it
  // were honoured the room would fail to create and this join would throw.
  const roomA = await client.joinOrCreate('race', {
    name: 'HarnessOtter',
    timings: { durationMs: 1 },
    coursePath: '../../not-a-course.json',
  });
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

// ============================================================ E: map vote

/**
 * Phases for the vote suite: short enough that three lobby -> match -> lobby
 * cycles fit in a test run, long enough for a vote to land between patches.
 */
const VOTE_TIMINGS = { countdownMs: 500, durationMs: 2000, resultsMs: 500 };

/**
 * The lobby ballot over the wire: what syncs down, what the server accepts,
 * and what each of the two settlement points actually does to the room.
 *
 * Three matches walk the whole decision set — a unanimous swap out of ready,
 * a unanimous swap out of results, a tie that stays put, and a skip ballot
 * that cancels a running match — plus a solo vote (abstentions are not
 * votes) and the rejections that must never move anything: bad payloads,
 * unknown ids, votes outside their window.
 */
async function testMapVote(): Promise<void> {
  console.log('\n=== E. lobby map vote (wire) ===');

  const { createGameServer } = await import('../server/index.ts');
  const { parseCourse } = await import('../src/shared/course.ts');

  const PORT = 26100 + Math.floor(Math.random() * 400);
  // Pinned to Arena 01, like the wire suite: a small known course to start
  // from, so every swap below reads as `courseJson` changing id.
  const { gameServer } = createGameServer({
    matchTimings: VOTE_TIMINGS,
    coursePath: join(dirname(DEFAULT_COURSE_PATH), 'takk-arena.json'),
  });
  await gameServer.listen(PORT, '127.0.0.1');
  check('vote suite: server boots and listens', true, `port ${PORT}`);

  const client = new Client(`ws://localhost:${PORT}`);
  const roomA = await client.joinOrCreate('race', { name: 'VoteFox' });
  const roomB = await client.joinOrCreate('race', { name: 'VoteHare' });
  const A = roomA.sessionId;
  const B = roomB.sessionId;
  const s = () => roomA.state;
  const me = (id: string) => roomA.state.players.get(id);
  check('vote suite: two clients join the same room',
    !!A && !!B && roomA.roomId === roomB.roomId,
    `A=${A.slice(0, 6)} B=${B.slice(0, 6)}`);

  // --- helpers ------------------------------------------------------------
  const hA = roomA.input({ type: MoveInput, mode: 'reliable' });
  const hB = roomB.input({ type: MoveInput, mode: 'reliable' });
  const send = (h: typeof hA, moveZ: number) => {
    h.data.moveX = 0;
    h.data.moveZ = moveZ;
    h.data.dash = false;
    h.data.jump = false;
    h.send();
  };
  const idle = () => {
    send(hA, 0);
    send(hB, 0);
  };
  /** Wait while `cond` holds, idling both racers as you poll. */
  const waitWhile = async (cond: () => boolean, ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && cond()) {
      idle();
      await sleep(16);
    }
    return !cond();
  };
  const idleFor = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      idle();
      await sleep(16);
    }
  };
  /** Move A until the room commits to a countdown (the ready-window settle point). */
  const startCountdown = async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && s().phase !== 'countdown') {
      send(hA, -1);
      send(hB, 0);
      await sleep(16);
    }
    idle();
    return s().phase === 'countdown';
  };
  const vote = (room: typeof roomA, courseId: unknown) => room.send('vote', { courseId });
  const skipVote = (room: typeof roomA, value: unknown) => room.send('skip', { value });
  const currentId = () => JSON.parse(s().courseJson).id as string;
  const currentCourse = () => parseCourse(JSON.parse(s().courseJson), 'server');
  const ballotOf = (id: string) => me(id)!.votedFor;

  // --- the catalog syncs down ---------------------------------------------
  /** The catalog card shape as it arrives over the wire (state is untyped here). */
  type Card = { id: string; name: string; solids: number; pads: number };
  await waitWhile(() => (s().courseJson ?? '') === '', 2000);
  // The initial state snapshot carries courseJson and catalog together, so
  // once one has landed, so has the other.
  const cards: Card[] = s().catalog.map((entry: Card) => ({
    id: entry.id,
    name: entry.name,
    solids: entry.solids,
    pads: entry.pads,
  }));
  const ids = cards.map((card) => card.id);
  check('the catalog arrives with the room state', ids.length > 0, `[${ids.join(', ')}]`);
  check('catalog cards carry the counts the lobby shows',
    cards.every((card) => card.name.length > 0 && card.solids > 0 && card.pads >= 0),
    cards.map((card) => `${card.id}:${card.solids}s/${card.pads}p`).join(' '));
  const laneId = loadCourse(join(dirname(DEFAULT_COURSE_PATH), 'tekk-01.json')).id;
  check('the catalog lists only Core Rush courses (no coreSpawn, no ballot)',
    !ids.includes(laneId), `${laneId} ${ids.includes(laneId) ? 'present' : 'absent'}`);

  const startId = currentId();
  const others = ids.filter((id) => id !== startId);
  const target1 = others[0];
  if (!target1) {
    skip('vote suite: a second map exists to vote for', 'catalog has only the running map');
    await roomA.leave();
    await roomB.leave();
    await gameServer.gracefullyShutdown(false);
    return;
  }

  // --- what the server accepts ---------------------------------------------
  vote(roomA, target1);
  await waitWhile(() => ballotOf(A) !== target1, 1500);
  check('a valid vote in ready is accepted and published',
    ballotOf(A) === target1, `votedFor=${ballotOf(A) || "''"} want=${target1}`);

  // A rejection must leave the standing vote exactly as it was — not clear
  // it, not replace it, not throw on the wire.
  vote(roomA, 42);
  vote(roomA, {});
  vote(roomA, 'no-such-map');
  await idleFor(250);
  check('bad payloads and unknown ids are rejected without touching the vote',
    ballotOf(A) === target1, `votedFor=${ballotOf(A) || "''"}`);

  vote(roomB, target1);
  await waitWhile(() => ballotOf(B) !== target1, 1500);
  check('a second racer\'s vote lands alongside the first',
    ballotOf(A) === target1 && ballotOf(B) === target1,
    `A=${ballotOf(A) || "''"} B=${ballotOf(B) || "''"}`);

  // --- 1. unanimous ready-ballot swaps at the countdown --------------------
  check('movement starts the countdown with votes pending', await startCountdown(),
    `phase=${s().phase}`);
  await waitWhile(() => currentId() === startId, 2000);
  check('a unanimous ready-ballot swaps the map as the countdown starts',
    currentId() === target1, `course=${currentId()}, wanted ${target1}`);
  check('settling the vote clears every ballot',
    ballotOf(A) === '' && ballotOf(B) === '',
    `A=${ballotOf(A) || "''"} B=${ballotOf(B) || "''"}`);
  const catalogAfterSwap = s().catalog.map((entry: { id: string }) => entry.id).join(',');
  check('the catalog itself does not change with the swap',
    catalogAfterSwap === ids.join(','), catalogAfterSwap);

  const swapped1 = currentCourse();
  await waitWhile(() => Math.abs(me(A)!.z - swapped1.spawn[2]) > 1, 2000);
  check('racers respawn on the new map\'s spawn',
    Math.abs(me(A)!.z - swapped1.spawn[2]) < 1 && Math.abs(me(B)!.z - swapped1.spawn[2]) < 1,
    `A z=${me(A)!.z.toFixed(2)} B z=${me(B)!.z.toFixed(2)} spawn z=${swapped1.spawn[2]}`);
  check('the Core sits on the new map\'s dais',
    Math.abs(s().coreX - swapped1.coreSpawn![0]) < 1e-6 &&
      Math.abs(s().coreY - swapped1.coreSpawn![1]) < 1e-6 &&
      Math.abs(s().coreZ - swapped1.coreSpawn![2]) < 1e-6,
    `core (${s().coreX}, ${s().coreY}, ${s().coreZ}) vs (${swapped1.coreSpawn!.join(', ')})`);

  // Outside a lobby window the vote is ignored outright.
  const duringCountdown = others[1] ?? target1;
  vote(roomA, duringCountdown);
  await idleFor(250);
  check('votes are ignored outside the lobby windows (countdown)',
    ballotOf(A) === '', `votedFor=${ballotOf(A) || "''"}`);

  // --- 2. unanimous results-ballot swaps when the lobby resets -------------
  await waitWhile(() => s().phase !== 'results', 20_000);
  check('the match runs out into results', s().phase === 'results', `phase=${s().phase}`);

  const target2 = others[1] ?? startId;
  vote(roomA, target2);
  vote(roomB, target2);
  await waitWhile(() => ballotOf(A) !== target2 || ballotOf(B) !== target2, 1500);
  check('votes are accepted during results',
    ballotOf(A) === target2 && ballotOf(B) === target2,
    `A=${ballotOf(A) || "''"} B=${ballotOf(B) || "''"}`);

  await waitWhile(() => s().phase !== 'ready', 5000);
  check('a unanimous results-ballot swaps the map when the lobby resets',
    s().phase === 'ready' && currentId() === target2,
    `phase=${s().phase} course=${currentId()}, wanted ${target2}`);
  check('the reset also clears every ballot',
    ballotOf(A) === '' && ballotOf(B) === '',
    `A=${ballotOf(A) || "''"} B=${ballotOf(B) || "''"}`);

  const swapped2 = currentCourse();
  await waitWhile(() => Math.abs(me(A)!.z - swapped2.spawn[2]) > 1, 2000);
  check('the results-swap respawn lands on the new map\'s spawn',
    Math.abs(me(A)!.z - swapped2.spawn[2]) < 1 && Math.abs(me(B)!.z - swapped2.spawn[2]) < 1,
    `A z=${me(A)!.z.toFixed(2)} spawn z=${swapped2.spawn[2]}`);

  // --- the skip ballot only exists mid-match -------------------------------
  // In a lobby window the ballot above already carries the decision, so a
  // skip vote there is meaningless and must change nothing.
  skipVote(roomA, true);
  await idleFor(250);
  check('skip votes are ignored outside a match',
    me(A)!.votedToSkip === false,
    `phase=${s().phase} votedToSkip=${String(me(A)!.votedToSkip)}`);
  skipVote(roomA, false);

  // --- 3. a tie stays put ---------------------------------------------------
  const tieStayId = currentId();
  const tieTargets = ids.filter((id) => id !== tieStayId);
  if (tieTargets.length >= 2) {
    const [tieA, tieB] = [tieTargets[0]!, tieTargets[1]!];
    vote(roomA, tieA);
    vote(roomB, tieB);
    await waitWhile(() => ballotOf(A) !== tieA || ballotOf(B) !== tieB, 1500);
    check('movement starts the countdown on a tied ballot', await startCountdown(),
      `phase=${s().phase}`);
    await idleFor(250);
    check('a tied ready-ballot leaves the current map in place',
      currentId() === tieStayId, `course=${currentId()}, tie on [${tieA}, ${tieB}]`);
    check('the tie is consumed all the same',
      ballotOf(A) === '' && ballotOf(B) === '',
      `A=${ballotOf(A) || "''"} B=${ballotOf(B) || "''"}`);
  } else {
    skip('a tied ready-ballot leaves the current map in place', 'fewer than three maps in the catalog');
    skip('the tie is consumed all the same', 'fewer than three maps in the catalog');
  }

  // --- 4. a skip majority cancels the running match -------------------------
  // One vote out of two is a minority and changes nothing — withdrawable,
  // because the payload is the intent rather than a flip. Both votes in
  // lands in `ready` directly: never through `results`, never with a map
  // swap (the ballots were consumed at the countdown; skipping ends the
  // match, it does not pick the next map).
  {
    // The tie branch just started a countdown; a two-map catalog skips that
    // branch entirely, so start one here instead.
    if (s().phase === 'ready') await startCountdown();

    // A non-boolean never reaches the flag.
    skipVote(roomA, 'yes');
    await idleFor(250);
    check('a non-boolean skip payload is rejected',
      me(A)!.votedToSkip === false && s().phase !== 'ready',
      `phase=${s().phase} votedToSkip=${String(me(A)!.votedToSkip)}`);

    // One of two is a minority: the match carries on.
    skipVote(roomA, true);
    await idleFor(300);
    check('one skip vote out of two does not cancel the match',
      me(A)!.votedToSkip === true && s().phase !== 'ready',
      `phase=${s().phase}`);

    // Withdrawable: `value: false` takes the flag back down.
    skipVote(roomA, false);
    await idleFor(250);
    check('a skip vote can be withdrawn',
      me(A)!.votedToSkip === false && s().phase !== 'ready',
      `phase=${s().phase}`);

    // Both in: straight back to the lobby.
    skipVote(roomA, true);
    skipVote(roomB, true);
    let sawResults = s().phase === 'results';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && s().phase !== 'ready') {
      if (s().phase === 'results') sawResults = true;
      idle();
      await sleep(16);
    }
    check('two skip votes out of two cancel the match',
      s().phase === 'ready', `phase=${s().phase}`);
    check('the cancel goes straight to ready, never through results',
      !sawResults, `sawResults=${sawResults} phase=${s().phase}`);
    check('the cancel clears every skip flag',
      me(A)!.votedToSkip === false && me(B)!.votedToSkip === false,
      `A=${String(me(A)!.votedToSkip)} B=${String(me(B)!.votedToSkip)}`);
    check('skipping ends the match, it does not pick the next map',
      currentId() === tieStayId, `course=${currentId()}, stayed on ${tieStayId}`);
  }

  // --- 5. a solo vote beats an empty field ---------------------------------
  // The skip cancel already put the lobby back; if it somehow did not, the
  // running match would have to play out first.
  await waitWhile(() => s().phase !== 'ready', 25_000);
  check('the lobby comes back around for another ballot', s().phase === 'ready',
    `phase=${s().phase}`);

  const soloId = ids.find((id) => id !== currentId())!;
  vote(roomA, soloId);
  await waitWhile(() => ballotOf(A) !== soloId, 1500);
  check('one vote against a silent field is still accepted',
    ballotOf(A) === soloId && ballotOf(B) === '',
    `A=${ballotOf(A) || "''"} B=${ballotOf(B) || "''"}`);

  const beforeSolo = currentId();
  check('movement starts the countdown for the solo ballot', await startCountdown(),
    `phase=${s().phase}`);
  await idleFor(250);
  check('a solo vote wins the ballot (abstentions are not votes)',
    currentId() === soloId && currentId() !== beforeSolo,
    `course=${currentId()}, wanted ${soloId}`);
  check('the winning solo vote is consumed',
    ballotOf(A) === '' && ballotOf(B) === '',
    `A=${ballotOf(A) || "''"} B=${ballotOf(B) || "''"}`);

  await roomA.leave();
  await roomB.leave();
  await gameServer.gracefullyShutdown(false);
}

// ====================================================================== main

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ================================================================= W: walls

/**
 * A purpose-built course for the wall verbs, so the tests assert geometry that
 * cannot silently stop existing when the production map changes.
 *
 * The floor is a 40x40 slab. Wall A runs along X at z = -6: its face on the
 * racer's side sits at z = -5.75 and its outward normal is +Z. Wall B (opt-in,
 * for the chain test) mirrors it at z = +6 with outward normal -Z, leaving an
 * ~11.5-unit alley. A capsule centre rides a face at the face z minus its
 * radius (PLAYER.radius).
 */
function wallCourse(withSecondWall = false): Course {
  const solids: Course['solids'] = [
    { id: 'floor', kind: 'box', position: [0, -0.5, 0], size: [40, 1, 40] },
    { id: 'wall-a', kind: 'box', position: [0, 5, -6], size: [24, 10, 0.5] },
  ];
  if (withSecondWall) {
    solids.push({ id: 'wall-b', kind: 'box', position: [0, 5, 6], size: [24, 10, 0.5] });
  }
  return {
    id: 'harness-walls',
    name: 'Harness Walls',
    spawn: [0, 1, -1],
    killY: -10,
    solids,
    pads: [],
    decor: [],
  };
}

/**
 * One full clip against wall A: run up (t < 16), jump once and fly into the
 * face (attach lands ~t 25), then climb the budget's first third by holding
 * INTO the wall (moveZ = -1), then run ALONG the face (moveX = -1) until the
 * budget runs out, fall back to the floor and idle.
 *
 * Drives the section's determinism, budget, climb and mid-clip rollback checks.
 */
function wallScriptAt(step: number): MoveInputData {
  if (step < 16) return input(0, -1, false, false);
  if (step < 32) return input(0, -1, false, step === 16);
  if (step < 52) return input(-1, 0, false, false); // along the wall -> run
  return input(0, 0, false, false);
}

/** Same approach, but steer along the face for the whole clip (no climb). */
function wallHoriScriptAt(step: number): MoveInputData {
  if (step < 16) return input(0, -1, false, false);
  if (step < 32) return input(0, -1, false, step === 16);
  if (step < 52) return input(-1, 0, false, false);
  return input(0, 0, false, false);
}

/** Same approach, then jump while clipped to wall-jump off the face. */
function wallJumpScriptAt(step: number): MoveInputData {
  if (step < 16) return input(0, -1, false, false);
  if (step < 29) return input(0, -1, false, step === 16);
  if (step < 30) return input(0, -1, false, true); // jump while clipped -> wall-jump
  return input(0, 0, false, false);
}

/** Same approach, then hold AWAY from the face (+Z) to peel off. */
function wallPeelScriptAt(step: number): MoveInputData {
  if (step < 16) return input(0, -1, false, false);
  if (step < 28) return input(0, -1, false, step === 16);
  return input(0, 1, false, false);
}

/** Clip wall A, wall-jump across the alley, hop into wall B and climb it. */
function wallChainScriptAt(step: number): MoveInputData {
  if (step < 16) return input(0, -1, false, false); // run up to wall-a
  if (step < 29) return input(0, -1, false, step === 16);
  if (step < 30) return input(0, -1, false, true); // wall-jump off wall-a
  if (step < 64) return input(0, 1, false, false); // fly +Z across the alley
  if (step < 74) return input(0, 1, false, step === 65); // land, then hop into wall-b
  return input(0, 1, false, false); // climb the far face
}

/**
 * Approach the wall high up (the harness spawns the body at feet y=8.5, a few
 * units off the face), climb its last stretch diagonally, and -- once clear of
 * the top -- peel AWAY so the respawned racer lands past the face instead of
 * chaining back onto it. Drives the W8 top-out checks.
 */
function wallClimbScriptAt(step: number): MoveInputData {
  if (step < 28) return input(-0.5, -1, false, false); // approach + diagonal climb up the top
  return input(0, 1, false, false); // peel away over the ridge
}

/**
 * The wall-lock scenario: jump into wall A and hold INTO it for the whole
 * budget (a climb), then keep pressing toward the face all the way back to the
 * floor -- the lock must hold against what would otherwise be an infinite
 * mid-air re-grab (cooldown spent, fast, inside probe range) -- and once
 * grounded, re-jump straight back up the same face to prove the ground reset.
 *
 * Timing (trace): attach ~t25, budget out at t54 (firstFree), lands ~t104,
 * re-jumps at t110, re-attaches ~t112. Drives the W9 checks.
 */
function wallRestartScriptAt(step: number): MoveInputData {
  if (step < 16) return input(0, -1, false, false); // roll up to wall-a
  if (step < 110) return input(0, -1, false, step === 16); // climb, fall locked, land
  return input(0, -1, false, step === 110); // ground reset the lock -> climb again
}

async function testWalls(): Promise<void> {
  console.log('\n=== W. wall-run, climb and wall-jump (fixture) ===');

  const course = wallCourse();
  const FACE_Z = -5.75 + PLAYER.radius; // where a capsule centre rides the face
  const apex = MOVE.jumpSpeed ** 2 / (2 * -GRAVITY.y);

  // --- W1: one combined clip, two worlds, fresh replay --------------------
  {
    const STEPS = 130;
    const a = makeWorld(course);
    const b = makeWorld(course);
    let firstDivergence = -1;
    for (let step = 0; step < STEPS; step++) {
      const cmd = wallScriptAt(step);
      for (const side of [a, b]) {
        applyInput(side.sim, cmd, FIXED_TIMESTEP);
        side.world.step();
      }
      if (firstDivergence === -1 && !identical(snap(a.sim), snap(b.sim))) firstDivergence = step;
    }
    check(
      'a wall clip runs bit-for-bit across two worlds',
      firstDivergence === -1,
      firstDivergence === -1 ? '130 steps identical' : `diverged at step ${firstDivergence}`,
    );

    const log = record(course, STEPS, wallScriptAt);
    check('a fresh world replays the wall run exactly', identical(snap(a.sim), log[STEPS - 1]!));

    const maxWall = Math.max(...log.map((s) => s.wallTicks));
    const attachStarts = log
      .map((s, i) => (s.wallTicks > 0 && (i === 0 || log[i - 1]!.wallTicks === 0) ? i : -1))
      .filter((i) => i >= 0);
    const clipSteps = log.filter((s) => s.wallTicks > 0).length;
    // The first step AFTER the clip: once the budget is spent the very step
    // that reaches 0 publishes wallTicks=0 (and the cooldown), so `> 0` counts
    // budget-1 steps and the clip itself spans attach .. attach+budget-1.
    const firstFree = log.findIndex((s, i) => s.wallTicks === 0 && i > 0 && log[i - 1]!.wallTicks > 0);
    check(
      'the racer really clipped to the wall, once, for the whole budget',
      maxWall === WALL.budgetTicks - 1 &&
        attachStarts.length === 1 &&
        firstFree === attachStarts[0]! + WALL.budgetTicks - 1 &&
        clipSteps === WALL.budgetTicks - 1,
      `${attachStarts.length} attach at step ${attachStarts[0]}, ${clipSteps} published-clipped ` +
        `steps (budget ${WALL.budgetTicks}, peak published ${maxWall}), first free ${firstFree}`,
    );

    const clipped = log.filter((s) => s.wallTicks > 0);
    const peakY = Math.max(...clipped.map((s) => s.y));
    const peakVy = Math.max(...clipped.map((s) => s.vy));
    check(
      'climb raises the racer well above a single jump',
      peakY > apex + 1.2,
      `peak clipped y=${peakY.toFixed(2)} (a jump apexes at ${apex.toFixed(2)})`,
    );
    check(
      'the climb reaches the climb speed while it lasts',
      peakVy >= WALL.climbSpeed - 0.5,
      `peak vy=${peakVy.toFixed(2)} (climb ${WALL.climbSpeed})`,
    );
    check(
      'the face holds the racer for the whole run',
      clipped.every((s) => Math.abs(s.z - FACE_Z) < 0.3),
      `z band ${Math.min(...clipped.map((s) => s.z)).toFixed(2)}..` +
        `${Math.max(...clipped.map((s) => s.z)).toFixed(2)} around face ${FACE_Z.toFixed(2)}`,
    );
    const minX = Math.min(...clipped.map((s) => s.x));
    check('the second phase travels along the face', minX < -2, `min x=${minX.toFixed(2)}`);

    // Budget exhaustion is a deliberate exit: the first step WITHOUT a clip
    // after the clip publishes the cooldown.
    check(
      'the expired budget starts the re-attach cooldown and arms the wall lock',
      firstFree > 0 &&
        log[firstFree]!.wallCooldownTicks === WALL.cooldownTicks &&
        log[firstFree]!.wallLocked,
      `first free step ${firstFree}, cooldown ${firstFree >= 0 ? log[firstFree]!.wallCooldownTicks : 'n/a'}, ` +
        `lock ${firstFree >= 0 ? log[firstFree]!.wallLocked : 'n/a'}`,
    );
    check(
      'after the clip the racer lands back on the floor',
      log[log.length - 1]!.grounded && log[log.length - 1]!.wallTicks === 0,
      `final grounded=${log[log.length - 1]!.grounded}`,
    );
  }

  // --- W2: wall-run speed and the carrier discount --------------------------
  {
    const log = record(course, 130, wallHoriScriptAt);
    const flat = log.filter((s) => s.wallTicks > 0).slice(6); // skip the ramp-in
    const peak = Math.max(...flat.map((s) => s.speed));
    check(
      'wall-run along the face reaches the configured WALL.runSpeed',
      Math.abs(peak - WALL.runSpeed) < 0.05,
      `peak clipped speed=${peak.toFixed(3)} (run ${MOVE.runSpeed}, wall ${WALL.runSpeed})` +
        (WALL.runSpeed > MOVE.runSpeed
          ? ''
          : ' -- wall speed is no faster than run speed (tuning choice, not a bug)'),
    );

    const carried = record(course, 130, wallHoriScriptAt, true);
    const cFlat = carried.filter((s) => s.wallTicks > 0).slice(6);
    const cPeak = Math.max(...cFlat.map((s) => s.speed));
    check(
      'a carrier clips too, at the carried wall speed',
      Math.abs(cPeak - WALL.runSpeed * CORE.carrierSpeedFactor) < 0.05 && cPeak < WALL.runSpeed,
      `peak ${cPeak.toFixed(3)} (wall ${WALL.runSpeed} x ${CORE.carrierSpeedFactor} ` +
        `= ${(WALL.runSpeed * CORE.carrierSpeedFactor).toFixed(2)})`,
    );
  }

  // --- W3: wall-jump ---------------------------------------------------------
  {
    const log = record(course, 60, wallJumpScriptAt);
    const drop = log.findIndex((s, i) => s.wallTicks === 0 && i > 0 && log[i - 1]!.wallTicks > 0);
    const s = log[drop]!;
    check(
      'a jump while clipped kicks off the face (wall-jump)',
      s.vz > WALL.jumpOut - 1 && s.vy > WALL.jumpUp - 1.5,
      `step ${drop}: v=(${s.vx.toFixed(2)}, ${s.vy.toFixed(2)}, ${s.vz.toFixed(2)}) ` +
        `(out ${WALL.jumpOut}, up ${WALL.jumpUp})`,
    );
    check(
      'the wall-jump is a deliberate exit, charged the cooldown and the wall lock',
      s.wallCooldownTicks === WALL.cooldownTicks - 1 && s.wallLocked,
      `cooldown ${s.wallCooldownTicks}, lock ${s.wallLocked}`,
    );
  }

  // --- W4: peel --------------------------------------------------------------
  {
    const log = record(course, 60, wallPeelScriptAt);
    const drop = log.findIndex((s, i) => s.wallTicks === 0 && i > 0 && log[i - 1]!.wallTicks > 0);
    check(
      'holding away from the face peels the racer off, charged the cooldown and the wall lock',
      drop > 0 &&
        log[drop]!.wallCooldownTicks === WALL.cooldownTicks - 1 &&
        log[drop]!.wallLocked,
      `peeled at step ${drop}, cooldown ${drop >= 0 ? log[drop]!.wallCooldownTicks : 'n/a'}, ` +
        `lock ${drop >= 0 ? log[drop]!.wallLocked : 'n/a'}`,
    );
  }

  // --- W5: entry gates --------------------------------------------------------
  {
    // Grounded racer runs into the wall base: touches the face, never clips.
    const grounded = record(course, 90, () => input(0, -1, false, false));
    const maxWall = Math.max(...grounded.map((s) => s.wallTicks));
    const touched = Math.min(...grounded.map((s) => s.z));
    check(
      'a grounded run into the wall base never clips',
      maxWall === 0 && touched < FACE_Z + 0.1,
      `max wallTicks=${maxWall}, closest z=${touched.toFixed(2)} (face ${FACE_Z.toFixed(2)})`,
    );

    // Pinned to the face at zero horizontal speed: the capsule rides the wall
    // in full contact and slides straight down it, but with no speed the
    // attach gate never even probes, so it can never clip.
    const pinned = makeWorld(course);
    moveSimBody(pinned.sim, 0, 2.5, FACE_Z);
    const pinnedLog: Snap[] = [];
    for (let t = 0; t < 30; t++) {
      applyInput(pinned.sim, input(0, 0, false, false), FIXED_TIMESTEP);
      pinned.world.step();
      pinnedLog.push(snap(pinned.sim));
    }
    check(
      'an airborne racer pinned to the face at zero speed never clips',
      Math.max(...pinnedLog.map((s) => s.wallTicks)) === 0 &&
        pinnedLog.some((s) => !s.grounded && s.z < FACE_Z + 0.05),
      `max wallTicks=${Math.max(...pinnedLog.map((s) => s.wallTicks))}, ` +
        `airborne at face=${pinnedLog.some((s) => !s.grounded && s.z < FACE_Z + 0.05)}`,
    );

    // Dash straight into the face: the clip is gated off for every dash step,
    // then (dash over, still airborne and fast) the attach lands post-dash.
    const dash = makeWorld(course);
    moveSimBody(dash.sim, 0, 0.05, -1);
    const dashLog: Snap[] = [];
    for (let t = 0; t < 30; t++) {
      applyInput(dash.sim, input(0, -1, t >= 1 && t < 1 + DASH.durationTicks, t === 10), FIXED_TIMESTEP);
      dash.world.step();
      dashLog.push(snap(dash.sim));
    }
    const lastDash = dashLog.map((s, i) => (s.dashTicks > 0 ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
    const attachAfter = dashLog.findIndex((s, i) => i > lastDash && s.wallTicks > 0);
    check(
      'a mid-dash wall never clips; the clip starts only after the dash',
      dashLog.some((s) => s.dashTicks > 0) &&
        dashLog.every((s) => s.dashTicks === 0 || s.wallTicks === 0) &&
        attachAfter > lastDash,
      `last dash step ${lastDash}, first clip ${attachAfter}`,
    );
  }

  // --- W6: a wall-to-wall chain ----------------------------------------------
  {
    const chain = wallCourse(true);
    const log = record(chain, 200, wallChainScriptAt);
    const attachStarts = log
      .map((s, i) => (s.wallTicks > 0 && (i === 0 || log[i - 1]!.wallTicks === 0) ? i : -1))
      .filter((i) => i >= 0);
    check(
      'a wall-jump across the alley re-attaches the far wall (chain)',
      attachStarts.length >= 2,
      `${attachStarts.length} attaches at steps ${attachStarts.join(', ')}`,
    );

    const a = makeWorld(chain);
    const b = makeWorld(chain);
    let div = -1;
    for (let t = 0; t < 200; t++) {
      const cmd = wallChainScriptAt(t);
      for (const side of [a, b]) {
        applyInput(side.sim, cmd, FIXED_TIMESTEP);
        side.world.step();
      }
      if (div === -1 && !identical(snap(a.sim), snap(b.sim))) div = t;
    }
    check(
      'the wall-to-wall chain runs bit-for-bit across two worlds',
      div === -1,
      div === -1 ? '200 steps identical' : `diverged at step ${div}`,
    );
  }

  // --- W7: mid-clip rollback --------------------------------------------------
  // The strongest guarantee the mechanic asks for: a client that mispredicts
  // the approach (it never jumps, so it is grounded at the wall base when the
  // correction lands) must adopt truth mid-climb and replay the remaining clip
  // exactly onto the server.
  {
    const STEPS = 130;
    const history = record(course, STEPS, wallScriptAt);
    const attachAt = history.findIndex((s) => s.wallTicks > 0);
    const ACK = attachAt + 8;
    const HORIZON = 25;

    const wallRollback = (
      ack: number,
      horizon: number,
      clientScript: (s: number) => MoveInputData,
      forgetWall = false,
    ) => {
      const client = makeWorld(course);
      for (let s = 0; s <= ack; s++) {
        applyInput(client.sim, clientScript(s), FIXED_TIMESTEP);
        client.world.step();
      }
      const stale = { wall: client.sim.wallTicks, cd: client.sim.wallCooldownTicks };
      adoptTruth(client.sim, truthOf(history[ack]!), false);
      if (forgetWall) {
        client.sim.wallTicks = stale.wall;
        client.sim.wallCooldownTicks = stale.cd;
      }
      for (let s = ack + 1; s <= ack + horizon; s++) {
        applyInput(client.sim, wallScriptAt(s), FIXED_TIMESTEP);
        client.world.step();
      }
      return { client: snap(client.sim), server: history[ack + horizon]! };
    };

    const noJump = (s: number) => ({ ...wallScriptAt(s), jump: false });
    check(
      'the rollback point really is mid-clip',
      ACK > attachAt && history[ACK]!.wallTicks > 0 && history[ACK + HORIZON]!.wallTicks === 0,
      `attach at ${attachAt}, truth wallTicks=${history[ACK]!.wallTicks}, ` +
        `after replay ${history[ACK + HORIZON]!.wallTicks}`,
    );
    {
      const r = wallRollback(ACK, HORIZON, noJump);
      check(
        'mid-clip rollback from a mispredicted client lands on the server',
        identical(r.client, r.server),
        `step ${ACK + HORIZON}: y=${r.client.y.toFixed(4)} vs ${r.server.y.toFixed(4)}, ` +
          `wallTicks ${r.client.wallTicks} vs ${r.server.wallTicks}`,
      );
    }
    {
      // Negative control: position and velocity adopted, the clip counters and
      // normal not. The replayed racer has no clip to re-enter and slides down
      // the face while the server keeps climbing, so it lands elsewhere.
      const r = wallRollback(ACK, HORIZON, noJump, true);
      check(
        'without the clip counters the same replay lands elsewhere (negative control)',
        r.client.y !== r.server.y || r.client.z !== r.server.z,
        `y=${r.client.y.toFixed(4)} z=${r.client.z.toFixed(4)} vs server ` +
          `y=${r.server.y.toFixed(4)} z=${r.server.z.toFixed(4)}`,
      );
    }
  }

  // --- W8: climbing off the top -----------------------------------------------
  // Press a climb past the wall's top edge (y=10) and the probe loses the face:
  // the clip drops with NO cooldown (a lost face is free), and the racer is
  // high enough to peel over the ridge and land clear of the wall.
  {
    const w = makeWorld(course);
    moveSimBody(w.sim, 0, 8.5, -4.2); // start high, a couple of units off the face
    const peaks: Snap[] = [];
    for (let t = 0; t < 140; t++) {
      applyInput(w.sim, wallClimbScriptAt(t), FIXED_TIMESTEP);
      w.world.step();
      peaks.push(snap(w.sim));
    }
    const peakY = Math.max(...peaks.map((s) => s.y));
    const drop = peaks.findIndex((s, i) => s.wallTicks === 0 && i > 0 && peaks[i - 1]!.wallTicks > 0);
    const attachStarts = peaks
      .map((s, i) => (s.wallTicks > 0 && (i === 0 || peaks[i - 1]!.wallTicks === 0) ? i : -1))
      .filter((i) => i >= 0);
    check(
      'a sustained climb presses the racer over the top of the wall',
      peakY > 9.5,
      `peak y=${peakY.toFixed(2)} (wall top at 10)`,
    );
    check(
      'the clip ends by losing the face at the top: no cooldown, high up, one clip',
      drop > 0 &&
        peaks[drop]!.wallCooldownTicks === 0 &&
        peaks[drop - 1]!.y > 9 &&
        attachStarts.length === 1,
      `drop at step ${drop} (last clipped y=${drop > 0 ? peaks[drop - 1]!.y.toFixed(2) : 'n/a'}), ` +
        `cooldown ${drop >= 0 ? peaks[drop]!.wallCooldownTicks : 'n/a'}, ` +
        `${attachStarts.length} attach(es) at ${attachStarts.join(', ')}`,
    );
    check(
      'after peeling over the top the racer lands clear and grounded',
      peaks[peaks.length - 1]!.grounded &&
        Math.abs(peaks[peaks.length - 1]!.z - FACE_Z) > 1,
      `final z=${peaks[peaks.length - 1]!.z.toFixed(2)} (face ${FACE_Z.toFixed(2)}), ` +
        `grounded=${peaks[peaks.length - 1]!.grounded}`,
    );
  }

  // --- W9: a clip cannot restart mid-air; only touching ground resets it -----
  // The racer burns a full budget climbing wall A, then keeps pressing INTO
  // the dead face on the way down -- cooldown spent, fast, inside probe range,
  // exactly the situation that used to chain clips into an infinite hover.
  // The WALL LOCK must hold all the way to the floor, and a fresh jump after
  // landing must be able to start the clip again.
  {
    const STEPS = 140;
    const log = record(course, STEPS, wallRestartScriptAt);
    const firstFree = log.findIndex((s, i) => s.wallTicks === 0 && i > 0 && log[i - 1]!.wallTicks > 0);
    const attachStarts = log
      .map((s, i) => (s.wallTicks > 0 && (i === 0 || log[i - 1]!.wallTicks === 0) ? i : -1))
      .filter((i) => i >= 0);
    const landed = log.findIndex((s, i) => i > firstFree && s.grounded);
    // A step where, without the lock, the attach gate would have fired:
    // airborne, cooldown spent, fast enough, inside probe range, pressing
    // into the face -- but wallLocked held it at zero.
    const wouldAttach = log.some(
      (s, i) =>
        i > firstFree &&
        i < (attachStarts[1] ?? STEPS) &&
        s.wallTicks === 0 &&
        s.wallLocked &&
        s.wallCooldownTicks === 0 &&
        Math.hypot(s.vx, s.vz) >= WALL.minSpeedToAttach &&
        s.z < FACE_Z + WALL.probeDist,
    );
    check(
      'the budget exit arms the wall lock and holds against a mid-air re-grab',
      firstFree > 0 && log[firstFree]!.wallLocked && wouldAttach,
      `exit at step ${firstFree} (lock ${firstFree >= 0 ? log[firstFree]!.wallLocked : 'n/a'}), ` +
        `would-be re-grab window=${wouldAttach}`,
    );
    check(
      'exactly one clip ends the fall: no restart until the racer touches ground',
      attachStarts.length === 2 &&
        attachStarts[0]! < firstFree &&
        attachStarts[1]! > landed &&
        landed > firstFree &&
        log[attachStarts[1]!]!.wallLocked === false,
      `${attachStarts.length} attaches at steps ${attachStarts.join(', ')}, ` +
        `first free ${firstFree}, landed ${landed}`,
    );
    check(
      'a fresh jump after landing restarts the clip (ground touched)',
      attachStarts[1]! > landed && log[attachStarts[1]!]!.wallTicks > 0,
      `second clip starts at step ${attachStarts[1]} (lands at ${landed})`,
    );
  }
}

/**
 * Springboard scripts against wall A.
 *
 * `armScript` roll-ups, ground-jumps once, then -- while ALREADY airborne and
 * closing on the face -- TAPS jump again: that fresh mid-air press arms the
 * bounce (~t24), which fires on contact (~t25). After landing it repeats the
 * same rhythm for a second bounce post-ground-reset (~t108).
 *
 * `holdScript` NEVER releases jump after the ground press, so it drives the
 * negative control: holding the launch jump into the face must not bounce.
 */
/**
 * The springboard bounce (WALL.bounce): a jump pressed while ALREADY airborne
 * and inbound to a wall face kicks the racer with the wall-jump vector -- UP
 * plus the HELD direction (into the wall = pop against it, away = launch off
 * it; no stick = the face's outward normal). It NEVER enters a clip, and --
 * like every wall exit -- restarts only after touching the ground. Holding
 * the ground jump into the face does nothing.
 */
function wallBounceIntoScriptAt(step: number): MoveInputData {
  if (step < 16) return input(0, -1, false, false); // roll up
  if (step < 17) return input(0, -1, false, true); // ground jump (single press)
  if (step < 24) return input(0, -1, false, false); // release; glide in
  if (step < 25) return input(0, -1, false, true); // TAP mid-air -> arm the bounce
  if (step < 105) return input(0, -1, false, false); // bounce ~24, land, rest
  if (step < 106) return input(0, -1, false, true); // ground jump #2
  if (step < 108) return input(0, -1, false, false); // release
  if (step < 109) return input(0, -1, false, true); // TAP mid-air -> arm again
  return input(0, -1, false, false); // bounce #2, land, done
}

/**
 * Same approach and mid-air tap, but the tap lands while pulling AWAY from
 * the wall: the kick must mirror into the OFF direction instead of INTO it --
 * same height, one kick, then the racer flies off the face and away.
 */
function wallBounceAwayScriptAt(step: number): MoveInputData {
  if (step < 16) return input(0, -1, false, false); // roll up
  if (step < 17) return input(0, -1, false, true); // ground jump (single press)
  if (step < 24) return input(0, -1, false, false); // release; glide in
  if (step < 25) return input(0, 1, false, true); // TAP mid-air while holding AWAY -> arm + kick off the face
  return input(0, 1, false, false); // keep holding away: fly off the face and land
}

function wallBounceHoldScriptAt(step: number): MoveInputData {
  if (step < 16) return input(0, -1, false, false); // roll up
  return input(0, -1, false, true); // ground jump at 16, HOLD forever -- never an airborne edge
}
async function testBounce(): Promise<void> {
  console.log('\n=== X. wall bounce (jump pressed mid-air; clip feature asleep) ===');
  if (!WALL.bounce || WALL.enabled) {
    skip('bounce', WALL.enabled ? 'superseded by the full clip feature' : 'WALL.bounce=false');
    return;
  }

  const course = wallCourse();
  const FACE_Z = -5.75 + PLAYER.radius;
  const STEPS = 150;

  // Negative control: jump from the ground and HOLD Space into the face. The
  // launch press happened grounded, so it must never arm the bounce -- no
  // contact bounce, no clip, no turnaround.
  const hold = record(course, STEPS, wallBounceHoldScriptAt);
  const holdBounces = hold.filter((s) => s.wallLocked).length;
  const holdMaxWall = Math.max(...hold.map((s) => s.wallTicks));
  check(
    'holding the ground jump into the face never bounces (and never clips)',
    holdBounces === 0 && holdMaxWall === 0,
    `bounces=${holdBounces}, max wallTicks=${holdMaxWall}`,
  );

  // Jump-triggered: a SECOND press, made mid-air, arms the bounce; it fires on
  // contact, then again after the ground reset. wallTicks never leaves 0.
  // Holding INTO the wall at the bounce pops the racer against the face --
  // same height, but the kick goes into the wall, so the capsule rides the
  // face up instead of flying away, and must never push through the plane.
  const log = record(course, STEPS, wallBounceIntoScriptAt);
  const maxWall = Math.max(...log.map((s) => s.wallTicks));
  const bounces = log
    .map((s, i) => (s.wallLocked && (i === 0 || !log[i - 1]!.wallLocked) ? i : -1))
    .filter((i) => i >= 0);
  const kick = bounces.length > 0 ? log[bounces[0]!]! : null;
  // The kick dominates the held-inward air control on the bounce step (vel =
  // jumpOut into the wall, jumpUp up, before one step of gravity/steer
  // bleeds it), and the racer then gains height against the face.
  const after = bounces.length > 0 ? log.slice(bounces[0]!, bounces[0]! + 12) : [];
  const peakY = after.length > 0 ? Math.max(...after.map((s) => s.y)) : 0;
  const minZ = after.length > 0 ? Math.min(...after.map((s) => s.z)) : FACE_Z;
  check(
    'holding INTO the wall at the bounce pops against the face, never clipping through',
    kick !== null &&
      maxWall === 0 &&
      kick.vz <= -WALL.jumpOut * 0.75 &&
      kick.vy >= WALL.jumpUp * 0.75 &&
      peakY > kick.y + 0.4 &&
      minZ >= FACE_Z - 0.1,
    kick === null
      ? 'no bounce'
      : `kick at step ${bounces[0]!}: v=(${kick.vx.toFixed(2)}, ${kick.vy.toFixed(2)}, ` +
          `${kick.vz.toFixed(2)}), z=${kick.z.toFixed(2)} (face ${FACE_Z.toFixed(2)}), ` +
          `peak y=${peakY.toFixed(2)}, min z=${minZ.toFixed(2)}, max wallTicks=${maxWall}`,
  );

  // Direction flip: the SAME mid-air press, but with the stick pulled AWAY
  // from the wall, must launch the racer OFF the face -- the kick mirrors.
  // Same height; only the horizontal direction changed.
  const awayLog = record(course, STEPS, wallBounceAwayScriptAt);
  const awayBounces = awayLog
    .map((s, i) => (s.wallLocked && (i === 0 || !awayLog[i - 1]!.wallLocked) ? i : -1))
    .filter((i) => i >= 0);
  const awayKick = awayBounces.length > 0 ? awayLog[awayBounces[0]!]! : null;
  const awayAfter = awayBounces.length > 0 ? awayLog.slice(awayBounces[0]!, awayBounces[0]! + 12) : [];
  const awayPeakZ = awayAfter.length > 0 ? Math.max(...awayAfter.map((s) => s.z)) : 0;
  const awayPeakY = awayAfter.length > 0 ? Math.max(...awayAfter.map((s) => s.y)) : 0;
  check(
    'holding AWAY from the wall at the bounce launches off the face (same height)',
    awayKick !== null &&
      awayBounces.length === 1 &&
      awayKick.vz >= WALL.jumpOut * 0.75 &&
      awayKick.vy >= WALL.jumpUp * 0.75 &&
      awayPeakZ > awayKick.z + 0.25 &&
      awayPeakY > awayKick.y + 0.4,
    awayKick === null
      ? 'no bounce'
      : `kick at step ${awayBounces[0]!}: v=(${awayKick.vx.toFixed(2)}, ${awayKick.vy.toFixed(2)}, ` +
          `${awayKick.vz.toFixed(2)}), z=${awayKick.z.toFixed(2)} (face ${FACE_Z.toFixed(2)}), ` +
          `peak z=${awayPeakZ.toFixed(2)} y=${awayPeakY.toFixed(2)}`,
  );

  const landed = bounces.length > 0 ? log.findIndex((s, i) => i > bounces[0]! && s.grounded) : -1;
  check(
    'one bounce per airtime: the lock holds until the racer lands, then resets',
    bounces.length === 2 &&
      landed > bounces[0]! &&
      bounces[1]! > landed &&
      log.every((s) => s.wallTicks === 0),
    `${bounces.length} bounce(s) at ${bounces.join(', ')}, landed step ${landed}`,
  );

  // ANGLE knob (`WALL.bounceMinAngleDeg`): an armed approach steeper than the
  // gate fires the bounce; a shallower skim skates straight past it -- no
  // bounce, no clip -- even though the extended probe reaches the face for
  // both. Both runs start mid-air just off the face, moving along -X and into
  // -Z at the given angle, and tap jump on the first step to arm.
  {
    const minDeg = Math.min(90, Math.max(5, WALL.bounceMinAngleDeg));
    const reach = (PLAYER.radius + 0.01) / Math.sin((minDeg * Math.PI) / 180);
    const steepDeg = Math.min(85, minDeg + 15);
    const shallowDeg = Math.max(5, minDeg - 20);
    const off = Math.max(PLAYER.radius + 0.02, reach * Math.sin((steepDeg * Math.PI) / 180) * 0.85);
    const runAtAngle = (deg: number): Snap[] => {
      const w = makeWorld(course);
      const s = w.sim;
      const rad = (deg * Math.PI) / 180;
      const mx = -Math.cos(rad); // along the face (-X)
      const mz = -Math.sin(rad); // into the face (-Z)
      teleportBody(s, { x: 6, y: 3, z: FACE_Z + off });
      s.velocity.x = mx * 13;
      s.velocity.y = 0;
      s.velocity.z = mz * 13;
      const log: Snap[] = [];
      for (let i = 0; i < 6; i++) {
        applyInput(s, input(mx, mz, false, i === 0), FIXED_TIMESTEP); // fresh mid-air press arms
        w.world.step();
        log.push(snap(s));
      }
      return log;
    };
    const bounced = (log: Snap[]) => log.some((s) => s.wallLocked);
    const steepLog = runAtAngle(steepDeg);
    const shallowLog = runAtAngle(shallowDeg);
    check(
      `the bounce gate: >= ${steepDeg}° into the face bounces, a ${shallowDeg}° skim sails past`,
      bounced(steepLog) && !bounced(shallowLog),
      `steep ${steepDeg}° bounced=${bounced(steepLog)}, shallow ${shallowDeg}° bounced=${bounced(shallowLog)}`,
    );
  }
}

async function main(): Promise<void> {
  await initPhysics();
  // The production map, for the pads and the wire suite.
  const course = loadCourse();
  // Suites A and B were written against the original lane -- "the open lane",
  // "the start pad's right rail" -- so they stay pinned to it rather than
  // silently testing nothing when the production map changes.
  const lane = loadCourse(join(dirname(DEFAULT_COURSE_PATH), 'tekk-01.json'));

  console.log(`\nTEKK Day 3 harness - course "${course.id}" (${course.name}), ` +
    `${course.solids.length} solids, step ${(FIXED_TIMESTEP * 1000).toFixed(2)}ms`);

  await testDeterminism(lane);
  await testRollback(lane);
  testPads(course);
  if (WALL.enabled) testWalls();
  else skip('walls', 'wall-run is sleeping (WALL.enabled=false); the W section is dormant');
  await testBounce();
  // Guarded so a crash in the wire suite still prints the tally for A and B,
  // which do not depend on the server room at all.
  testRules(course);
  try {
    // The wire suite runs against Arena 01 (see createGameServer in testWire).
    await testWire(loadCourse(join(dirname(DEFAULT_COURSE_PATH), 'takk-arena.json')));
  } catch (err) {
    check('wire suite ran to completion', false, `crashed: ${String(err).slice(0, 160)}`);
  }
  try {
    // Its own server, its own port: the ballot needs three full match cycles,
    // so it must not share the wire suite's room.
    await testMapVote();
  } catch (err) {
    check('map vote suite ran to completion', false, `crashed: ${String(err).slice(0, 160)}`);
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