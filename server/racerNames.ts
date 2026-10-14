/**
 * The racer-name registry
 *
 * A racer name is off-chain and display-only: the chain record is an address, a
 * hold, a finish and a core count, so `MatchRecord` and the Envio indexer behind
 * it carry no name at all. That is why the lobby's level boards could only ever
 * read `0x1234…abcd` -- an address is all the chain knows.
 *
 * This module is where a name stops being per-session. The room holds a
 * verified wallet and a name together exactly once, at join, where the same
 * signed payload proves the wallet and carries the name, so that is the moment
 * the pair is trustworthy and the moment it is remembered. A rename writes the
 * entry again, which is why a name a racer changes shows on every record they
 * already appear in -- the panel resolves at read time, it does not store the
 * name per match.
 *
 * The room copies the registry into `GameState.names` at creation, because the
 * records panel renders from replicated state and needs the address -> name
 * join. Both halves of that join are already public: the panel fetches those
 * very addresses from the indexer and draws them.
 *
 * Persistence is best-effort. The file sits in an ignored `data/` next to the
 * server and is rewritten on every change; a missing or unwritable file costs
 * nothing but the names learned before the last restart, since the room fills
 * them back in as racers join. Note that a deploy on a host with an ephemeral
 * filesystem starts from an empty container, so the file does not survive one.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Where the registry is kept. A path rather than a JSON import: it is written
 * at runtime, so it can never be part of the build.
 */
const FILE = resolve(process.env['RACER_NAMES_FILE'] ?? 'data/racer-names.json');

/** wallet (lower-cased) -> name. Module-level: one registry, every room. */
const names = new Map<string, string>();

/** Whether the file has been read this process; the read happens once. */
let loaded = false;

/**
 * Read the registry from disk, once per process.
 *
 * Called by a room at creation rather than by the server bootstrap so every
 * entry point -- the server, the harness, a script that builds the server --
 * gets it without wiring. Idempotent: a second room copies what the first one
 * already read.
 */
export function loadRacerNames(): void {
  if (loaded) return;
  loaded = true;

  let raw: string;
  try {
    raw = readFileSync(FILE, 'utf8');
  } catch {
    // No file yet, or unreadable: an empty registry is the honest start.
    return;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return;
    for (const [wallet, name] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof name === 'string' && name.length > 0) names.set(wallet.toLowerCase(), name);
    }
  } catch (error) {
    // A corrupt file is not worth failing a room over; the next rename heals it.
    console.warn('[racerNames] ignoring an unreadable registry:', error);
  }
}

/** The registry as it stands, for a room to copy into its state. */
export function racerNames(): ReadonlyMap<string, string> {
  return names;
}

/**
 * Remember the name a wallet is racing under.
 *
 * `wallet` is the address the server recovered from the join signature, never a
 * client-supplied one; `name` is already through `sanitiseName`, because both
 * callers -- the join and the rename -- pass it first. A blank name is ignored
 * rather than stored, so a bad write can never leave a hole for the panel's
 * fallback to cover.
 */
export function rememberRacerName(wallet: string, name: string): void {
  const key = wallet.trim().toLowerCase();
  if (key.length === 0 || name.length === 0) return;
  if (names.get(key) === name) return;
  names.set(key, name);
  save();
}

/** Best-effort persist: a failed write is logged, never thrown into a join. */
function save(): void {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, `${JSON.stringify(Object.fromEntries(names), null, 2)}\n`);
  } catch (error) {
    console.warn('[racerNames] could not save the registry:', error);
  }
}
