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
import { RaceRoom } from './room.ts';

/**
 * Build the game server without listening.
 *
 * Split out from the bootstrap so tests can construct one on their own port.
 * `listen()` is the only part that touches the network, which is the only part
 * worth separating. The port and host belong to `listen`, not here.
 */
export function createGameServer() {
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

  gameServer.define('race', RaceRoom);

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

  const { gameServer } = createGameServer();
  await gameServer.listen(PORT, HOST);

  console.info(
    `TEKK server listening on http://${HOST}:${PORT}  ` +
      `(room "race", node ${process.version})`,
  );

  installShutdownHandlers(gameServer);
}