/**
 * Lobby leaderboard
 *
 * The client's only contact with the Monad side of TEKK. Every finished match
 * is settled on-chain by the server (server/matchRecord.ts writes the
 * MatchRecord contract) and an Envio HyperIndex indexer (indexer/) turns those
 * events into a GraphQL table. This module reads that table for the lobby's
 * records panel.
 *
 * Purely decorative and off by default: with `VITE_LEADERBOARD_URL` unset — or
 * the indexer unreachable — the lobby simply has no records. A missing or
 * broken leaderboard must never be able to break a lobby.
 */

import type { GameMode } from '../shared/course.ts';

/** One settled match, as the lobby shows it. */
export interface MatchRecordRow {
  /** The match id the contract assigned, counting from 1. */
  matchId: number;
  /** Course id the match was played on, e.g. `takk-arena`. */
  courseId: string;
  /** `hold`, `reach` or `hunt`. */
  mode: string;
  /** Racers present at match end. */
  players: number;
  /** Block time the match ended, in seconds. */
  endedAt: number;
  /** The tx that recorded it, for a receipt link. */
  txHash: string;
}

/** One racer's best result on one level. */
export interface TopPlayerRow {
  /** The racer's wallet. Never the zero address -- a guest seat has no identity. */
  wallet: string;
  /** The level's own score in ms: banked hold time, or finish time. */
  ms: number;
}

/**
 * A level's board: the best racers on one course in one mode.
 *
 * Keyed by mode as well as course because a mode belongs to a course but not
 * forever: flip a course from Core Rush to Race to the Core and the results
 * already settled on it keep their old meaning, so they stay a board of their
 * own rather than being ranked against a score they never played for.
 */
export interface LevelBoard {
  courseId: string;
  mode: GameMode;
  /** Best first, one row per wallet, at most three. */
  rows: TopPlayerRow[];
}

/**
 * How many matches the history panel asks for. Five, not a round ten: it sits
 * under the level boards, and what a racer looks for there is the tail they
 * just played.
 */
const LIMIT = 5;

/**
 * How many rows each of the two player lists asks for.
 *
 * The board takes the best three of them, so this cap only ever drops slow
 * results -- and the zero-address filter below keeps guest seats from spending
 * the budget at all.
 */
const BOARD_LIMIT = 120;

/** How many racers a level's board shows. */
const BOARD_ROWS = 3;

/** The address a guest seat is recorded as. Only a signed wallet has an identity. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** The panel is a nicety; a long wait for it would be worse than not having it. */
const TIMEOUT_MS = 4000;

/**
 * Recent matches, newest first. Ordered by `matchId` rather than `endedAt`
 * because it is the sequence the contract assigns, so two matches in one block
 * still order exactly.
 *
 * The same document carries the level boards, in two lists because each mode
 * scores its own way: `holdMs` descending ranks Core Rush, and `finishMs`
 * ascending ranks the racing modes (see `rankStandings` and `rankByFinish` in
 * `server/rules.ts`). One list cannot be sorted by both, and GraphQL aliases
 * keep it a single round trip -- which is what the in-flight guard and the
 * timeout below are sized for.
 */
const QUERY = `query LobbyRecords {
  Match(limit: ${LIMIT}, order_by: { matchId: desc }) {
    matchId
    courseId
    mode
    playerCount
    endedAt
    txHash
  }
  held: Player(limit: ${BOARD_LIMIT}, order_by: { holdMs: desc }, where: { holdMs: { _gt: 0 }, wallet: { _neq: "${ZERO_ADDRESS}" } }) {
    wallet
    holdMs
    match { courseId mode }
  }
  finished: Player(limit: ${BOARD_LIMIT}, order_by: { finishMs: asc }, where: { finishMs: { _gte: 0 }, wallet: { _neq: "${ZERO_ADDRESS}" } }) {
    wallet
    finishMs
    match { courseId mode }
  }
}`;

export interface Leaderboard {
  /** The latest rows, newest first. Empty until the first successful read. */
  rows(): readonly MatchRecordRow[];
  /**
   * The level boards: each level's best racers, best first. Empty until the
   * first successful read, and empty forever without an indexer configured.
   */
  topPlayers(): readonly LevelBoard[];
  /** Re-read the indexer. Cheap to call often; an in-flight read wins. */
  refresh(): void;
}

/**
 * Build the leaderboard reader for this page. With no configured URL it is an
 * inert stub — `refresh()` does nothing and `rows()` stays empty — which is
 * what keeps a local dev build (and the harness) independent of the indexer.
 */
export function createLeaderboard(): Leaderboard {
  const url = import.meta.env['VITE_LEADERBOARD_URL'];
  if (typeof url !== 'string' || url.length === 0) {
    return { rows: () => [], topPlayers: () => [], refresh: () => {} };
  }

  let rows: readonly MatchRecordRow[] = [];
  let boards: readonly LevelBoard[] = [];
  let inFlight = false;
  let warned = false;

  const refresh = (): void => {
    // One read in flight at a time: phase edges can arrive in bursts and the
    // panel only ever wants the newest answer.
    if (inFlight) return;
    inFlight = true;
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: QUERY }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`leaderboard HTTP ${response.status}`);
        return response.json() as Promise<{
          data?: { Match?: unknown; held?: unknown; finished?: unknown };
        }>;
      })
      .then((body) => {
        // The two halves are independent: a malformed board must not cost the
        // match history its refresh, or the other way round.
        const parsedRows = parseRows(body.data?.Match);
        if (parsedRows) rows = parsedRows;
        const parsedBoards = parseBoards(body.data?.held, body.data?.finished);
        if (parsedBoards) boards = parsedBoards;
        if (parsedRows || parsedBoards) warned = false;
      })
      .catch((err: unknown) => {
        // A leaderboard that cannot be read is not something the player needs
        // to see: say it once in the console, keep the last rows on screen.
        if (!warned) {
          warned = true;
          console.warn('leaderboard unavailable:', err instanceof Error ? err.message : err);
        }
      })
      .finally(() => {
        inFlight = false;
      });
  };

  return { rows: () => rows, topPlayers: () => boards, refresh };
}

/**
 * Validate the API's rows into the shape the panel renders. Anything malformed
 * is dropped rather than rendered: this data crossed a network and a chain, so
 * "trust but verify" beats a thrown frame.
 *
 * Numbers arrive as numbers or numeric strings (a GraphQL `BigInt` may be
 * either), so both are accepted; `null` means the whole response was malformed
 * and the previous rows should stand.
 */
function parseRows(raw: unknown): MatchRecordRow[] | null {
  if (!Array.isArray(raw)) return null;
  const rows: MatchRecordRow[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const matchId = toNumber(row['matchId']);
    const players = toNumber(row['playerCount']);
    const endedAt = toNumber(row['endedAt']);
    const courseId = row['courseId'];
    const mode = modeName(row['mode']);
    const txHash = row['txHash'];
    if (matchId === null || players === null || endedAt === null || mode === null) continue;
    if (typeof courseId !== 'string' || typeof txHash !== 'string') continue;
    rows.push({ matchId, courseId, mode, players, endedAt, txHash });
  }
  return rows;
}

/**
 * The level boards, assembled from the two player lists.
 *
 * Each list arrives best-first, so the first row seen for a course and wallet
 * IS that racer's best on it: the rest are dropped. A row is only read by the
 * list that ranks its mode, so a hold result on a course that has since become
 * a racing course is never compared on a metric it did not play for -- it
 * keeps a board of its own, under the mode it was settled in.
 *
 * Returns null (leaving the previous boards standing) when neither list is an
 * array, which is the malformed-response case. An empty array is a real answer
 * and means every level is genuinely empty.
 */
function parseBoards(held: unknown, finished: unknown): LevelBoard[] | null {
  if (!Array.isArray(held) && !Array.isArray(finished)) return null;
  const boards = new Map<string, LevelBoard>();

  const collect = (
    raw: unknown,
    metric: 'holdMs' | 'finishMs',
    wanted: readonly GameMode[],
  ): void => {
    if (!Array.isArray(raw)) return;
    // A score of zero is not a score: `rankStandings` makes the same call about
    // a match in which nobody held the Core at all.
    const floor = metric === 'holdMs' ? 1 : 0;
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as Record<string, unknown>;
      const wallet = row['wallet'];
      const ms = toNumber(row[metric]);
      const match = row['match'];
      if (typeof wallet !== 'string' || wallet.length === 0 || wallet === ZERO_ADDRESS) continue;
      if (ms === null || ms < floor) continue;
      if (typeof match !== 'object' || match === null) continue;
      const named = match as Record<string, unknown>;
      const courseId = named['courseId'];
      const mode = modeName(named['mode']);
      if (typeof courseId !== 'string' || mode === null || !wanted.includes(mode)) continue;

      const key = `${courseId}|${mode}`;
      const board = boards.get(key);
      if (board) {
        if (board.rows.length >= BOARD_ROWS) continue;
        if (board.rows.some((claimed) => claimed.wallet === wallet)) continue;
        board.rows.push({ wallet, ms });
        continue;
      }
      boards.set(key, { courseId, mode, rows: [{ wallet, ms }] });
    }
  };

  collect(held, 'holdMs', ['hold']);
  collect(finished, 'finishMs', ['reach', 'hunt']);

  // Deterministic order. The HUD lays the catalog's levels out first and any
  // board the catalog does not know about after them, in this order.
  return [...boards.values()].sort(
    (a, b) => a.courseId.localeCompare(b.courseId) || a.mode.localeCompare(b.mode),
  );
}

/**
 * The contract's mode code as the panel names it.
 *
 * `mode` is an `Int` on chain — 0 hold, 1 reach, 2 hunt — which GraphQL hands
 * back as a JSON number, not the name the panel renders. An unrecognised code is
 * dropped rather than guessed at, so a match is never mislabelled.
 */
function modeName(code: unknown): GameMode | null {
  switch (toNumber(code)) {
    case 0: return 'hold';
    case 1: return 'reach';
    case 2: return 'hunt';
    default: return null;
  }
}

/** A finite number from a JSON value that may be a number or a numeric string. */
function toNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}