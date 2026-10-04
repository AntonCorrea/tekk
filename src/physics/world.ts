/**
 * Physics world
 *
 * Rapier is the single source of truth for collision. Nothing in this
 * project hand-rolls AABB tests — that is the mistake the previous engine
 * made, and it produced tunnelling, wall snagging and hitboxes that
 * disagreed with the visuals.
 */

import type { World } from '@dimforge/rapier3d-compat';
import { init, World as RapierWorld } from '@dimforge/rapier3d-compat';
import { FIXED_TIMESTEP, GRAVITY } from '../constants.ts';

let initialised = false;

export async function initPhysics(): Promise<void> {
  if (initialised) return;
  // Loads and instantiates the WASM module. Must complete before any
  // Rapier object is constructed.
  await init();
  initialised = true;
}

export function createPhysicsWorld(): World {
  if (!initialised) {
    throw new Error('initPhysics() must be awaited before createPhysicsWorld()');
  }

  const world = new RapierWorld(GRAVITY);
  world.timestep = FIXED_TIMESTEP;

  return world;
}