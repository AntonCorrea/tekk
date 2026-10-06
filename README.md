# TEKK

A multiplayer 3D physics racer that runs in the browser. The server owns the
course, the clock, and every racer's position. Clients send intent and render
state; they never decide where anybody is.

Built for the [Monad Metropolis](https://monad.xyz/developers/hackathons/metropolis)
hackathon.

**Play it:** the deployed client is on Render (link in the repo description).

---

## The interesting part

Most browser multiplayer games either hide latency or paper over it. TEKK takes
the opposite approach: the local racer is **predicted and rolled back**, and the
whole thing is verified rather than assumed.

```
player presses W
  ├─ server   : receives input, steps authoritative Rapier world at 60 Hz
  └─ client   : steps an IDENTICAL Rapier world on the same frame
                 └─ if the server disagrees, rewind to server truth
                    and replay every input it hasn't had confirmed
```

The prediction is invisible because the replay lands in exactly the same place
the server did. That only holds if both sides simulate identically, which is a
strong claim. So it is tested:

```
npm run harness     # 32 checks
```

Three tiers, in increasing order of what they prove:

1. **Determinism** — two worlds from the same builder, same input script, must
   agree to the last bit. The claim the entire design rests on.
2. **Rollback** — a client that re-seeds from server truth and replays
   unacknowledged inputs must land exactly where the server did. The claim that
   makes rollback invisible.
3. **Wire** — a real Colyseus server and a real SDK client in one process:
   schema encode/decode, input transport, sanitize, authoritative step, clock,
   goal, reset.

All three run against real Rapier WASM, not mocks.

---

## Stack

| | |
|---|---|
| Rendering | Three.js WebGPU, WebGL2 fallback |
| Physics | Rapier (`@dimforge/rapier3d-compat`) — WASM, same code client and server |
| Networking | Colyseus 0.18 — schema state, input queue, prediction |
| Language | TypeScript, strict |
| Build | Vite |

`src/shared/sim.ts` is the determinism contract. `applyInput()` never calls
`world.step()` — the caller owns the timestep — so the two sides cannot drift
by accident.

---

## Running it

```bash
npm install

# terminal 1 — game server (:2567)
npm run server

# terminal 2 — client (:5173)
npm run dev:client
```

Then open `http://localhost:5173`. To play with someone else on your network,
run `npx vite --host` (npm does not pass `--host` through) and open
`http://<your-lan-ip>:5173`.

### Controls

| | |
|---|---|
| Move | `WASD` / arrows |
| Sprint | `Shift` |
| Jump | `Space` |
| Look | Mouse (click to capture, `Esc` to release) |

---

## Tests

```bash
npm run typecheck    # tsc --noEmit
npm run smoke        # 14 checks — routing, CORS, protocol
npm run harness      # 32 checks — determinism, rollback, full race
```

**Run the harness more than once.** An earlier version gave its end-to-end
autopilot a flat 15-second wall-clock budget, which made the suite a
measurement of machine load rather than of code: identical source reported
anywhere from 25/4 to 32/0, and four assertions cascaded off one missed finish.
The autopilot is now progress-driven and the run is trustworthy — but "one green
run" still proves much less than two.

---

## Deploy

Two Render services. The server first, because the client bakes its URL in at
build time.

**Game server** (Web Service)

| | |
|---|---|
| Build | `npm ci && npm run build:server` |
| Start | `npm start` |

**Client** (Static Site)

| | |
|---|---|
| Build | `npm ci && npm run build` |
| Publish directory | `dist` |
| Env | `VITE_SERVER_URL` = the game server URL |

Order matters. `VITE_SERVER_URL` is read at build time and baked into the
bundle, so building the client before the server exists produces a build whose
`resolveEndpoint()` throws at boot.

### Why the server is compiled

`npm run build:server` emits plain JavaScript to `dist-server/`, and `npm start`
runs that. Hosts install with `NODE_ENV=production`, which skips
devDependencies — so a start command depending on `tsx` would find nothing to
run. Compiling at build time leaves production with zero dev dependencies.

This needed a second tsconfig, because the client config cannot emit at all:
`allowImportingTsExtensions` requires `noEmit`. Sources import siblings with an
explicit `.ts` extension (`from '../src/constants.ts'`), which Vite resolves but
Node cannot, so `rewriteRelativeImportExtensions` rewrites them to `.js` on the
way out. That keeps the Vite-friendly convention in the source instead of
hand-editing forty imports.

`scripts/copy-course.mjs` runs after `tsc`, because `tsc` copies no
non-TypeScript files. Without it the server boots perfectly and then fails
*every* join with `ENOENT` — and `npm run smoke` cannot catch that, since it
imports `server/index.ts` and reads the course from `src/`, where the file
always was.

---

## Course

One course, `Lane 01`: eight solids, a start pad, and a finish gate. The server
loads and validates it at boot, so a typo in the JSON fails loudly at startup
rather than producing a collider in the wrong place.

The server ships the course to clients as raw JSON in room state. That is not a
convenience — if clients picked their own course, every player would be racing a
different world while sharing a clock and a finish line, which is not a race.

---

## Layout

```
src/
  shared/     the determinism contract — runs on BOTH sides
    sim.ts      physics step, fall detection, respawn
    state.ts    Colyseus schema definitions
    course.ts   course parsing and validation
  net/        client-side networking, prediction wiring
  render/     scene and camera rig
  physics/    world setup, pose reading
  game/       race rules — goal test, time formatting
server/       authoritative room, course loading, bootstrap
scripts/      harness, smoke test, build asset copy
```

Camera yaw is deliberately **client-only**. It rotates the camera and the input
vector before sending, which leaves `applyInput` and the determinism contract
untouched.

The local racer renders from the reconciler's interpolated pose, never from
`sim.body.translation()` — the raw body is cut straight to server truth about
20×/sec, so drawing it directly showed every correction as a twitch.

---

## Known limits

- **The free tier is 0.1 CPU.** Single-player is comfortable; several racers in
  one room may rubber-band. Not yet measured under load.
- **The server sleeps after 15 minutes idle** and takes about a minute to wake.
  First load after a quiet period looks like a hang.
- **One unresolved bug.** In an early session the server stopped responding to
  HTTP entirely while the process stayed alive at 0% CPU — no spin, just no
  answers, with sockets leaked in `CloseWait`. It has not reproduced since, so
  the cause is still unknown. It is worth knowing about before a live demo.