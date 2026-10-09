# Steal fairness & latency — design notes

**Status: diagnosis recorded, fix NOT built.** Deferred at the user's request
(Oct 2026). This file is the reference for whoever picks up "Steals feel
impossible / the game has a lot of latency."

## The complaint

"Hard to catch the player with the Core to steal." It reads as latency but is a
render-vs-authority position mismatch: you are aiming at a ghost that sits
roughly one-and-a-half steal radii behind where the server thinks the carrier is.

## Where the mechanic lives (with numbers)

- **The server decides steals.** `server/room.ts` `runCoreRules()` ->
  `chooseStealer()` (`server/rules.ts`): the challenger must have **dashed on
  the current tick** and be within `CORE.stealRadius` (1.4 units, centre to
  centre) of the carrier, with carrier immunity expired. At most one change of
  hands per tick. Note the rule only ever looks at the CURRENT tick.
- **You (the chaser) are rendered predicted** — your own body is a predicted
  local simulation, so you see yourself slightly *ahead* of server truth
  (by about your RTT/2).
- **The carrier is a remote racer**, interpolated at a point ~100ms in the
  past: `Predict.get(room, { mode: 'lerp', delay: 100 })` and
  `predict.attachAll('players', { mode: 'lerp' })` in `src/net/session.ts`
  (~lines 170-173), drawn in `src/net/remotes.ts` via `session.positionOf`.
  So the carrier you see lags server truth by roughly **patch latency (~RTT/2)
  + 100ms**.
- Server publishes truth at `patchRate = 50`/s (`server/room.ts`; the comment
  two lines above it still says "20 state patches/sec" and is stale).
- Carrier speed = `CORE.carrierSpeedFactor` × `MOVE.runSpeed` = 11.7 u/s.

**The offset:** (RTT/2 + 100ms) × 11.7 u/s ≈ **1.3–2.1 world units** at
typical RTTs. Against a 1.4-unit steal radius, a visible hit therefore requires
driving roughly **2.7–3.4 units** past the ghost. The dash reaches only
`DASH.speed` 32 × `DASH.durationTicks` 9 @60Hz ≈ **4.8 units**. The ghost
offset is the size of the whole mechanic.

## Proposed fixes (not built)

1. **Server-side dash-window grace — recommended.** Give the room a small
   tick-indexed ring buffer of recent positions per racer (≈8 ticks, ~133ms)
   and steal when a **dashing** racer's path came within steal radius of the
   carrier's path *at any point in the window*. This is the standard
   lag-compensation for melee in an authoritative sim.
   - Server-truth only: no client trust, no wire changes, no cheat surface.
   - The client's prediction replay never runs rules, so the buffer is
     room-only state → **bit-identical determinism untouched**.
   - Keep it pure: feed histories into a new/windowed `chooseStealer` in
     `server/rules.ts`; extend the section-C harness tests (including
     negatives: dashed near but outside the window steals nothing).
   - Non-dashing pass-throughs still steal nothing (as today).
   - Files: `server/rules.ts`, `server/room.ts`, `scripts/harness.ts`,
     `src/constants.ts`.
2. **Tuning — cheap and needed regardless of option 1.** `DASH.durationTicks`
   9 → ~13 (reach ≈7 u) and `CORE.stealRadius` 1.4 → ~1.8 in
   `src/constants.ts`. A graceful window on a 4.8-unit dash still cannot reach
   someone 5+ units away on a bad network.
3. **Client-side lead on remotes — follow-up.** Draw remotes ~0.12s ahead of
   their interpolated position using the already-published `vx`/`vz`, so you
   aim at the true carrier. Pure visual, the only option that fixes *seeing*
   the right thing, but led ghosts clip walls and overshoot at dash spikes;
   needs playtesting (maybe behind a debug toggle).
4. **Shrink `Predict` interpolation delay** 100 → ~70ms. Marginal alone, free,
   stacks with the rest. Also fix the stale "20 patches/sec" comment.

**Explicitly not recommended:** client-validated steals ("it counted on my
screen") — breaks the server-authoritative and determinism contracts the
codebase is built around, and opens a cheat surface.

## Decision state

- Recommended package: **1 + 2 now, 3 as an optional follow-up**.
- User chose to record the findings only; build deferred. Revisit after the
  map ballot / course editor work.