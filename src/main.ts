/**
 * TEKK — entry point
 *
 * Core Rush: the game is multiplayer and server-authoritative. The client
 * sends intent and renders state; the server owns the clock, every position,
 * who holds the Core and the score.
 *
 * The local racer is *predicted*: a keypress is applied to a local Rapier world
 * on the same frame, and rewound and replayed when the server disagrees. Other
 * racers are interpolated followers.
 *
 * Controls: WASD / arrows move, Space jump, Shift dash, mouse look.
 */

import './style.css';

import { createStage } from './core/stage.ts';
import { startFrameLoop } from './core/loop.ts';
import { buildScene } from './render/scene.ts';
import { buildCourse } from './course/build.ts';
import { createPhysicsWorld, initPhysics } from './physics/world.ts';
import { connectSession } from './net/session.ts';
import { createRacerVisuals } from './net/remotes.ts';
import { createHud, type ConnectionStatus } from './ui/hud.ts';
import { clearInput, initInput, lookAngles, stageInput } from './input.ts';
import { createCoreVisual, type CoreVisualState } from './render/core.ts';
import type { LocalPose } from './render/scene.ts';
import { CORE, FIXED_TIMESTEP } from './constants.ts';

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

  buildCourse(stage.scene, course);
  const visuals = buildScene(stage);
  const remotes = createRacerVisuals(stage.scene, session);
  const hud = createHud(container);
  const coreVisual = createCoreVisual(stage.scene);

  // Reused every frame: the loop below must not allocate.
  const localPose: LocalPose = { x: 0, y: 0, z: 0, grounded: false, carrying: false, dashing: false };
  const coreState: CoreVisualState = { x: 0, y: 0, z: 0, carried: false, immune: false };

  // Seeded from the state we joined into, so a Core that has already changed
  // hands twenty times does not fire a wave the moment you arrive.
  let lastTransfers = session.room.state.coreTransfers;

  // The renderer canvas is the pointer-lock target: clicking the game captures
  // the mouse for camera control, Escape releases it.
  initInput(window, stage.renderer.domElement);
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

    // Read the look angles once per frame, not once per step. Every step in this
    // batch must use the same yaw: if the mouse moved mid-batch the steps would
    // disagree, and the server would simulate a path the client never predicted.
    const look = lookAngles();

    for (let step = 0; step < steps; step++) {
      stageInput(session.input.data, look.yaw);
      session.input.send();
    }

    // --- render -------------------------------------------------------
    // The reconciler's render pose, NOT `sim.body.translation()`.
    //
    // Prediction is still what is being shown — this is the predicted position,
    // not the last authoritative one, which was always the point. But the
    // reconciler interpolates it between fixed steps and absorbs each rollback
    // into a decaying offset. The raw body has neither: `adoptTruth` cuts it
    // straight to server truth ~20x/sec, so drawing it directly showed every
    // correction as a twitch. That is why remotes looked smooth and the local
    // racer did not — remotes went through `predict.value`, this did not.
    //
    // Must be read after `pump()`, which is what advances the reconciler.
    const pose = session.renderPose();
    // `delta` drives the camera's follow smoothing. It was previously computed
    // and discarded, which is what let the camera silently assume 60fps.
    visuals.orbit(look.yaw, look.pitch);

    const state = session.room.state;
    const carrierId = state.carrierId;
    const selfCarries = carrierId === session.sessionId;

    localPose.x = pose.x;
    localPose.y = pose.y;
    localPose.z = pose.z;
    localPose.grounded = sim.grounded;
    // The server's word decides who carries; the predicted sim only drives the
    // dash cue, which is yours and needs zero latency.
    localPose.carrying = selfCarries;
    localPose.dashing = sim.dashTicks > 0;
    visuals.sync(localPose, delta);

    remotes.sync();

    // --- the Core ------------------------------------------------------
    // Where it is drawn depends on who holds it, so it never visibly lags its
    // carrier: you, from your own render pose (the same one the capsule uses);
    // a remote carrier, from their interpolated position; free, from the
    // authoritative coordinates.
    const carrier = carrierId === '' || selfCarries ? undefined : state.players.get(carrierId);
    if (selfCarries) {
      coreState.x = pose.x;
      coreState.y = pose.y + CORE.carryHeight;
      coreState.z = pose.z;
    } else if (carrier) {
      const p = session.positionOf(carrier);
      coreState.x = p.x;
      coreState.y = p.y + CORE.carryHeight;
      coreState.z = p.z;
    } else {
      coreState.x = state.coreX;
      coreState.y = state.coreY;
      coreState.z = state.coreZ;
    }
    coreState.carried = selfCarries || carrier !== undefined;
    coreState.immune = state.immuneRemainingMs > 0;
    coreVisual.update(coreState, now / 1000, delta);

    // Once per hand-off. `coreTransfers` rather than `carrierId`, because the
    // same racer re-taking a dropped Core is still a transfer.
    if (state.coreTransfers !== lastTransfers) {
      lastTransfers = state.coreTransfers;
      coreVisual.burst();
    }

    hud.update(state, session.sessionId, course.name, connection, sim);
    stage.render();
  });

  console.info(
    `TEKK — "${course.id}" (${course.name}) · ` +
      `${course.solids.length} solids · ` +
      `${session.room.state.players.size} racing · ` +
      `step ${(FIXED_TIMESTEP * 1000).toFixed(2)}ms · ` +
      `you are "${session.self()?.name ?? '—'}" · ` +
      'WASD move · Space jump · Shift dash · mouse look',
  );

  globalThis.addEventListener('beforeunload', () => {
    loop.stop();
    coreVisual.dispose();
  });
}

boot().catch((err) => {
  console.error('TEKK failed to start:', err);
  const el = document.createElement('pre');
  el.className = 'fatal';
  el.textContent = `TEKK failed to start:\n${err instanceof Error ? err.stack : String(err)}`;
  document.body.appendChild(el);
});