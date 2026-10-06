/**
 * Core Rush rules -- pure decisions
 *
 * Every rule that decides an outcome lives here, as a function of plain data:
 * who picks up a free Core, who steals a carried one, how the match clock
 * advances, and who won. No Rapier, no Colyseus, no clock of their own.
 *
 * The room (server/room.ts) gathers positions after the world step, asks these
 * functions what happened, and applies the answer. Keeping the decision apart
 * from the plumbing is what lets the harness pin the rules down exhaustively
 * without a network, and it means a tie-break is written once rather than
 * being an accident of Map iteration order.
 *
 * Determinism: every choice that could tie resolves by distance, then by
 * sessionId. Nothing here depends on the order the room happens to iterate
 * racers in, so two servers given the same bodies always agree.
 */

import { MATCH } from '../src/constants.ts';
import type { MatchPhase } from '../src/shared/state.ts';

/** A body centre, as the room reads it off Rapier after the step. */
export interface Point {
  x: number;
  y: number;
  z: number;
}

/** A racer as the rules see it: an id and a body centre. */
export interface RacerPoint extends Point {
  id: string;
}

/** A racer who might steal: also whether it dashed during this step. */
export interface Challenger extends RacerPoint {
  dashing: boolean;
}

// ------------------------------------------------------------------ the Core

/**
 * The racer nearest `target` within `radius`, or '' if none.
 *
 * Squared distances, so there is no `sqrt` to round two candidates onto the
 * same value. `<=` makes the radius inclusive. Exact distance ties fall to the
 * lowest sessionId -- arbitrary, but fixed, which is all a tie-break needs.
 */
export function nearestWithin(target: Point, candidates: readonly RacerPoint[], radius: number): string {
  const limit = radius * radius;
  let bestId = '';
  let bestD2 = Infinity;

  for (const c of candidates) {
    const dx = c.x - target.x;
    const dy = c.y - target.y;
    const dz = c.z - target.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > limit) continue;
    if (d2 < bestD2 || (d2 === bestD2 && c.id < bestId)) {
      bestId = c.id;
      bestD2 = d2;
    }
  }

  return bestId;
}

/**
 * Who takes a free Core this tick: anyone whose centre is within
 * `pickupRadius`, no dash needed. Returns '' when nobody is close enough.
 */
export function choosePickup(core: Point, racers: readonly RacerPoint[], pickupRadius: number): string {
  return nearestWithin(core, racers, pickupRadius);
}

/**
 * Who steals a carried Core this tick, or ''.
 *
 * Three conditions, all required:
 *   - the carrier's immunity has run out;
 *   - the challenger dashed during this step (a racer merely running through
 *     the carrier -- they pass through each other -- steals nothing);
 *   - the challenger's centre is within `stealRadius` of the carrier's.
 *
 * The carrier itself is excluded by id, so a carrier finishing the dash that
 * won it the Core cannot "steal" from itself.
 */
export function chooseStealer(
  carrier: RacerPoint,
  challengers: readonly Challenger[],
  stealRadius: number,
  immuneRemainingMs: number,
): string {
  if (immuneRemainingMs > 0) return '';
  const eligible = challengers.filter((c) => c.dashing && c.id !== carrier.id);
  return nearestWithin(carrier, eligible, stealRadius);
}

// ----------------------------------------------------------------- standings

export interface Score {
  id: string;
  holdMs: number;
  lastHeldAtMs: number;
}

export interface Standings {
  /** sessionIds, best first. Index + 1 is the rank. */
  order: string[];
  /** Rank 1's sessionId if they held the Core at all, else ''. */
  winnerId: string;
}

/**
 * Final standings.
 *
 * Most hold time first. Equal hold time goes to whoever held the Core more
 * recently (`lastHeldAtMs` descending) -- the racer who had it at the end did
 * something the other did not. Then sessionId, so the order is total.
 *
 * Nobody wins a match in which nobody touched the Core: a winner with 0 ms
 * would be a sessionId tie-break dressed up as a result.
 */
export function rankStandings(scores: readonly Score[]): Standings {
  const sorted = [...scores].sort(
    (a, b) =>
      b.holdMs - a.holdMs ||
      b.lastHeldAtMs - a.lastHeldAtMs ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const first = sorted[0];
  return {
    order: sorted.map((s) => s.id),
    winnerId: first !== undefined && first.holdMs > 0 ? first.id : '',
  };
}

// ---------------------------------------------------------------- match flow

/** Phase lengths in ms. Production uses `MATCH`; tests may shorten them. */
export interface MatchTimings {
  countdownMs: number;
  durationMs: number;
  resultsMs: number;
}

export const DEFAULT_TIMINGS: MatchTimings = {
  countdownMs: MATCH.countdownMs,
  durationMs: MATCH.durationMs,
  resultsMs: MATCH.resultsMs,
};

/**
 * Validate timings handed to the room. Anything missing falls back to the
 * production constant; anything present must be a positive, finite number,
 * because a 0 or NaN phase would either skip the match or never end it.
 */
export function resolveTimings(raw: unknown): MatchTimings {
  if (raw === undefined || raw === null) return { ...DEFAULT_TIMINGS };
  if (typeof raw !== 'object') throw new Error(`match timings must be an object, got ${typeof raw}`);

  const out = { ...DEFAULT_TIMINGS };
  for (const key of ['countdownMs', 'durationMs', 'resultsMs'] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`match timing "${key}" must be a positive number, got ${String(value)}`);
    }
    out[key] = value;
  }
  return out;
}

/** How long a phase lasts, or null for `ready`, which waits for movement. */
export function phaseLengthMs(phase: MatchPhase, timings: MatchTimings): number | null {
  switch (phase) {
    case 'ready':
      return null;
    case 'countdown':
      return timings.countdownMs;
    case 'playing':
      return timings.durationMs;
    case 'results':
      return timings.resultsMs;
  }
}

/** The phase that follows `phase` when its time is up. */
export function nextPhase(phase: MatchPhase): MatchPhase {
  switch (phase) {
    case 'ready':
      return 'countdown';
    case 'countdown':
      return 'playing';
    case 'playing':
      return 'results';
    case 'results':
      return 'ready';
  }
}

/**
 * The match clock is a count of fixed ticks spent in the current phase.
 *
 * Ticks, not wall-clock ms and not an accumulated float: a starved event loop
 * stretches real time but not ticks, so the match lasts the same number of
 * simulation steps on any machine, and the harness can reason about it
 * exactly. Converting to ms only at the edges keeps 1/60 s from piling up
 * rounding error over a 7200-tick match.
 */
export interface PhaseClock {
  phase: MatchPhase;
  /** Fixed ticks completed in `phase`. */
  ticks: number;
}

export interface PhaseAdvance {
  clock: PhaseClock;
  /** The phase entered on this tick, or null if the phase did not change. */
  entered: MatchPhase | null;
  /** Time left in the (possibly new) phase, ms. 0 in `ready`. */
  remainingMs: number;
}

/**
 * Advance the match clock by one fixed tick.
 *
 * `ready` has no deadline: it leaves only when someone moves. Every other
 * phase leaves when its length is used up. At most one transition per tick,
 * and a phase entered this tick starts at 0 ticks.
 */
export function advancePhase(
  clock: PhaseClock,
  anyoneMoving: boolean,
  dtMs: number,
  timings: MatchTimings,
): PhaseAdvance {
  if (clock.phase === 'ready') {
    if (!anyoneMoving) return { clock, entered: null, remainingMs: 0 };
    return enter('countdown', timings);
  }

  const ticks = clock.ticks + 1;
  const length = phaseLengthMs(clock.phase, timings)!;
  // A small epsilon so 180 ticks of 16.666...ms meets a 3000ms deadline
  // instead of missing it by a rounding error and running one tick long.
  if (ticks * dtMs >= length - 1e-6) return enter(nextPhase(clock.phase), timings);

  return { clock: { phase: clock.phase, ticks }, entered: null, remainingMs: length - ticks * dtMs };
}

function enter(phase: MatchPhase, timings: MatchTimings): PhaseAdvance {
  return { clock: { phase, ticks: 0 }, entered: phase, remainingMs: phaseLengthMs(phase, timings) ?? 0 };
}
