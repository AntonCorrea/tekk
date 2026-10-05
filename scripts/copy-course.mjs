/**
 * Copy course assets into the compiled server tree.
 *
 * `tsc` only emits JavaScript. It does not copy non-TypeScript files, so after
 * a server build `dist-server/src/courses/` does not exist -- and
 * `server/course.ts` resolves its default path relative to its own compiled
 * location, so it looks for the course there and fails at runtime with ENOENT.
 *
 * That failure is invisible to `npm run smoke`, because the smoke test imports
 * `server/index.ts` directly and reads the course from `src/`, where the file
 * always was. It only shows up in a compiled build, which is the only thing
 * production ever runs. Hence this step.
 *
 * Copies the whole directory rather than one named file, so adding a second
 * course needs no change here.
 *
 * Run as part of `build:server`. Plain `.mjs` on purpose: it must work before
 * any dev tooling exists, since the point is that production needs none.
 */

import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

const from = join(projectRoot, 'src', 'courses');
const to = join(projectRoot, 'dist-server', 'src', 'courses');

if (!existsSync(from)) {
  // Loud, because the alternative is a server that boots and then fails every
  // single join with a confusing ENOENT instead of a build-time message.
  console.error(`copy-course: no course directory at ${from}`);
  process.exit(1);
}

const courses = readdirSync(from).filter((name) => name.endsWith('.json'));

if (courses.length === 0) {
  console.error(`copy-course: no .json courses in ${from}, refusing to build`);
  process.exit(1);
}

mkdirSync(dirname(to), { recursive: true });
cpSync(from, to, { recursive: true });

console.log(`copy-course: ${courses.join(', ')} -> ${to.replace(projectRoot + '\\', '')}`);