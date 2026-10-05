/**
 * TEKK — entry point
 *
 * Day 3 milestone: the game is multiplayer and server-authoritative. The
 * client sends intent and renders state; the server owns the course, the clock,
 * every position and the finishing order.
 *
 * The local racer is *predicted*: a keypress is applied to a local Rapier world
 * on the same frame, and rewound and replayed when the server disagrees. Other
 * racers are interpolated followers.
 *
 * Controls: WASD / arrows to move, Shift to sprint, Space to jump.
 */

import './style.css';

import { createStage } from './core/stage.ts';
import { startFrameLoop } from './core/loop.ts';
import { buildScene } from './render/scene.ts';
import { buildCourse, pulseGoal } from './course/build.ts';
import { createPhysicsWorld, initPhysics } from './physics/world.ts';
import { readPose } from './physics/player.ts';
import { connectSession } from './net/session.ts';
import { createRacerVisuals } from './net/remotes.ts';
import { createHud, type ConnectionStatus } from './ui/hud.ts';
import { clearInput, initInput, stageInput } from './input.ts';
import { FIXED_TIMESTEP } from './constants.ts';

/**
 * Where the game server is.
 *
 * Not `location.origin`. Colyseus serves `Access-Control-Allow-Origin: *` by
 * default, so the browser may talk to it cross-origin and there is nothing to
 * proxy. `VITE_SERVER_URL` overrides this, which is how the production build
 * learns its deployed address.
 */
function resolveEndpoint(): string {
  const configured = import.meta.env['VITE_SERVER_URL'];
  if (typeof configured === 'string' && configured.length > 0) return configured;

  if (import.meta.env.DEV) return 'http://localhost:2567';

  // Failing loudly beats silently defaulting to localhost in a deployed build,
  // where it would present as "the game just never connects".
  throw new Error(
    'VITE_SERVER_URL is not set. A production build needs the address of the ' +
      'Colyseus server, e.g. VITE_SERVER_URL=https://tekk.example.com npm run build',
  );
}

async function boot(): Promise<void> {
  const container = document.querySelector<HTMLDivElement>('#app');
  if (!container) throw new Error('#app container missing from index.html');

  await initPhysics();

  const stage = await createStage(container);

  // The client's Rapier world holds the course colliders and your own capsule,
  // and nothing else. `connectSession` builds both from the course the server
  // sends, using the same shared builder the server used.
  const world = createPhysicsWorld();
  const session = await connectSession(world, { endpoint: resolveEndpoint() });
  const { course, sim } = session;

  const courseHandle = buildCourse(stage.scene, course);
  const visuals = buildScene(stage);
  const remotes = createRacerVisuals(stage.scene, session);
  const hud = createHud(container);

  initInput();
  globalThis.addEventListener('blur', clearInput);

  // --- connection status, for the HUD only -------------------------------
  let connection: ConnectionStatus = 'connected';

  session.room.onError(() => {
    connection = 'lost';
  });

  session.room.onLeave((code, reason) => {
    connection = 'lost';
    console.warn(`TEKK left the room (code ${code}${reason ? `: ${reason}` : ''})`);
  });

  // Exposed for playtesting from the console: TEKK.state, TEKK.predict
  Object.assign(globalThis, {
    TEKK: {
      course,
      session,
      world,
      get player() {
        return sim;
      },
    },
  });

  const loop = startFrameLoop(({ now, delta }) => {
    // --- input --------------------------------------------------------
    // One call drives reconciliation and reports how many fixed input steps
    // this frame owes. Each step gets its own staged input and its own send,
    // because the reconciler replays from the buffer — batching them into one
    // send would collapse several simulation steps into one.
    const steps = session.pump(now);
    for (let step = 0; step < steps; step++) {
      stageInput(session.input.data);
      session.input.send();
    }

    // --- render -------------------------------------------------------
    // Read the predicted body, not the last authoritative state. That gap is
    // the entire point of prediction: what you see is where you just moved to,
    // not where the server last agreed you were.
    const pose = readPose(sim);
    visuals.sync({ ...pose, grounded: sim.grounded });

    remotes.sync();
    pulseGoal(courseHandle.goalMesh, now / 1000);

    hud.update(session.room.state, session.sessionId, course.name, connection);
    stage.render();

    // Referenced so the frame delta is not dead weight in this signature —
    // cosmetics that need smoothing time will use it.
    void delta;
  });

  console.info(
    `TEKK — "${course.id}" (${course.name}) · ` +
      `${course.solids.length} solids · ` +
      `${session.room.state.players.size} racing · ` +
      `step ${(FIXED_TIMESTEP * 1000).toFixed(2)}ms · ` +
      `you are "${session.self()?.name ?? '—'}" · ` +
      'WASD move · Shift sprint · Space jump',
  );

  globalThis.addEventListener('beforeunload', () => loop.stop());
}

boot().catch((err) => {
  console.error('TEKK failed to start:', err);
  const el = document.createElement('pre');
  el.className = 'fatal';
  el.textContent = `TEKK failed to start:\n${err instanceof Error ? err.stack : String(err)}`;
  document.body.appendChild(el);
});