/**
 * Vite config
 *
 * There is deliberately no dev proxy here. The Colyseus client talks to the
 * game server directly, on its own origin.
 *
 * The proxy was tried first and it is a trap, for a reason worth recording:
 *
 *   - The WebSocket URL is `/{processId}/{roomId}` -- a bare two-segment path.
 *     Any rule matching `/` catches it, but any rule matching a two-segment path
 *     also catches Vite's own `/src/main.ts`. The two cannot be told apart by
 *     shape.
 *   - Reconnection opens a socket at the origin root with `?sessionId=`, so even
 *     namespacing the game traffic under a prefix does not fully separate it.
 *   - And the symptom is brutal: the `'/'` prefix match also swallows `GET /`,
 *     so opening the page returns the *game server's* root response (its version
 *     banner) instead of `index.html`.
 *
 * None of that is necessary, because Colyseus allows cross-origin browser
 * access by default -- `@colyseus/core` sends `Access-Control-Allow-Origin: *`
 * on its routes. The client is pointed at the server in `src/main.ts` via
 * `VITE_SERVER_URL`, defaulting to `http://localhost:2567` in dev.
 */

import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Fixed, and not `strictPort`. If something else already holds 5173 -- a
    // Vite orphan from a killed terminal is the usual culprit -- Vite picks the
    // next free port instead of failing. That is the safer failure mode, but it
    // means the URL can move, so read the printed address rather than assuming.
    port: 5173,
  },
  build: {
    target: 'es2023',
    // Rapier's WASM is base64-inlined by rapier3d-compat, so the entry chunk
    // is dominated by it. The warning is expected; the alternative
    // (vite-plugin-wasm) is deferred until the size actually matters.
    chunkSizeWarningLimit: 6000,
  },
});
