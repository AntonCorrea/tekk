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

/** One settled match, as the lobby shows it. */
export interface MatchRecordRow {
  /** The match id the contract assigned, counting from 0. */
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

/** How many matches the panel asks for. */
const LIMIT = 8;

/** The panel is a nicety; a long wait for it would be worse than not having it. */
const TIMEOUT_MS = 4000;

/**
 * Recent matches, newest first. Ordered by `matchId` rather than `endedAt`
 * because it is the sequence the contract assigns, so two matches in one block
 * still order exactly.
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
}`;

export interface Leaderboard {
  /** The latest rows, newest first. Empty until the first successful read. */
  rows(): readonly MatchRecordRow[];
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
    return { rows: () => [], refresh: () => {} };
  }

  let rows: readonly MatchRecordRow[] = [];
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
        return response.json() as Promise<{ data?: { Match?: unknown } }>;
      })
      .then((body) => {
        const parsed = parseRows(body.data?.Match);
        if (parsed) {
          rows = parsed;
          warned = false;
        }
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

  return { rows: () => rows, refresh };
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
    const mode = row['mode'];
    const txHash = row['txHash'];
    if (matchId === null || players === null || endedAt === null) continue;
    if (typeof courseId !== 'string' || typeof mode !== 'string' || typeof txHash !== 'string') {
      continue;
    }
    rows.push({ matchId, courseId, mode, players, endedAt, txHash });
  }
  return rows;
}

/** A finite number from a JSON value that may be a number or a numeric string. */
function toNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}