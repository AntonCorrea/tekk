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
export const DEFAULT_COURSE_PATH = resolve(here, '..', 'src', 'courses', 'tekk-01.json');

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