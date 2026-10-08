/**
 * Course catalog (server side)
 *
 * The set of maps a room may be voted to. Scanned from the directory the
 * default course lives in, parsed with the same `loadCourse` the room itself
 * uses, and filtered to courses Core Rush can actually play (a `coreSpawn`).
 *
 * The catalog is the allow-list a vote is checked against. Clients only ever
 * send course *ids*; which file an id resolves to is decided here, on this
 * server's disk, and never leaves it. That separation is the whole reason a
 * vote cannot become a file path: the id is a name, the path is ours.
 *
 * A file that does not parse is skipped with a warning rather than failing
 * the boot — a half-edited map on disk should not take the server down with
 * it, and the course the room actually runs is validated separately and
 * loudly (room.onCreate, and the bootstrap before it listens).
 */

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { DEFAULT_COURSE_PATH, loadCourse } from './course.ts';
import type { Course } from '../src/shared/course.ts';

/** A votable map. `path` is server-local and is never sent to a client. */
export interface CatalogEntry {
  /** Course id, as declared inside the file. What a vote names. */
  id: string;
  /** Display name, for the lobby card. */
  name: string;
  /** Shape of the card: `solids` / `pads` are the two counts it shows. */
  solids: number;
  pads: number;
  /** Absolute path on this server's disk. */
  path: string;
}

/** Build an entry for a course that is already parsed — e.g. the running one. */
export function catalogEntry(course: Course, path: string): CatalogEntry {
  return {
    id: course.id,
    name: course.name,
    solids: course.solids.length,
    pads: course.pads.length,
    path,
  };
}

/**
 * Every playable course next to the default one, sorted by id.
 *
 * Sorted and deduped by id so every room advertises the same list in the same
 * order regardless of filesystem readdir order. Unreadable and goal-mode
 * files are simply absent from the list; the catalog is UI data, and a UI
 * list is not a reason for a boot failure.
 */
export function loadCatalog(): CatalogEntry[] {
  const dir = dirname(DEFAULT_COURSE_PATH);

  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .sort();
  } catch (err) {
    console.warn(`[catalog] cannot list ${dir}: ${describe(err)}`);
    return [];
  }

  const seen = new Set<string>();
  const entries: CatalogEntry[] = [];

  for (const file of files) {
    const path = join(dir, file);
    let course: Course;
    try {
      course = loadCourse(path);
    } catch (err) {
      console.warn(`[catalog] skipping "${file}": ${describe(err)}`);
      continue;
    }

    // Core Rush has no Core to carry on a goal course; the room would reject
    // it anyway, so advertising it would be a vote that silently never lands.
    if (!course.coreSpawn) continue;

    if (seen.has(course.id)) {
      console.warn(`[catalog] skipping "${file}": duplicate id "${course.id}"`);
      continue;
    }

    seen.add(course.id);
    entries.push(catalogEntry(course, path));
  }

  return entries;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
