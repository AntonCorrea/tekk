/**
 * Race geometry and formatting
 *
 * Pure logic shared by client and server. No Three.js, no DOM, no clock of its
 * own.
 *
 * The race state machine that used to live here is gone. The server owns the
 * phase and the timer now — see server/room.ts and shared/state.ts — so a
 * client cannot decide it has finished, and two clients cannot disagree about
 * when the race began. What remains is the geometry the server needs to detect
 * the goal, plus the formatting everyone displays.
 */

import type { Aabb, CourseGoal, Vec3Tuple } from '../shared/course.ts';
import { aabbOverlap, boxAabb } from '../shared/course.ts';

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