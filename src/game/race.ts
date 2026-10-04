/**
 * Race state machine
 *
 * Pure logic. No Three.js, no DOM, no timers of its own — the caller
 * supplies elapsed time. The server imports this module on Day 3 and
 * becomes the authority for the clock, so anything time-based or
 * side-effecting here would have to be rewritten.
 */

import type { Aabb, CourseGoal, Vec3Tuple } from '../shared/course.ts';
import { aabbOverlap, boxAabb } from '../shared/course.ts';

export type RacePhase = 'ready' | 'running' | 'finished';

export interface RaceState {
  phase: RacePhase;
  /** Time since the race started. Meaningless while phase is 'ready'. */
  elapsedMs: number;
  /** Race time when the goal was reached, or null if not yet. */
  finishedMs: number | null;
}

export function createRace(): RaceState {
  return { phase: 'ready', elapsedMs: 0, finishedMs: null };
}

/** Ready -> running. Only the first input should trigger this. */
export function startRace(state: RaceState): void {
  if (state.phase !== 'ready') return;
  state.phase = 'running';
}

/** Running -> finished, freezing the clock. Idempotent. */
export function finishRace(state: RaceState): boolean {
  if (state.phase !== 'running') return false;
  state.phase = 'finished';
  state.finishedMs = state.elapsedMs;
  return true;
}

/** Advance the clock by a fixed step. Call once per fixed timestep. */
export function advanceRace(state: RaceState, dtMs: number): void {
  if (state.phase !== 'running') return;
  state.elapsedMs += dtMs;
}

/** Back to the start without touching the clock history. */
export function resetRace(state: RaceState): void {
  state.phase = 'ready';
  state.elapsedMs = 0;
  state.finishedMs = null;
}

/**
 * Axis-aligned bounds of the player capsule, treated as a box.
 *
 * Exact for the goal test because the goal is also axis-aligned. Not
 * suitable for anything involving rotation.
 */
export function playerAabb(
  center: Vec3Tuple,
  radius: number,
  halfHeight: number,
): Aabb {
  return boxAabb([center.x, center.y, center.z], [radius * 2, halfHeight * 2, radius * 2]);
}

/** Has the player entered the goal volume? */
export function hasReachedGoal(
  playerCenter: Vec3Tuple,
  playerRadius: number,
  playerHalfHeight: number,
  goal: CourseGoal,
): boolean {
  return aabbOverlap(
    playerAabb(playerCenter, playerRadius, playerHalfHeight),
    boxAabb(goal.position, goal.size),
  );
}

/** `M:SS.mmm` — the format a speedrunner would want to read. */
export function formatTime(ms: number): string {
  const safe = Math.max(0, ms);
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.floor(safe % 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}