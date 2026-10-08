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
 * Controls: WASD / arrows move, Space jump, Shift dash, mouse look,
 * C flips the camera between AUTO follow and DRAG.
 */

import './style.css';

import { createStage } from './core/stage.ts';
import { startFrameLoop, type FrameInfo } from './core/loop.ts';
import { fxAberration, fxBeat, reducedMotion } from './render/fx.ts';
import { createTechno, type Intensity } from './audio/techno.ts';
import { buildScene } from './render/scene.ts';
import { buildCourse } from './course/build.ts';
import { createPhysicsWorld, initPhysics } from './physics/world.ts';
import { connectSession } from './net/session.ts';
import { createRacerVisuals } from './net/remotes.ts';
import { createHud, type ConnectionStatus } from './ui/hud.ts';
import { clearInput, initInput, lookAngles, stageInput, toggleCameraMode } from './input.ts';
import { initTouchControls } from './touch.ts';
import { createCoreVisual, type CoreVisualState } from './render/core.ts';
import type { LocalPose } from './render/scene.ts';
import { CAMERA, CORE, FIXED_TIMESTEP } from './constants.ts';

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
  // A course with its own city drops the generic grid and far-field slabs.
  if (course.ownCity) stage.useOwnCity();
  const visuals = buildScene(stage);
  const remotes = createRacerVisuals(stage.scene, session);
  const hud = createHud(container);
  const coreVisual = createCoreVisual(stage.scene);

  // Reused every frame: the loop below must not allocate.
  const localPose: LocalPose = {
    x: 0, y: 0, z: 0, vx: 0, vz: 0, speed: 0, grounded: false, carrying: false, dashing: false, teleported: false,
  };
  const coreState: CoreVisualState = { x: 0, y: 0, z: 0, carried: false, immune: false };

  // Seeded from the state we joined into, so a Core that has already changed
  // hands twenty times does not fire a wave the moment you arrive.
  let lastTransfers = session.room.state.coreTransfers;
  let lastCarrier = session.room.state.carrierId;

  // --- feel ----------------------------------------------------------------
  // Hit-stop: the image holds for a beat on a steal you were part of. Only the
  // picture freezes -- input, prediction and the server carry on underneath --
  // so it costs no gameplay, it just makes the moment land.
  let hitStopUntil = 0;
  let wasDashing = false;
  let airTime = 0;
  let lastCount = 0;
  // Set the first time a non-finite value is held back (see the frame body);
  // one console warning is enough to name the source when it happens.
  let warnedNonFinite = false;
  // Last FINITE look angles: they feed orbit() and back the staging yaw below
  // if the camera heading were ever non-finite, so a bad angle is dropped here
  // rather than reach the rig or the sim — one NaN in the sim takes movement
  // with it.
  let lastYaw = 0;
  let lastPitch: number = CAMERA.pitch;
  // Frames the smoothed render pose has been more than 8 units from the raw
  // body. A teleport glide closes within a few frames; persisting past 45
  // (~0.75s) means the interpolator is stuck, not smoothing — draw the body.
  let stalePoseFrames = 0;

  // --- sound ---------------------------------------------------------------
  // Browsers only allow audio after a gesture, so the first key or click
  // starts it. `M` mutes, and the choice is remembered.
  const techno = createTechno();
  const startAudio = (): void => techno.start();
  globalThis.addEventListener('keydown', startAudio, { once: true });
  globalThis.addEventListener('pointerdown', startAudio, { once: true });
  globalThis.addEventListener('keydown', (event) => {
    if (event.code === 'KeyM' && !event.repeat) techno.toggleMute();
  });

  // The renderer canvas is the pointer-lock target: clicking the game captures
  // the mouse for camera control, Escape releases it.
  initInput(window, stage.renderer.domElement);
  globalThis.addEventListener('blur', clearInput);

  // Thumb controls for touch-first devices. A no-op on desktop, where the
  // pointer-lock mouse above is the whole story and the overlay never mounts.
  initTouchControls(container, {
    onToggleMute: () => techno.toggleMute(),
    onToggleCamera: () => toggleCameraMode(),
  });

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

  const frame = ({ now, delta }: FrameInfo): void => {
    // --- input --------------------------------------------------------
    // One call drives reconciliation and reports how many fixed input steps
    // this frame owes. Each step gets its own staged input and its own send,
    // because the reconciler replays from the buffer — batching them into one
    // send would collapse several simulation steps into one.
    const steps = session.pump(now);

    // Read the look angles once per frame, not once per step: every step in
    // this batch must agree on the angles, and the values are sanitised on the
    // way in — they feed orbit()'s drag targets and back the staging yaw below,
    // and one non-finite angle would poison the rig or the sim until reload.
    // Hold the last finite angle instead.
    const rawLook = lookAngles();
    const look = {
      yaw: Number.isFinite(rawLook.yaw) ? rawLook.yaw : lastYaw,
      pitch: Number.isFinite(rawLook.pitch) ? rawLook.pitch : lastPitch,
    };
    lastYaw = look.yaw;
    lastPitch = look.pitch;

    // Stage against the camera's ACTUAL rendered heading, not the pointer's
    // target: W is the way the screen is facing in both modes (A/D strafe
    // across the screen, S backs toward the camera) — the third-person
    // contract. The heading is read once per frame so every step in the batch
    // agrees, exactly as the look angles above were. Yaw never leaves the
    // client: the wire carries the rotated world vector, so the server and
    // the determinism contract are untouched.
    const camYaw = visuals.heading();
    const stageYaw = Number.isFinite(camYaw) ? camYaw : look.yaw;

    for (let step = 0; step < steps; step++) {
      stageInput(session.input.data, stageYaw);
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
    let pose = session.renderPose();
    // `delta` drives the camera's follow smoothing. It was previously computed
    // and discarded, which is what let the camera silently assume 60fps.
    visuals.orbit(look.yaw, look.pitch);

    const state = session.room.state;
    const carrierId = state.carrierId;
    const selfCarries = carrierId === session.sessionId;

    // Draw from the reconciler's smoothed pose while it is usable, and fall
    // back to the raw body when it is not. Two failure modes must not kill
    // movement: a non-finite pose (which would freeze the racer and camera
    // while the HUD keeps ticking), and a pose that has stopped catching up —
    // a teleport glide closes within a few frames, so a gap from the body
    // persisting past 45 (~0.75s) means the interpolator is stuck, not
    // smoothing. The raw body is advanced by pump() without that
    // interpolation, so the camera's third-person follow and the racer keep
    // moving either way. (8 units ≈ how far a dash travels in one clamped
    // frame; anything smaller is ordinary smoothing.)
    const truth = sim.body.translation();
    const poseOk =
      Number.isFinite(pose.x) && Number.isFinite(pose.y) && Number.isFinite(pose.z);
    const bodyOk =
      Number.isFinite(truth.x) && Number.isFinite(truth.y) && Number.isFinite(truth.z);
    const velOk =
      Number.isFinite(sim.velocity.x) &&
      Number.isFinite(sim.velocity.z) &&
      Number.isFinite(sim.horizontalSpeed);
    const gap = poseOk
      ? Math.abs(pose.x - truth.x) + Math.abs(pose.y - truth.y) + Math.abs(pose.z - truth.z)
      : Infinity;
    stalePoseFrames = gap > 8 ? stalePoseFrames + 1 : 0;
    if (bodyOk && (!poseOk || stalePoseFrames > 45)) {
      pose.x = truth.x;
      pose.y = truth.y;
      pose.z = truth.z;
      if (!warnedNonFinite) {
        warnedNonFinite = true;
        console.warn('TEKK: render pose unusable, drawing the raw body instead', {
          pose,
          truth,
          stalePoseFrames,
          vx: sim.velocity.x,
          vz: sim.velocity.z,
          speed: sim.horizontalSpeed,
        });
      }
    }
    // Position: the (possibly repaired) pose — only ever finite values reach
    // localPose, so the camera rig can never latch a NaN.
    if (Number.isFinite(pose.x) && Number.isFinite(pose.y) && Number.isFinite(pose.z)) {
      localPose.x = pose.x;
      localPose.y = pose.y;
      localPose.z = pose.z;
    }
    // Velocity only overwrites while finite: the follow heading, FOV and speed
    // lines ease toward these, and NaN eases toward NaN until reload.
    if (velOk) {
      localPose.vx = sim.velocity.x;
      localPose.vz = sim.velocity.z;
      localPose.speed = sim.horizontalSpeed;
    } else if (!warnedNonFinite) {
      warnedNonFinite = true;
      console.warn('TEKK: non-finite velocity held back', {
        vx: sim.velocity.x,
        vz: sim.velocity.z,
        speed: sim.horizontalSpeed,
      });
    }
    localPose.teleported =
      Math.abs(localPose.x - truth.x) +
        Math.abs(localPose.y - truth.y) +
        Math.abs(localPose.z - truth.z) >
      8;
    localPose.grounded = sim.grounded;
    // The server's word decides who carries; the predicted sim only drives the
    // dash cue, which is yours and needs zero latency.
    localPose.carrying = selfCarries;
    localPose.dashing = sim.dashTicks > 0;
    visuals.sync(localPose, delta);

    remotes.sync(delta);
    courseHandle.update(delta);

    // --- the Core ------------------------------------------------------
    // Where it is drawn depends on who holds it, so it never visibly lags its
    // carrier: you, from your own render pose (the same one the capsule uses);
    // a remote carrier, from their interpolated position; free, from the
    // authoritative coordinates.
    const carrier = carrierId === '' || selfCarries ? undefined : state.players.get(carrierId);
    if (selfCarries) {
      // The sanitized localPose, not raw pose: a non-finite value here would
      // put NaN into the Core's matrix for as long as the state lasts.
      coreState.x = localPose.x;
      coreState.y = localPose.y + CORE.carryHeight;
      coreState.z = localPose.z;
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
      onHandOff(lastCarrier, carrierId, now);
    }
    lastCarrier = carrierId;

    // A dash of your own splits the colours a little; steals split them hard.
    if (localPose.dashing && !wasDashing) {
      fxAberration.value = Math.max(fxAberration.value, 0.35);
      techno.sfx.dash();
    }
    wasDashing = localPose.dashing;
    fxAberration.value *= Math.exp(-5 * delta);

    if (!sim.grounded) airTime += delta;
    else {
      if (airTime > 0.35) techno.sfx.land();
      airTime = 0;
    }

    // --- music follows the tension ---------------------------------------
    const remaining = state.phaseRemainingMs;
    let intensity: Intensity = 0;
    if (state.phase === 'countdown') intensity = 1;
    else if (state.phase === 'playing') {
      intensity = remaining <= 10_000 ? 3 : selfCarries || remaining <= 30_000 ? 2 : 1;
    }
    techno.setIntensity(intensity);

    // Countdown ticks on each whole second, and a GO when play starts.
    const count = state.phase === 'countdown' ? Math.ceil(remaining / 1000) : 0;
    if (count !== lastCount) {
      if (count > 0) techno.sfx.count(false);
      else if (lastCount > 0 && state.phase === 'playing') techno.sfx.count(true);
      lastCount = count;
    }

    // The arena and the Core breathe on the kick.
    fxBeat.value = techno.beat();

    hud.update(state, session.sessionId, course.name, connection, sim);
    // During hit-stop the canvas simply keeps its last frame.
    if (now >= hitStopUntil) stage.render();
  };

  // If the frame ever throws, requestAnimationFrame keeps firing (loop.ts
  // re-arms first) while nothing renders — a frozen or black screen with no
  // explanation and no console-scraping required from the tester. Catch it,
  // log it, and put the stack on screen after a second consecutive failure.
  let frameFailures = 0;
  const loop = startFrameLoop((info) => {
    try {
      frame(info);
      frameFailures = 0;
    } catch (err) {
      console.error('TEKK frame error:', err);
      frameFailures++;
      if (frameFailures >= 2 && !document.getElementById('tekk-frame-error')) {
        const el = document.createElement('pre');
        el.id = 'tekk-frame-error';
        el.className = 'fatal';
        el.textContent =
          `TEKK frame error:\n${err instanceof Error ? err.stack ?? String(err) : String(err)}`;
        document.body.appendChild(el);
      }
    }
  });

  /**
   * React to the Core changing hands. Your own gains and losses get the full
   * treatment -- callout, hit-stop, shake, colour split; other people's steals
   * get a small nudge so the arena still feels alive around you.
   */
  function onHandOff(from: string, to: string, now: number): void {
    const me = session.sessionId;
    const state = session.room.state;
    // Entering results frees the Core; that is the end of the match, not a play.
    if (state.phase !== 'playing') return;

    const nameOf = (id: string) => state.players.get(id)?.name ?? 'someone';
    const big = (): void => {
      if (!reducedMotion) hitStopUntil = now + 70;
      visuals.kick(0.6);
      fxAberration.value = 1;
    };

    if (to === me) {
      hud.announce(from === '' ? 'GOT IT' : 'TAKEN!', 'gain');
      if (from === '') techno.sfx.pickup();
      else techno.sfx.take();
      big();
    } else if (from === me) {
      hud.announce(to === '' ? 'DROPPED' : 'STOLEN!', 'loss');
      techno.sfx.lose();
      big();
    } else if (to !== '') {
      hud.announce(from === '' ? `${nameOf(to)} has it` : `${nameOf(to)} stole it`, 'info');
      visuals.kick(0.12);
      fxAberration.value = Math.max(fxAberration.value, 0.3);
    }
  }

  console.info(
    `TEKK — "${course.id}" (${course.name}) · ` +
      `${course.solids.length} solids · ` +
      `${session.room.state.players.size} racing · ` +
      `step ${(FIXED_TIMESTEP * 1000).toFixed(2)}ms · ` +
      `you are "${session.self()?.name ?? '—'}" · ` +
      'WASD move · Space jump · Shift dash · mouse look · C camera · M mute',
  );

  globalThis.addEventListener('beforeunload', () => {
    loop.stop();
    coreVisual.dispose();
    techno.dispose();
  });
}

boot().catch((err) => {
  console.error('TEKK failed to start:', err);
  const el = document.createElement('pre');
  el.className = 'fatal';
  el.textContent = `TEKK failed to start:\n${err instanceof Error ? err.stack : String(err)}`;
  document.body.appendChild(el);
});