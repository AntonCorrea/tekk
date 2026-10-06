/**
 * Match formatting
 *
 * Pure logic shared by client and server. No Three.js, no DOM, no clock of its
 * own.
 *
 * The goal-box geometry that used to live here went with the race: Core Rush
 * has no finish line, and the rules that replaced it (pickup, steal, ranking)
 * are server decisions that live in server/rules.ts. What remains is the time
 * formatting everyone displays.
 */

/** `M:SS.mmm` — the format a speedrunner would want to read. */
export function formatTime(ms: number): string {
  const safe = Math.max(0, ms);
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.floor(safe % 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}
