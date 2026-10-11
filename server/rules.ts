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

// -------------------------------------------------------------- map votes

/**
 * Which map the next match runs on, from the votes cast.
 *
 * Plurality of the votes actually cast: the catalog id with the most votes
 * wins — but only if exactly one id holds the top count. A tie, no votes, or
 * votes that only reach ids outside the catalog all return `currentId`: the
 * room stays on the map it is already running, which is the outcome nobody
 * can call unfair after the fact.
 *
 * Iterated over `catalogIds` rather than the tally's own keys, so the winner
 * cannot depend on the order players happened to vote in. Abstaining (an
 * empty `votedFor`) is simply not a vote; one player out of four can still
 * pick the map if nobody contests it.
 */
export function chooseMapVote(
  votes: readonly string[],
  catalogIds: readonly string[],
  currentId: string,
): string {
  const tally = new Map<string, number>();
  for (const id of votes) {
    if (id === '') continue;
    tally.set(id, (tally.get(id) ?? 0) + 1);
  }
  if (tally.size === 0) return currentId;

  let bestId = '';
  let bestCount = 0;
  let tied = false;
  for (const id of catalogIds) {
    const count = tally.get(id) ?? 0;
    if (count === 0) continue;
    if (count > bestCount) {
      bestId = id;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) {
      tied = true;
    }
  }

  // `bestId === ''` means every vote named an id outside the catalog, which
  // the room never accepts — belt and braces against the same stay-put rule.
  return tied || bestId === '' ? currentId : bestId;
}

// ------------------------------------------------------------ mid-match skip

/**
 * Whether a running match has been voted out: a strict majority of every
 * racer currently connected wants to skip.
 *
 * Half the room is not a majority — with two players that means both of
 * them, so a minority can never force out a match the other player wants to
 * finish. The denominator is the whole room rather than the voters:
 * abstaining is a vote to play on, and a racer who disconnects takes their
 * own flag out of the count the moment they leave.
 */
export function hasSkipMajority(skipVotes: number, players: number): boolean {
  return skipVotes * 2 > players;
}

// ---------------------------------------------------------------- match flow

/** Phase lengths in ms. Production uses `MATCH`; tests may shorten them. */
export interface MatchTimings {
  lobbyMs: number;
  countdownMs: number;
  durationMs: number;
  resultsMs: number;
}

export const DEFAULT_TIMINGS: MatchTimings = {
  lobbyMs: MATCH.lobbyMs,
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
  for (const key of ['lobbyMs', 'countdownMs', 'durationMs', 'resultsMs'] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`match timing "${key}" must be a positive number, got ${String(value)}`);
    }
    out[key] = value;
  }
  return out;
}

/** How long a phase lasts — every phase has a length; ready is the lobby window. */
export function phaseLengthMs(phase: MatchPhase, timings: MatchTimings): number {
  switch (phase) {
    case 'ready':
      return timings.lobbyMs;
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
  /** Time left in the (possibly new) phase, ms. */
  remainingMs: number;
}

/**
 * Advance the match clock by one fixed tick.
 *
 * `ready` is the lobby: a timed window (`lobbyMs`) with an early exit. The
 * moment every player in the room has voted, the countdown begins at once —
 * the ballot decides, not the clock. The window only remains as the fallback
 * for abstentions, and it only ticks while the room is occupied (an empty
 * room holds its full window, so a late joiner always gets the whole lobby
 * to vote). Input is ignored and racers stand frozen at their spawns until
 * the countdown lets the match through. Every other phase leaves when its
 * length is used up. At most one transition per tick, and a phase entered
 * this tick starts at 0 ticks.
 */
export function advancePhase(
  clock: PhaseClock,
  occupied: boolean,
  allVoted: boolean,
  dtMs: number,
  timings: MatchTimings,
): PhaseAdvance {
  if (clock.phase === 'ready') {
    if (!occupied) return { clock, entered: null, remainingMs: timings.lobbyMs };
    // A full ballot ends the lobby immediately: with every player's vote on
    // the table the countdown starts now, however much window was left.
    if (allVoted) return enter('countdown', timings);
    const ticks = clock.ticks + 1;
    // Same epsilon as the timed phases below: lobbyMs must be a whole number
    // of fixed ticks for the window to end on schedule.
    if (ticks * dtMs >= timings.lobbyMs - 1e-6) return enter('countdown', timings);
    return {
      clock: { phase: 'ready', ticks },
      entered: null,
      remainingMs: timings.lobbyMs - ticks * dtMs,
    };
  }

  const ticks = clock.ticks + 1;
  const length = phaseLengthMs(clock.phase, timings);
  // A small epsilon so 180 ticks of 16.666...ms meets a 3000ms deadline
  // instead of missing it by a rounding error and running one tick long.
  if (ticks * dtMs >= length - 1e-6) return enter(nextPhase(clock.phase), timings);

  return { clock: { phase: clock.phase, ticks }, entered: null, remainingMs: length - ticks * dtMs };
}

function enter(phase: MatchPhase, timings: MatchTimings): PhaseAdvance {
  return { clock: { phase, ticks: 0 }, entered: phase, remainingMs: phaseLengthMs(phase, timings) };
}
