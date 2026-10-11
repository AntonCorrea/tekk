# TEKK

A multiplayer 3D physics game that runs in the browser. **Core Rush**: one
Core in the middle, whoever touches it carries it, and anyone can dash it
away. Two minutes per match, and whoever held the Core longest wins. The
server owns the course, the clock, and every player's position. Clients send
intent and render state; they never decide where anybody is.

Built for the [Monad Metropolis](https://monad.xyz/developers/hackathons/metropolis)
hackathon.

**Play it:** [tekk-1.onrender.com](https://tekk-1.onrender.com/)

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
npm run harness     # 136 checks
```

Three tiers, in increasing order of what they prove:

1. **Determinism** — two worlds from the same builder, same input script, must
   agree to the last bit. The claim the entire design rests on.
2. **Rollback** — a client that re-seeds from server truth and replays
   unacknowledged inputs must land exactly where the server did. The claim that
   makes rollback invisible.
3. **Wire** — a real Colyseus server and a real SDK client in one process:
   schema encode/decode, input transport, sanitize, authoritative step, match
   phases, Core pickup and steal, results, reset.

Alongside those, the pure rules in `server/rules.ts` (pickup, steal, ranking,
clock), the boost and jump pads, and the lobby map vote are tested directly.
The springboard bounce has its own suite: the kick fires into the wall when the
stick pushes in and off it when pulled away, the approach-angle gate turns
shallow skims aside, and a held ground jump never bounces — a negative control,
like the pad suite's.

One check is skipped while the wall-clip feature sleeps (`WALL.enabled =
false`), so a green run reports 133 passed / 1 skipped.

All three tiers run against real Rapier WASM, not mocks.

---

## Stack

| | |
|---|---|
| Rendering | Three.js WebGPU, WebGL2 fallback |
| Physics | Rapier (`@dimforge/rapier3d-compat`) — WASM, same code client and server |
| Networking | Colyseus 0.18 — schema state, input queue, prediction |
| Audio | Web Audio API — 130 BPM techno generated in code, no assets |
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

`npm run dev` starts both in one terminal.

### Controls

| | |
|---|---|
| Move | `WASD` / arrows |
| Jump | `Space` |
| Bounce | `Space` again **in mid-air** against a wall — the kick follows `WASD`: push in to pop against the wall, pull away to launch off it. |
| Dash | `Shift` — 32 u/s for 0.15 s, 0.8 s cooldown. The only way to steal. |
| Look | Mouse (click to capture, `Esc` to release) |
| Lobby | Drag to orbit the map, scroll to zoom — no capture in the lobby, the cursor stays free for the map cards. |
| Mute | `M` |

There is no separate sprint key. A map this size wants a dash, not a walk
speed toggle, so `Shift` belongs to the dash.

---

## How to play

| Phase | Length |
|---|---|
| `ready` | 30 s lobby — no racers on the map; vote for the next one. The countdown starts the moment everyone has voted (the window is the fallback) |
| `countdown` | 3 s — frozen at your spawn, GO releases you |
| `playing` | 120 s |
| `results` | 10 s, then back to `ready` |

- **Pickup** — the Core sits at the course's `coreSpawn`. Whoever is within
  1.2 m of it takes it, no dash required.
- **Carrying** — the carrier runs at 90% of normal speed and cannot dash.
- **Stealing** — dash within 1.4 m of the carrier to take the Core. The new
  carrier is immune for 1.5 s, and the robbed player stops accruing hold time.
- **Dropping** — if the carrier falls off the map or leaves, the Core returns
  to the centre.
- **Winning** — most total hold time wins. A tie goes to whoever held it most
  recently. Nobody wins a match in which nobody took the Core.
- **Pads** — a boost pad only pushes you if you are already heading its way,
  then holds 26 u/s for 0.6 s. A jump pad launches at 17 u/s, well above a
  normal jump.
- **Wall bounce** — press Jump again while already airborne into a wall and the
  racer kicks off it, about a jump's height. The horizontal kick follows the
  stick: hold toward the wall to pop forward against it, away to launch clear.
  One bounce per airtime — touching the ground resets it.

---

## Tests

```bash
npm run typecheck    # tsc --noEmit
npm run smoke        # 15 checks — routing, CORS, protocol
npm run harness      # 136 checks — determinism, rollback, rules, pads, bounce, wire, map vote
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

Three courses ship in `src/courses/`. The server loads and validates the one
it is pointed at at boot, so a typo in the JSON fails loudly at startup rather
than producing a collider in the wrong place.

| File | Solids | |
|---|---|---|
| `takk-newyork.json` | 52 | **The default.** Manhattan's street grid over the void, Times Square with the Core, Central Park, four skyscrapers to run around, rooftops reached by pad and ramp, and the Brooklyn Bridge's two opposed boost lanes to Brooklyn. |
| `takk-arena.json` | 16 | Compact Core Rush ring, one screen wide. |
| `tekk-01.json` | 8 | The original race course. Kept for reference; the room runs Core Rush. |

A course may carry an `atmosphere` block — background colour, fog colour and
fog density. Declaring one means the course owns its look, so the client
drops its generic ground grid and far-field skyline; the course's own
architecture supplies them instead. Only New York does; the other two keep
the towers.

The default is a single constant, `DEFAULT_COURSE_PATH` in `server/course.ts`.
A `COURSE` environment variable boots a different map without touching code
(`COURSE=takk-arena`, or a path to any course JSON), and the lobby vote swaps
the map between matches. Both are server-side choices only: the value is read
once at boot and never offered to clients, so the invariant below still holds.

The server ships the course to clients as raw JSON in room state. That is not
a convenience — if clients picked their own course, every player would be
raiding a different world while sharing a clock, which is not a match.

---

## Layout

```
src/
  shared/     the determinism contract — runs on BOTH sides
    sim.ts      physics step, dash, pads, wall bounce, fall detection, respawn
    state.ts    Colyseus schema definitions
    course.ts   course parsing and validation
    input.ts    the input struct both sides step with
  net/        client networking, prediction wiring, remote racers
  core/       frame loop and the stage — scene, lights, grid, far field, post
  render/     scene, camera rig, racer, city, the Core, palette, skyline
  physics/    world setup, pose reading
  course/     course meshes and neon edges
  courses/    the three course JSON files
  game/       time formatting
  ui/         the HUD
  audio/      generated techno
  main.ts     boot and frame wiring
server/       authoritative room, pure rules, course loading, bootstrap
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

- **The free tier is 0.1 CPU.** Single-player is comfortable; several players in
  one room may rubber-band. Not yet measured under load.
- **The server sleeps after 15 minutes idle** and takes about a minute to wake.
  First load after a quiet period looks like a hang.
- **The countdown parks everyone at their spawn.** The lobby's racers stand
  frozen there; when the lobby ends — every player has voted, or the window
  ran out — the server parks them again (the client renders that as a
  correction), and GO releases them.
- **New York is large for two players.** Catching a carrier across the map is
  hard. Not yet measured.
- **No GPU shows the raw error.** A device without WebGPU or WebGL2 gets the
  renderer's own message rather than a friendly one.
- **The tab title reads `TAKK`; everything else reads `TEKK`.** The README, the
  repository and every console message say TEKK, but `index.html` says
  `TAKK — Core Rush`, as do the course ids (`takk-newyork`, `takk-arena`) and
  the mute preference key. Left alone for now: picking a spelling is a
  separate job, and the `index.html` half of it is one line.
- **One unresolved bug.** In an early session the server stopped responding to
  HTTP entirely while the process stayed alive at 0% CPU — no spin, just no
  answers, with sockets leaked in `CloseWait`. It has not reproduced since, so
  the cause is still unknown. It is worth knowing about before a live demo.
