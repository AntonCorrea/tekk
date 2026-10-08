/**
 * TEKK game server
 *
 * `@colyseus/core` rather than the `colyseus` meta-package: the meta-package
 * drags in auth, Redis, an admin monitor and a playground, none of which this
 * game uses. The prediction engine we actually need -- `defineInput`,
 * `setFixedTimestep`, the reconciliation ack -- all lives in core.
 *
 * Run with `npm run server`, or `npm run dev` for server + client together.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { loadCourse, resolveCoursePath } from './course.ts';
import { loadCatalog } from './catalog.ts';
import { RaceRoom } from './room.ts';
import { DEFAULT_TIMINGS, type MatchTimings } from './rules.ts';

export interface GameServerOptions {
  /**
   * Phase lengths. Production never passes this and gets the `MATCH`
   * constants; the harness shortens them so a full match fits in a test run.
   */
  matchTimings?: Partial<MatchTimings>;
  /**
   * Course file. Production never passes this and gets the selected course
   * (`COURSE` env, else the default); the harness pins its wire tests to a
   * course whose layout they were written for.
   */
  coursePath?: string;
}

/**
 * Build the game server without listening.
 *
 * Split out from the bootstrap so tests can construct one on their own port.
 * `listen()` is the only part that touches the network, which is the only part
 * worth separating. The port and host belong to `listen`, not here.
 */
export function createGameServer(options: GameServerOptions = {}) {
  /**
   * A real HTTP server is required, not optional. The matchmaking routes and
   * the WebSocket upgrade both attach to it, and the Vite dev proxy forwards to
   * it.
   *
   * Note there is deliberately NO request listener here. Passing one is a trap,
   * and not an obvious one:
   *
   *   1. Node calls every registered listener for every request, in order.
   *      Colyseus installs its own listener on this same server.
   *   2. If this handler responds first, the response headers are already sent.
   *   3. Colyseus' adapter then calls `res.setHeader(...)` for its CORS headers,
   *      which throws ERR_HTTP_HEADERS_SENT.
   *   4. Its recovery path catches that and calls `res.removeHeader(...)` --
   *      which throws ERR_HTTP_HEADERS_SENT *again*, uncaught, and kills the
   *      process.
   *
   * That adapter runs for EVERY request, including `/`. So any route this
   * handler answers is a route that can crash the server, and `/` is the one a
   * browser requests first. Answering nothing is the only safe option; unknown
   * routes get Colyseus' own 404, which is fine.
   */
  const httpServer: HttpServer = createServer();

  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
  });

  // Timings are ALWAYS passed at define time, even in production. Colyseus
  // merges define-time options over the client's create options, so supplying
  // them here is what stops a client from creating a room with its own
  // `timings` and a one-second match.
  //
  // `coursePath` too, and ALWAYS as a concrete string: it is a path on this
  // server's disk, so a client-supplied value must never survive the merge.
  // Leaving the key out would let a client's own `coursePath` through. The
  // fallback is resolved here, once, so the file being served is decided at
  // define time (COURSE env, else the default) and the room only ever sees
  // the resulting path.
  gameServer.define('race', RaceRoom, {
    timings: { ...DEFAULT_TIMINGS, ...options.matchTimings },
    coursePath: options.coursePath ?? resolveCoursePath(),
  });

  return { gameServer, httpServer };
}

/**
 * Close the server and let in-flight sockets finish.
 *
 * `gracefullyShutdown(false)` skips the "wait forever for clients to leave"
 * behaviour, which is what you want on Ctrl-C: drop the room, exit.
 */
export function installShutdownHandlers(
  gameServer: Server,
): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      console.info(`\nTEKK server shutting down (${signal})`);
      gameServer.gracefullyShutdown(false).then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}

// ---------------------------------------------------------------- bootstrap

/**
 * Only listen when this file is the process entry point.
 *
 * `createGameServer` is imported by the verification harness, which needs the
 * real bootstrap but on its own port. An unguarded top-level `listen()` would
 * fight the harness for the default port.
 */
const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const PORT = Number(process.env['PORT'] ?? 2567);
  const HOST = process.env['HOST'] ?? '0.0.0.0';

  // Resolve and parse the selected course BEFORE listening: a bad COURSE
  // value should fail at boot with the file named, not as a join error on
  // the first match. Rooms re-read the file per match (room.ts), so course
  // edits still go live on the next match without a server restart.
  const course = loadCourse(resolveCoursePath());
  // The vote ballot, scanned the same way each room scans it: logged so the
  // boot line shows at a glance which maps a lobby can actually pick. Files
  // that do not parse are skipped with their own warning, not fatal here.
  const catalog = loadCatalog();

  const { gameServer } = createGameServer();
  await gameServer.listen(PORT, HOST);

  console.info(
    `TEKK server listening on http://${HOST}:${PORT}  ` +
      `(room "race", course "${course.id}" -- ${course.name}, ` +
      `${course.solids.length} solids, ` +
      `${catalog.length} maps in the vote [${catalog.map((entry) => entry.id).join(', ')}], ` +
      `node ${process.version})`,
  );

  installShutdownHandlers(gameServer);
}