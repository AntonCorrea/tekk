# VHOLUME — moveset & translatability notes

**Status: recorded, nothing built.** Research notes from Oct 2026 (user asked to
stash them). Reference for anyone porting VHOLUME parkour *feel* into TEKK/Core
Rush course design or the motor.

## What it is

VHOLUME (IronEqual, Aug 2026) — first-person momentum parkour in a brutalist
city, by the Babbdi/Straftat team. Steam Workshop maps from launch; fan wikis:
`vholumegame.site`, `vholume-wiki.vercel.app`, `vholume.wiki`. Source code is
NOT public (closed commercial UE5 game) — the official mapping guide + Workshop
are the only extension path.

## The moveset

Explicitly built as **five chaining verbs around momentum retention**, not a
large move list.

| Action | Mechanics (from the wikis) |
|---|---|
| **Run** | Builds speed; slopes/declines are speed generators. Target ~26–27 units/s on standard routes. |
| **Jump** | Times off slope edges. Near speed cap: short hops, avoid excess height. Mouse-wheel bind common for rapid-fire hops. |
| **Slide** (crouch) | A normal landing kills forward momentum; **a slide turns the landing into a launch**. Raises speed, clears low gaps, and slide→jump is a core combo. |
| **Climb** | Contextual vertical grab; **costs forward momentum** — recovery tool only, not transport. |
| **Wall-run** | A **springboard, not a road**: wall contact → acceleration boost → jump away. Chain close walls to preserve momentum; tight corners give wall bounces. Shallow approach keeps speed, deep approach triggers climb/slow. |
| Extras | Bunny-hopping exists; wall-climb timing cancels fall damage / landing speed loss; ghost runs + leaderboards are the racing core. |

**Bindings:** WASD look+move, Space jump (wheel option), Ctrl/C slide, climb
contextual. Exact defaults are patch-dependent — the wikis say to verify in-game.

## Map files — can we read them? No, as-is

- Installed demo at `steamapps\common\VHOLUME Demo\`. All gameplay content is
  cooked into **one UE5 pak**: `VHOLUME\Content\Paks\VHOLUME-Windows.pak`
  (~1.3 GB). Zero loose `.umap`/`.uasset`, no readable config on disk.
- Extracting paks needs an external tool (install), and cooked `.umap` is
  binary chunks referencing cooked meshes — not an importable scene format.
- **No workshop maps exist locally** (demo only install → no
  `steamapps/workshop/content/4131730/`).
- Verdict: byte-level import is not worth it. **Translate the geometry grammar
  instead** by authoring courses, and the verbs by adding motor mechanics.

## Verb → tekk2 mapping (current motor)

tekk2 constants it maps against: `MOVE.runSpeed` 13, `jumpSpeed` 11.2,
`airControl` 0.5; `PHYSICS.maxSlopeClimb` π/4 (45°), `minSlopeSlide` π/8;
`DASH` 32 u/s × 9 ticks @60Hz; `CORE.carrierSpeedFactor` 0.9.

| VHOLUME verb | tekk2 today | Gap |
|---|---|---|
| Run + slope momentum | `runSpeed 13`, Rapier downhill accel (slopes ≤45°) | Mostly there — flat cap, no slope-specific tuning |
| Jump | `jumpSpeed 11.2`, `airControl 0.5` | Present; no bhop/coyote/buffer |
| Landing keeps speed | Physical landing retains horizontal momentum (no landing-kill rule) | Partly already solves what slide fixes |
| Slide / crouch | — | **New mechanic** (shared/sim.ts + input) |
| Climb | — | **New mechanic** |
| Wall-run springboard | — | **New mechanic** — the signature VHOLUME feel |
| Dash | `DASH` 32 u/s / 0.8s cd | tekk2's own; VHOLUME has none |

`shared/sim.ts` is the server↔client determinism contract: any new verb must be
implemented there, integer-tick based like DASH, and pass the section-B harness.
Course authoring needs no sim change — only `src/courses/*.json`.

## Decision state

- User chose to record only (Oct 2026). Future options, none committed:
  1. **Author a VHOLUME-inspired course** — slope speed-generator opener,
     wall-run-feel corridors (parallel walls), beam gaps, low slide-under gaps.
  2. **Wall-run motor mechanic** — touch wall + jump + angle → boost; biggest
     feel win, biggest scope; harness-gated.
  3. **Slide motor mechanic** — crouch that preserves/converts landing momentum;
     smaller than wall-run.