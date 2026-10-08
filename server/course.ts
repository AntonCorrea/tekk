/**
 * Course loading (server side)
 *
 * The client no longer imports the course file. The server reads it, validates
 * it, and hands the raw definition to every client through room metadata.
 *
 * That is not a convenience. If clients picked their own course, each player
 * would be racing a different world while sharing a clock and a finish line,
 * which is not a race. One course, chosen by the server, is the minimum for the
 * result to mean anything.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCourse } from '../src/shared/course.ts';
import type { Course } from '../src/shared/course.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** Default course, relative to this file rather than the process cwd. */
export const DEFAULT_COURSE_PATH = resolve(here, '..', 'src', 'courses', 'takk-newyork.json');

/**
 * Which course this server serves, from the environment.
 *
 * `COURSE` swaps the map without editing code:
 *
 *     COURSE=takk-test npm run dev:server        bare id, src/courses/<id>.json
 *     COURSE=src/courses/takk-test.json npm ...  path, relative to the cwd
 *
 * Unset or empty falls back to `DEFAULT_COURSE_PATH`. The value is resolved
 * here but never parsed -- `loadCourse` does that, and its error names the
 * resolved path, so a typo fails with the file it actually looked for.
 *
 * Deliberately separate from `DEFAULT_COURSE_PATH`: the harness derives
 * sibling course paths from `dirname(DEFAULT_COURSE_PATH)`, so that constant
 * must keep naming the real default whatever the environment says. It is also
 * only read by the bootstrap and the room's define-time options -- never as a
 * fallback inside the room -- so a client can no more choose a course by
 * env-var than by create options.
 */
export function resolveCoursePath(env: NodeJS.ProcessEnv = process.env): string {
  const value = env['COURSE']?.trim();
  if (!value) return DEFAULT_COURSE_PATH;

  // A path separator makes it a path (resolved from the process cwd);
  // otherwise a bare course id next to the default, with or without its
  // `.json` tail.
  if (value.includes('/') || value.includes('\\')) return resolve(value);
  const id = value.endsWith('.json') ? value.slice(0, -'.json'.length) : value;
  return resolve(here, '..', 'src', 'courses', `${id}.json`);
}

/**
 * Read and validate a course from disk.
 *
 * Runs the same `parseCourse` the client used to run at import time, so a typo
 * in the JSON fails loudly at server boot instead of silently producing a
 * collider in the wrong place.
 */
export function loadCourse(path: string = DEFAULT_COURSE_PATH): Course {
  const source = path.split(/[\\/]/).pop() ?? path;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `Could not read course "${source}" at ${path}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  return parseCourse(raw, source);
}