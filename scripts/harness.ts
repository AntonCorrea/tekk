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
 *   C. Wire. A real Colyseus server and a real SDK client, in one process:
 *      schema encode/decode, input transport, sanitize, authoritative step,
 *      clock, goal, reset.
 *
 * Run it more than once. An earlier version of the wire suite gave its
 * end-to-end autopilot a flat 15s wall-clock budget, which made the whole
 * harness a measurement of machine load: it reported anywhere from 25/4 to
 * 32/0 on identical code, and four assertions cascaded off a single missed
 * finish. A green run therefore proved very little. The autopilot is now
 * progress-driven, and the run is reliable enough to trust once.
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
import { hasReachedGoal } from '../src/game/race.ts';
import { CORE, DASH, FIXED_TIMESTEP, MOVE, PLAYER } from '../src/constants.ts';

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
    applyInput(rivalB, scriptAt(step + 7), FIXED_TIMESTEP);
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

// ==================================================================== C: wire

async function testWire(course: Awaited<ReturnType<typeof loadCourse>>) {
  console.log('\n=== C. live server + SDK client ===');

  // Use the real bootstrap, not a stand-in. The HTTP handler is part of what
  // is under test: a well-meaning catch-all in either place collides with
  // Colyseus' own listener and only shows up at join time.
  const { createGameServer } = await import('../server/index.ts');

  const PORT = 25670 + Math.floor(Math.random() * 400);
  const { gameServer } = createGameServer();
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
  const room = await client.joinOrCreate('race', { name: 'HarnessOtter' });
  check('client joins the room', !!room.sessionId, `sessionId=${room.sessionId.slice(0, 8)}...`);

  // --- the course arrives -------------------------------------------------
  let courseJson = '';
  for (let i = 0; i < 100 && !courseJson; i++) {
    courseJson = room.state?.courseJson ?? '';
    if (!courseJson) await sleep(20);
  }
  check('server ships the course to the client', courseJson.length > 0, `${courseJson.length} bytes`);

  const { parseCourse } = await import('../src/shared/course.ts');
  let received = null;
  try {
    received = parseCourse(JSON.parse(courseJson), 'server');
  } catch (err) {
    check('client can validate the received course', false, String(err).slice(0, 120));
  }
  check(
    'client validates the course and it matches the server file',
    received !== null &&
      received!.id === course.id &&
      received!.solids.length === course.solids.length &&
      JSON.stringify(received) === JSON.stringify(course),
    received ? `${received!.solids.length} solids` : '',
  );

  // --- the server advertises its step rate --------------------------------
  check(
    'server advertises the input step rate to the client',
    room.input({ mode: 'reliable' }).stepSeconds !== undefined,
    `stepSeconds=${room.input({ mode: 'reliable' }).stepSeconds}`,
  );

  // --- drive real inputs --------------------------------------------------
  const handle = room.input({ type: MoveInput, mode: 'reliable' });

  // 1. Idle for a moment: the clock must NOT have started.
  for (let i = 0; i < 30; i++) {
    handle.data.moveX = 0;
    handle.data.moveZ = 0;
    handle.data.dash = false;
    handle.data.jump = false;
    handle.send();
    await sleep(16);
  }
  check(
    'idle input does not start the race',
    room.state.phase === 'ready',
    `phase=${room.state.phase}`,
  );

  // 2. Move: the clock starts and z goes negative (forward is -Z).
  const z0 = room.state.players.get(room.sessionId)!.z;
  for (let i = 0; i < 60; i++) {
    handle.data.moveX = 0;
    handle.data.moveZ = -1;
    handle.data.dash = false;
    handle.data.jump = false;
    handle.send();
    await sleep(16);
  }
  await sleep(120);

  const self = () => room.state.players.get(room.sessionId)!;
  check('the race starts on movement', room.state.phase === 'running', `phase=${room.state.phase}`);
  check('the server clock advances', room.state.elapsedMs > 0, `elapsedMs=${room.state.elapsedMs.toFixed(0)}`);
  check(
    'the authoritative racer moves forward',
    self().z < z0 - 3,
    `z ${z0.toFixed(2)} -> ${self().z.toFixed(2)}`,
  );

  // 3. Sanitize: an out-of-range axis must be clamped, not trusted.
  for (let i = 0; i < 10; i++) {
    handle.data.moveX = 0;
    handle.data.moveZ = -9999;
    handle.data.dash = false;
    handle.data.jump = false;
    handle.send();
    await sleep(16);
  }
  await sleep(150);
  check(
    'out-of-range input is clamped, not trusted',
    self().speed <= MOVE.runSpeed + 0.5,
    `speed=${self().speed.toFixed(2)} (tuned run is ${MOVE.runSpeed})`,
  );

  // 4. Goal detection is a pure function of position; check the geometry.
  check(
    'the goal box is detected at its own centre',
    hasReachedGoal(
      {
        x: course.goal.position[0],
        y: course.goal.position[1],
        z: course.goal.position[2],
      },
      PLAYER.radius,
      PLAYER.halfHeight,
      course.goal,
    ),
    `goal at ${course.goal.position.join(',')}`,
  );
  check(
    'the goal is NOT detected at the start pad',
    !hasReachedGoal(
      { x: course.spawn[0], y: 1, z: course.spawn[2] },
      PLAYER.radius,
      PLAYER.halfHeight,
      course.goal,
    ),
  );

  // 5. Respawn: is the spawn point on solid ground?
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

  // 6. Drive the whole course for real: hold sprint forward and hold jump.
  //    Holding jump is the crude autopilot -- it re-jumps on every landing, which
  //    clears the three gaps. This exercises the real finish path end to end:
  //    goal AABB, finishedMs, place, phase, and the auto-reset.
  //
  //    Progress-driven, NOT wall-clock driven. An earlier version gave this a
  //    flat 15s budget, which made the whole suite a measurement of machine load:
  //    sprinting and re-jumping three gaps sometimes takes longer than 15s under
  //    contention, the racer never reached the goal, and four assertions cascaded
  //    off that single miss. It reported 25/4 on a clean checkout of known-good
  //    code. The loop now runs until it finishes or genuinely stalls, with a
  //    ceiling generous enough that load alone cannot reach it.
  //
  //    "Stalled" means forward progress has stopped for STALL_MS while the racer
  //    is not finished. Measured on a loaded box the server's step loop starves,
  //    the identical trajectory stretches across more real seconds, and the
  //    drive once ran 58s against a 60s ceiling -- close enough to misreport a
  //    slow machine as a broken course. Wedge geometry or a respawn loop is a
  //    real failure worth reporting; running slowly is not.
  const STALL_MS = 3_000;
  const CEILING_MS = 120_000; // a loaded box was measured at 58s; typical is under 6s

  // The server race clock can ALREADY be running before this loop. Suite 4 above
  // moved the racer to start the race, so `startedAtMs` was set then -- measured
  // runs put this loop ~1.9s after the clock started. Bounding the absolute
  // finish time by `droveMs` therefore compared a value that INCLUDES that
  // earlier stretch against a drive that EXCLUDES it, a fixed ~1.9s deficit that
  // failed 8/8 runs. What this loop is responsible for is the clock DELTA across
  // the drive, and a wall-clock source cannot advance faster than real time.
  const clockAtDriveStart = room.state.elapsedMs;
  const startedAt = Date.now();
  let finishedAtMs = 0;
  let bestZ = Infinity;
  let lastProgressAt = startedAt;
  let stalls = 0;

  while (Date.now() - startedAt < CEILING_MS) {
    handle.data.moveX = 0;
    handle.data.moveZ = -1;
    handle.data.dash = false;
    handle.data.jump = true;
    handle.send();

    const me = self();
    if (me.finishedMs >= 0 && finishedAtMs === 0) finishedAtMs = me.finishedMs;
    if (finishedAtMs > 0) break;

    // Forward is -Z, so "further along" is a more negative z. Falling into a gap
    // respawns at the start pad and z jumps back positive; tracking the minimum
    // rather than the latest sample keeps progress monotonic across that.
    if (me.z < bestZ - 0.05) {
      bestZ = me.z;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt > STALL_MS) {
      stalls++;
      lastProgressAt = Date.now();
    }

    await sleep(16);
  }

  const droveMs = Date.now() - startedAt;
  console.info(
    `  [autopilot] ${finishedAtMs > 0 ? 'finished' : 'did NOT finish'} in ` +
      `${(droveMs / 1000).toFixed(1)}s of budget, reached z=${bestZ.toFixed(2)}, ` +
      `${stalls} stall(s)`,
  );

  check('a full sprint down the lane reaches the goal', finishedAtMs > 0,
    `finishedMs=${finishedAtMs} z=${bestZ.toFixed(2)} stalls=${stalls}`);

  // If the drive did not finish, the whole tail is unobservable: `phase` correctly
  // stays `running`, the results hold never starts and the auto-reset never fires.
  // Asserting on them would report three failures for what is one root cause -- the
  // goal was never crossed -- and bury the only line that matters.
  if (finishedAtMs === 0) {
    skip('the race clock advanced by the drive and no more than it took', 'never finished');
    skip("the finishing place is assigned", 'never finished');
    skip('the clock freezes at the finish line', 'never finished');
    skip('the phase closes once everyone has finished', 'never finished');
    skip('the room resets itself after the results hold', 'never finished');
    skip('the reset clears the finish time', 'never finished');
    skip('the reset returns the racer to the start pad', 'never finished');
    await room.leave();
    await gameServer.gracefullyShutdown(false);
    return;
  }

  // Bound the clock DELTA, not the absolute time. Two reasons the absolute
  // value is unusable here:
  //
  //   - `tickClock` reads `RoomClock.elapsedTime`, which is WALL-CLOCK, not
  //     simulated time. A server whose fixed-step loop is starved covers the
  //     identical trajectory in more real seconds: 5.7s on an idle box, 59.8s
  //     loaded, same course and same inputs. A hardcoded ceiling measures the
  //     machine, not the code.
  //   - the race clock starts on first movement, which suite 4 triggered, so
  //     the finish time includes ~1.9s before this drive loop even began.
  //
  // Subtracting the clock reading at loop entry removes both. What remains is
  // genuinely bounded: a wall-clock source cannot advance faster than the real
  // seconds elapsed, and the 500ms covers the ~50ms state-patch lag.
  check('the race clock advanced by the drive and no more than it took',
    finishedAtMs > 1000 && finishedAtMs - clockAtDriveStart <= droveMs + 500,
    `+${((finishedAtMs - clockAtDriveStart) / 1000).toFixed(2)}s on the clock ` +
      `over a ${(droveMs / 1000).toFixed(1)}s drive ` +
      `(finishedMs=${finishedAtMs}, clock was ${clockAtDriveStart.toFixed(0)} at entry)`);
  check('the finishing place is assigned', self().place === 1, `place=${self().place}`);
  check(
    'the clock freezes at the finish line',
    Math.abs(self().finishedMs - room.state.elapsedMs) < 60,
    `finishedMs=${self().finishedMs} elapsedMs=${room.state.elapsedMs.toFixed(0)}`,
  );
  // The player's finishedMs is set the moment the goal is crossed, but the room
  // only closes on a later server tick, once it has seen that everyone is done.
  // Checking immediately races that tick, and under load the scheduler loses.
  // Wait for it the same way the auto-reset below does.
  const closeDeadline = Date.now() + 10_000;
  while (Date.now() < closeDeadline && room.state.phase !== 'finished') await sleep(100);

  check('the phase closes once everyone has finished', room.state.phase === 'finished',
    `phase=${room.state.phase}`);

  // 7. Auto-reset back to the start pad. RESULTS_HOLD_MS is 10s, so the deadline
  //    has to clear it with room for a loaded scheduler to slip the timer.
  const resetDeadline = Date.now() + 40_000;
  while (Date.now() < resetDeadline && room.state.phase !== 'ready') await sleep(200);
  check('the room resets itself after the results hold', room.state.phase === 'ready',
    `phase=${room.state.phase}`);
  check('the reset clears the finish time', self().finishedMs === -1, `finishedMs=${self().finishedMs}`);
  // The phase and the position arrive in DIFFERENT patches: the phase flips on the
  // server tick, the teleported position at most one patch later (50ms). Reading z
  // in the same sample as the phase flip catches a stale position still sitting at
  // the finish line. Same class of bug as the phase check above -- wait for the
  // value rather than racing the patch.
  const padDeadline = Date.now() + 5_000;
  while (Date.now() < padDeadline && Math.abs(self().z - course.spawn[2]) >= 3) await sleep(50);

  check('the reset returns the racer to the start pad',
    Math.abs(self().z - course.spawn[2]) < 3, `z=${self().z.toFixed(2)} spawn z=${course.spawn[2]}`);

  await room.leave();
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