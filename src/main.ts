/**
 * TEKK — entry point
 *
 * Day 2 milestone: a course loaded from a JSON definition, a goal, and a
 * race clock. Physics is unchanged from Day 1 — the same character
 * controller, now standing on colliders built from data.
 *
 * Controls: WASD / arrows to move, Shift to sprint, Space to jump, R to restart.
 */

import './style.css';
import courseJson from './courses/tekk-01.json';
import { createStage } from './core/stage.ts';
import { startLoop } from './core/loop.ts';
import { buildScene, pulseGoal } from './render/scene.ts';
import { buildCourse, probeGround } from './course/build.ts';
import { initPhysics, createPhysicsWorld } from './physics/world.ts';
import { createPlayer, movePlayerTo, stepPlayer } from './physics/player.ts';
import { parseCourse } from './shared/course.ts';
import type { Vec3Tuple } from './shared/course.ts';
import {
  advanceRace,
  createRace,
  finishRace,
  hasReachedGoal,
  resetRace,
  startRace,
} from './game/race.ts';
import { createHud } from './ui/hud.ts';
import { clearInput, initInput, readInput } from './input.ts';
import { FIXED_TIMESTEP, PLAYER } from './constants.ts';

/** Lift above a surface so the capsule resolves a landing instead of starting inside it. */
const RESPAWN_CLEARANCE = 0.05;

async function boot(): Promise<void> {
  const container = document.querySelector<HTMLDivElement>('#app');
  if (!container) throw new Error('#app container missing from index.html');

  // Validated before anything touches the physics world — a malformed
  // course should fail with a readable message, not a broken collider.
  const course = parseCourse(courseJson, 'tekk-01.json');

  await initPhysics();
  const stage = await createStage(container);
  const world = createPhysicsWorld();
  const courseHandle = buildCourse(stage.scene, world, course);
  const player = createPlayer(world, course.spawn);
  const visuals = buildScene(stage);
  const hud = createHud(container);
  const race = createRace();

  initInput();
  globalThis.addEventListener('blur', clearInput);

  let restartRequested = false;
  globalThis.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR') restartRequested = true;
  });

  /** Put the player back on the course, on whichever pad is under the spawn point. */
  const respawn = (): void => {
    const probe = probeGround(world, course.spawn[0], course.spawn[2], course.spawn[1] + 4);
    const feetY = probe.topY !== null ? probe.topY + RESPAWN_CLEARANCE : course.spawn[1];
    movePlayerTo(player, course.spawn[0], feetY, course.spawn[2]);
  };

  startLoop(
    (dt) => {
      if (restartRequested) {
        restartRequested = false;
        respawn();
        resetRace(race);
        hud.hideBanner();
        clearInput();
      }

      const input = readInput();

      // Movement input is what starts the clock. A server-authoritative
      // version will send this instead of deriving it locally.
      if (race.phase === 'ready' && (input.forward !== 0 || input.strafe !== 0)) {
        startRace(race);
      }

      // Finished players still get physics — they can walk around the
      // course — but the clock is frozen.
      stepPlayer(world, player, input, dt);
      advanceRace(race, dt * 1000);

      // Fell out of the world.
      if (player.body.translation().y < course.killY) {
        respawn();
      }

      const position = player.body.translation();
      const center: Vec3Tuple = { x: position.x, y: position.y, z: position.z };

      if (
        race.phase === 'running' &&
        hasReachedGoal(center, PLAYER.radius, PLAYER.halfHeight, course.goal) &&
        finishRace(race)
      ) {
        hud.showFinish(race.finishedMs ?? 0);
      }
    },

    () => {
      const position = player.body.translation();
      const nowSeconds = performance.now() / 1000;
      visuals.sync(player);
      pulseGoal(courseHandle.goalMesh, nowSeconds);
      hud.update(
        {
          grounded: player.grounded,
          horizontalSpeed: player.horizontalSpeed,
          heightAboveKill: position.y - course.killY,
        },
        race,
        course.name,
      );
      stage.render();
    },
  );

  console.info(
    `TEKK — course "${course.id}" (${course.name}) · ` +
    `${course.solids.length} solids · ` +
    `fixed timestep ${(FIXED_TIMESTEP * 1000).toFixed(2)}ms · ` +
    'WASD move · Shift sprint · Space jump · R restart',
  );

  // Exposed for playtesting from the console: TEKK.teleport(-10, 2, -30)
  Object.assign(globalThis, {
    TEKK: {
      course,
      race,
      player,
      teleport(x: number, z: number, y?: number) {
        const probe = probeGround(world, x, z, (y ?? 60));
        movePlayerTo(player, x, probe.topY !== null ? probe.topY + RESPAWN_CLEARANCE : (y ?? 5), z);
      },
    },
  });
}

boot().catch((err) => {
  console.error('TEKK failed to start:', err);
  const el = document.createElement('pre');
  el.className = 'fatal';
  el.textContent = `TEKK failed to start:\n${err instanceof Error ? err.stack : String(err)}`;
  document.body.appendChild(el);
});