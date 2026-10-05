/**
 * Smoke test -- does a browser get the game?
 *
 * Every other check in this project exercises the game server. None of them
 * exercise how Vite *routes*, which is where the last two real bugs lived:
 *
 *   - A catch-all HTTP handler on the game server answered `GET /` first,
 *     colliding with Colyseus' own listener and killing the process.
 *   - A `'/'` proxy rule is a prefix match, so it swallowed `GET /` and served
 *     Colyseus' version banner in place of `index.html`.
 *
 * Both produced a page that was not the game, and both passed a harness that
 * only checked status codes against the server. This asserts on *bodies* and on
 * what a real client can actually do.
 *
 * It starts its own Vite and its own game server on non-default ports, so it
 * never collides with a `npm run dev` you already have running.
 */

import { createServer as createHttpServer } from 'node:http';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { Client } from '@colyseus/sdk';

import { createGameServer } from '../server/index.ts';

const VITE_PORT = Number(process.env['SMOKE_VITE_PORT'] ?? 5199);
const GAME_PORT = Number(process.env['SMOKE_GAME_PORT'] ?? 2599);
const GAME_ORIGIN = `http://127.0.0.1:${GAME_PORT}`;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True if nothing is listening, so we can safely claim the port. */
async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createHttpServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function main(): Promise<void> {
  console.log(`\nTEKK smoke test -- vite :${VITE_PORT}, game server :${GAME_PORT}\n`);

  check('smoke test ports are free', (await portIsFree(VITE_PORT)) && (await portIsFree(GAME_PORT)),
    'set SMOKE_VITE_PORT / SMOKE_GAME_PORT to move them');

  // --- the game server, exactly as production builds it --------------------
  const { gameServer } = createGameServer();
  await gameServer.listen(GAME_PORT, '127.0.0.1');

  // Baked into the served bundle, so the assertion below proves the *browser*
  // would be pointed at this server -- not merely that the server exists.
  process.env['VITE_SERVER_URL'] = GAME_ORIGIN;

  let vite: ViteDevServer | undefined;
  try {
    // `server` here is merged OVER vite.config.ts, not replaced by it. Both
    // fields matter: the port override is what makes this hermetic, and
    // `strictPort` makes a clash a loud failure instead of Vite quietly picking
    // the next free port. Without it the test would silently drift onto
    // whatever port the running `npm run dev` had left, and the "ports are
    // free" assertion above would be checking a port nothing ever used.
    vite = await createViteServer({
      configFile: 'vite.config.ts',
      server: { port: VITE_PORT, strictPort: true },
    });
    await vite.listen();
  } catch (err) {
    check('vite starts', false, String(err).slice(0, 200));
    await gameServer.gracefullyShutdown(false);
    process.exit(1);
  }

  const viteOrigin = vite.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? `http://127.0.0.1:${VITE_PORT}`;
  check('vite starts', true, viteOrigin);
  check('vite took the port this test reserved, rather than drifting',
    viteOrigin.endsWith(`:${VITE_PORT}`),
    `wanted :${VITE_PORT}, got ${viteOrigin}`);

  try {
    // ============================================================ 1. the page

    const root = await fetch(`${viteOrigin}/`);
    const html = await root.text();

    check('GET / returns 200', root.status === 200, `HTTP ${root.status}`);

    // The assertion that would have caught the proxy bug. Not a status code --
    // the body. Colyseus' root handler answers 200 too.
    check('GET / serves the game page, not another server\'s root',
      html.includes('id="app"') && html.includes('/src/main.ts'),
      html.includes('id="app"') ? 'found #app and the entry module' : 'no #app mount point');
    check('GET / does not leak the game server\'s banner',
      !/Colyseus\s+\d+\.\d+/.test(html),
      /Colyseus\s+\d+\.\d+/.test(html) ? 'found a Colyseus banner in the page' : 'clean');

    // ==================================================== 2. the module graph

    const entry = await fetch(`${viteOrigin}/src/main.ts`);
    const entryText = await entry.text();
    check('the entry module compiles', entry.status === 200 && entryText.length > 500,
      `HTTP ${entry.status}, ${entryText.length} bytes`);

    // The endpoint the browser will actually dial. If this is wrong the game
    // silently never connects, which is exactly the deploy-day failure mode.
    check('the served bundle points at the game server',
      entryText.includes(GAME_PORT.toString()),
      GAME_ORIGIN);

    // ========================================== 3. the two roots are distinct

    const gameRoot = await fetch(`${GAME_ORIGIN}/`);
    const gameHtml = await gameRoot.text();
    check('the game server has its own root',
      !gameHtml.includes('id="app"'),
      `HTTP ${gameRoot.status}, ${gameHtml.trim().slice(0, 40)}`);

    // ============================== 4. cross-origin matchmaking actually works

    const cors = await fetch(`${GAME_ORIGIN}/matchmake/joinOrCreate/race`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: viteOrigin },
      body: JSON.stringify({ name: 'SmokeProbe' }),
    });
    const reservation = (await cors.json()) as { sessionId?: string; roomId?: string };
    check('the server allows the browser origin (CORS)',
      cors.status === 200 && Boolean(cors.headers.get('access-control-allow-origin')),
      `allow-origin: ${cors.headers.get('access-control-allow-origin') ?? '(none)'}`);
    check('matchmaking returns a usable seat reservation',
      Boolean(reservation.sessionId && reservation.roomId),
      `room ${reservation.roomId ?? '(none)'}`);

    // ===================== 5. a real client can join and get a working room

    // The closest thing to a browser that this environment allows. It exercises
    // matchmaking, the WebSocket handshake, and state decoding end to end using
    // the same endpoint the page was just served with.
    const client = new Client(GAME_ORIGIN);
    const room = await client.joinOrCreate('race', { name: 'SmokeOtter' });
    check('a client joins the room', Boolean(room.sessionId), `session ${room.sessionId.slice(0, 8)}...`);

    let courseJson = '';
    for (let i = 0; i < 100 && !courseJson; i++) {
      courseJson = room.state?.courseJson ?? '';
      if (!courseJson) await sleep(20);
    }
    const course = JSON.parse(courseJson || '{}') as { solids?: unknown[] };
    check('the room is playable (course delivered and decodable)',
      Array.isArray(course.solids) && course.solids.length > 0,
      `${course.solids?.length ?? 0} solids`);

    check('the room starts on a known phase', room.state.phase === 'ready', `phase=${room.state.phase}`);

    await room.leave();
  } finally {
    await vite.close();
    await gameServer.gracefullyShutdown(false);
  }

  // ================================================== what this cannot prove

  console.log(
    '\n  Not covered here: the WebSocket handshake with a real browser Origin\n' +
      '  header. Node\'s WebSocket cannot send one. `@colyseus/ws-transport`\n' +
      '  registers no origin check unless `beforeUpgrade` is passed, so this is\n' +
      '  verified by inspection rather than by execution.',
  );

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console.log('failures:\n  ' + failures.join('\n  ') + '\n');
    process.exit(1);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('\nsmoke test crashed:', err);
    process.exit(1);
  },
);
