/**
 * Deterministic simulation core
 *
 * This module is the contract between client and server. Both import these
 * exact functions and run them with the same dt, which is what makes rollback
 * prediction reproduce the server instead of rubber-banding.
 *
 * Rules for anything added here:
 *   - No Three.js, no DOM, no timers, no randomness that isn't seeded.
 *   - No `Date.now()` / `performance.now()`. Time arrives as `dt`.
 *   - `applyInput` must not call `world.step()`. The caller decides when the
 *     world advances: the server steps once per tick after every player has
 *     been integrated, the client steps once per predicted input.
 *
 * Breaking any of those breaks prediction, and the symptom is a player who
 * jitters constantly rather than an error message. That is why it is worth
 * being strict here.
 */

import type {
  World,
  RigidBody,
  Collider,
  KinematicCharacterController,
} from '@dimforge/rapier3d-compat';
import { ColliderDesc, Cuboid, Ray, RigidBodyDesc } from '@dimforge/rapier3d-compat';
import { BOOST, CORE, DASH, GRAVITY, JUMP_PAD, MOVE, PHYSICS, PLAYER, WALL, WORLD } from '../constants.ts';
import type { Course, PadKind, Vec3 } from './course.ts';
import type { MoveInputData } from './input.ts';

/**
 * Collision groups.
 *
 * Racers pass THROUGH each other, and that has to be a property of the shared
 * step rather than a server-side nicety. The server holds every racer's capsule
 * in one world; the client holds only its own. If the server's controller let
 * one capsule block another, the client could never predict the shove -- it
 * has no capsule to collide with -- and every brush past a rival would land as
 * a correction. So a racer's controller sees course geometry and nothing else,
 * which makes a body's trajectory identical whether it is alone or in a crowd.
 *
 * Rapier packs membership into the high 16 bits and the filter mask into the
 * low 16; two colliders interact only if each one's membership is in the
 * other's mask.
 */
const GROUP_COURSE = 0x0001;
const GROUP_RACER = 0x0002;
const groups = (membership: number, filter: number): number => (membership << 16) | filter;

/** Course solids: members of COURSE, willing to touch anything. */
const COURSE_GROUPS = groups(GROUP_COURSE, 0xffff);
/** Racer capsules: members of RACER, touching only COURSE -- never each other. */
const RACER_GROUPS = groups(GROUP_RACER, GROUP_COURSE);

/**
 * Below this horizontal speed, units/s, a dash with no stick input has no
 * direction to borrow from momentum and does not fire. Small enough that any
 * deliberate drift counts; large enough that friction's last crawl to zero
 * cannot aim a 22 u/s dash at an arbitrary angle.
 */
const DASH_MIN_MOMENTUM = 0.5;

/** Object-shaped 3-vector — the shape Rapier uses. */
export interface Vec3Obj {
  x: number;
  y: number;
  z: number;
}

/**
 * One simulated character.
 *
 * Velocity lives here rather than in Rapier because a kinematic body has no
 * velocity of its own — it is driven, and the drive has to be remembered so
 * rollback can reproduce it.
 */
export interface SimBody {
  readonly body: RigidBody;
  readonly collider: Collider;
  readonly controller: KinematicCharacterController;
  /** The world this body lives in; used by the wall probe (castRayAndGetNormal). */
  readonly world: World;
  readonly velocity: Vec3Obj;
  /** True when the controller found ground under the capsule this step. */
  grounded: boolean;
  /** Magnitude of horizontal velocity, for HUD and effects. */
  horizontalSpeed: number;
  /** Feet position this body returns to when it falls out of the world. */
  readonly respawn: Vec3Obj;
  /** Body-centre Y below which the body has fallen out of the world. */
  readonly killY: number;
  /** True only on the step this body was returned to its spawn point. */
  justRespawned: boolean;
  /**
   * Fixed ticks of dash remaining; greater than zero means dashing now.
   *
   * Integer ticks, never seconds: rollback restores these from PlayerState and
   * a counter restores exactly where an accumulated float would drift. There is
   * no stored dash DIRECTION -- during a dash the horizontal velocity IS the
   * direction scaled to `DASH.speed`, and velocity is already part of truth.
   */
  dashTicks: number;
  /** Fixed ticks until the next dash may start. Counts only while not dashing. */
  dashCooldownTicks: number;
  /**
   * Holding the Core: slower, and cannot start a dash. Written from OUTSIDE --
   * the server room on a pickup or steal, `adoptTruth` on the client -- and
   * only ever read by the step.
   */
  carrying: boolean;
  /**
   * True if this body flew a dash step during the most recent `applyInput`.
   *
   * Output only -- the step never reads it, so it cannot change a trajectory.
   * It exists for the server's steal rule: `dashTicks` already reads 0 after
   * the LAST dash step, so "dashTicks > 0 after the step" would miss the final
   * tick of every dash, the one most likely to land on the carrier.
   */
  dashedThisStep: boolean;
  /**
   * Fixed ticks of boosted top speed left after touching a boost pad. Synced
   * and restored like the dash counters.
   */
  boostTicks: number;
  /**
   * Fixed ticks of wall clip remaining; greater than zero means clipped to a
   * wall face this step.
   *
   * Integer ticks, synced and restored like the dash counters: a rollback must
   * know a clip is running, and the budget is the whole point of a clip, not a
   * side effect.
   */
  wallTicks: number;
  /**
   * Fixed ticks until a new wall attach may start after a detach. Restored on
   * rollback for the same reason as the other counters: it decides whether the
   * very next step may attach.
   */
  wallCooldownTicks: number;
  /**
   * The wall face this body is clipped to: its unit outward normal, world
   * space. All-zero when not clipped.
   *
   * Refreshed from the controller's sweep every clipped step, and restored
   * from sync on rollback, because the first replayed step would otherwise
   * read the STALE sweep from the mispredicted position -- exactly the bug
   * `teleportBody`'s comment warns about for the collider itself.
   */
  wallNX: number;
  wallNY: number;
  wallNZ: number;
  /**
   * Wall lock: once a clip ends -- by budget, wall-jump, peel, dash, or a lost
   * face -- the racer cannot attach to ANY wall again until it touches the
   * ground. Touching ground clears it; every `endWall` re-arms it.
   *
   * Without this, a racer holding a face could chain clips forever (cooldown
   * only delays the next grab) and climb/hover indefinitely. Synced and
   * restored like the other counters: a rollback must replay the same gate.
   */
  wallLocked: boolean;
  /**
   * The previous step's raw `jump` input, latched at the end of every step.
   * The only way the step can tell a fresh press EDGE from the level-triggered
   * held state (`MoveInput.jump` is level-triggered -- see shared/input.ts),
   * which is what arms the springboard bounce. Synced and restored like the
   * other wall state: a rollback must replay the same gate.
   */
  prevJump: boolean;
  /**
   * The springboard bounce is armed by a jump pressed while ALREADY airborne
   * (`input.jump && !prevJump && !grounded`) and consumed when it fires or the
   * racer lands. Synced and restored for the same reason as `prevJump`.
   */
  bounceArmed: boolean;
  /** The course's pads, pre-resolved to world AABBs once at creation. */
  readonly pads: readonly SimPad[];
}

/** A pad as the step uses it: a world-space box plus its effect. */
export interface SimPad {
  readonly kind: PadKind;
  readonly min: Vec3Obj;
  readonly max: Vec3Obj;
  /** Boost direction, unit length; zero for jump pads. */
  readonly dirX: number;
  readonly dirZ: number;
}

/**
 * Create a character capsule.
 *
 * Both sides call this with the same course and `stepSeconds` so the capsule is
 * bit-identical, and so both resolve a fall to the same place.
 *
 * `stepSeconds` is the engine timestep — it MUST equal the `dt` later passed to
 * `applyInput`, because a kinematic body only lands where its next translation
 * says, and Rapier integrates internal state per step.
 */
export function createSimBody(world: World, course: Course, stepSeconds: number): SimBody {
  const spawn = course.spawn;

  // Lift the capsule clear of the surface so the first step resolves a clean
  // landing instead of starting interpenetrated.
  const feetOffset = PLAYER.halfHeight + PLAYER.radius;

  const body = world.createRigidBody(
    RigidBodyDesc.kinematicPositionBased().setTranslation(
      spawn[0],
      feetOffset + spawn[1],
      spawn[2],
    ),
  );

  // Friction 0: friction on a kinematic capsule does nothing useful against a
  // static world and only muddies the character controller's own handling.
  const collider = world.createCollider(
    ColliderDesc.capsule(PLAYER.halfHeight, PLAYER.radius)
      .setFriction(0)
      .setCollisionGroups(RACER_GROUPS),
    body,
  );

  const controller = world.createCharacterController(PHYSICS.controllerOffset);
  controller.enableAutostep(PHYSICS.maxStepHeight, PLAYER.radius * 0.9, true);
  controller.enableSnapToGround(PHYSICS.snapToGround);
  controller.setMaxSlopeClimbAngle(PHYSICS.maxSlopeClimb);
  controller.setMinSlopeSlideAngle(PHYSICS.minSlopeSlide);
  controller.setApplyImpulsesToDynamicBodies(true);
  controller.setCharacterMass(PLAYER.mass);

  // Rapier needs the timestep on the world, not the controller. Set it here so
  // a caller cannot forget it and silently desync replay.
  world.timestep = stepSeconds;

  // Resolved once, here, rather than on every fall. The query walks the whole
  // collider set, and doing it per respawn would put an O(colliders) scan in the
  // middle of the fixed step — on both sides, in lockstep.
  const feet = respawnFeet(world, course);

  return {
    body,
    collider,
    controller,
    world,
    velocity: { x: 0, y: 0, z: 0 },
    grounded: false,
    horizontalSpeed: 0,
    respawn: { x: feet.x, y: feet.y, z: feet.z },
    killY: course.killY,
    justRespawned: false,
    dashTicks: 0,
    dashCooldownTicks: 0,
    carrying: false,
    dashedThisStep: false,
    boostTicks: 0,
    wallTicks: 0,
    wallCooldownTicks: 0,
    wallNX: 0,
    wallNY: 0,
    wallNZ: 0,
    wallLocked: false,
    prevJump: false,
    bounceArmed: false,
    pads: course.pads.map((pad) => ({
      kind: pad.kind,
      min: {
        x: pad.position[0] - pad.size[0] / 2,
        y: pad.position[1] - pad.size[1] / 2,
        z: pad.position[2] - pad.size[2] / 2,
      },
      max: {
        x: pad.position[0] + pad.size[0] / 2,
        y: pad.position[1] + pad.size[1] / 2,
        z: pad.position[2] + pad.size[2] / 2,
      },
      dirX: pad.direction?.[0] ?? 0,
      dirZ: pad.direction?.[1] ?? 0,
    })),
  };
}

/**
 * Release a character's body, collider and controller.
 *
 * Removing the body takes its collider with it, but the character controller
 * is a separate WASM allocation the world tracks on its own. Without the second
 * call every join on the server leaks one.
 */
export function destroySimBody(world: World, sim: SimBody): void {
  world.removeCharacterController(sim.controller);
  world.removeRigidBody(sim.body);
}

/**
 * Integrate one fixed step of movement.
 *
 * Velocity is hand-integrated (accel, friction, gravity) while every contact is
 * delegated to Rapier's kinematic character controller. That split keeps game
 * feel tunable without reimplementing swept collision, which is where
 * hand-rolled physics goes wrong.
 *
 * Falling out of the world is resolved HERE rather than by the server, and that
 * is the whole point. A server-only teleport is a discontinuity the client
 * cannot predict: it arrives as a correction, and the reconciler smooths it, so
 * a racer who falls fifty units past the goal visibly slides back up the course.
 * Doing it in the shared step means both sides teleport on the same tick, from
 * the same state, and the respawn is part of the predicted timeline.
 *
 * Movement is judged in world vectors: the client rotates the camera-relative
 * wish by the camera's yaw before it reaches this function (main.ts stages it),
 * so the shared step only ever sees world axes and the server needs no camera.
 *
 * This does NOT advance the world. The caller does that.
 */
export function applyInput(sim: SimBody, input: MoveInputData, dt: number): void {
  const { velocity } = sim;

  // --- fall out of the world ---------------------------------------------
  // Checked at the TOP of the step, against the position left by the previous
  // step. The one-tick lag is irrelevant and, more to the point, identical on
  // both sides — which is what keeps replay reproducing the server.
  sim.justRespawned = false;
  if (sim.body.translation().y < sim.killY) {
    moveSimBody(sim, sim.respawn.x, sim.respawn.y, sim.respawn.z);
    sim.justRespawned = true;
  }

  // --- pads ----------------------------------------------------------------
  // Tested against the position left by the previous step, like the fall
  // check above, and for the same reason: both sides see the same overlap on
  // the same tick. The capsule is treated as its AABB, which is exact enough
  // for flat trigger slabs lying on a surface.
  applyPads(sim);

  // --- horizontal intent -------------------------------------------------
  // `moveZ` is already signed forward-positive-negative (W = -Z), so it maps
  // straight onto the world axis.
  let wishX = input.moveX;
  let wishZ = input.moveZ;

  // Normalise so diagonals aren't faster than cardinals.
  const wishLength = Math.hypot(wishX, wishZ);
  const hasWish = wishLength > 1e-4;
  if (hasWish) {
    wishX /= wishLength;
    wishZ /= wishLength;
  }

  // --- wall state -------------------------------------------------------
  // A wall face is found with a SHORT PROBE (see findWall) rather than the
  // controller's sweep: a clipped body rides a face without penetrating it, so
  // the sweep stops reporting the contact a step after every attach. Handled
  // before the dash so a dash can always cancel a clip (dash wins) and a clip
  // never starts mid-dash.
  //
  // Touching the ground is the ONLY way to reset the wall lock: once a clip
  // ends, it cannot be restarted mid-air, so holding a face cannot be chained
  // into an infinite climb/hover. Every `endWall` re-arms it; landing clears
  // it for the next jump -- and, at the same moment, drops any armed bounce.
  if (sim.grounded) {
    sim.wallLocked = false;
    sim.bounceArmed = false;
  }
  // Arm the springboard: a jump pressed while ALREADY airborne. The ground
  // jump's own press happens grounded, so holding Space from the floor into a
  // face NEVER arms it -- the player must press jump again in the air.
  const jumpPressed = input.jump && !sim.prevJump;
  if (jumpPressed && !sim.grounded) sim.bounceArmed = true;

  let clipped = false;
  // The CLIP feature (`WALL.enabled`) is gated here: when asleep the refresh
  // never runs and the attach gate never fires, so `clipped` stays false and
  // every downstream wall branch (dash-cancel, wall-jump, wallSteer, budget)
  // is inert -- walls are plain solid obstacles.
  if (WALL.enabled && sim.wallTicks > 0) {
    // Refresh the face (or drop it) by probing along the stored normal.
    const hit = findWall(sim, -sim.wallNX, -sim.wallNY, -sim.wallNZ);
    if (hit) {
      sim.wallNX = hit.nx;
      sim.wallNY = hit.ny;
      sim.wallNZ = hit.nz;
      clipped = true;
    } else {
      // The face is gone (climbed past its top, or around a corner). Drop
      // with NO cooldown -- the wall lock still blocks a mid-air re-grab,
      // so a racer that overshoots a face cannot catch it again in the air.
      endWall(sim, false);
    }
  } else if (
    WALL.enabled &&
    !sim.wallLocked &&
    sim.wallCooldownTicks === 0 &&
    !sim.grounded &&
    sim.dashTicks === 0 &&
    Math.hypot(sim.velocity.x, sim.velocity.z) >= WALL.minSpeedToAttach
  ) {
    // Attach: probe ahead along the horizontal heading and grab the face.
    const hs = Math.hypot(sim.velocity.x, sim.velocity.z);
    const hit = findWall(sim, sim.velocity.x / hs, 0, sim.velocity.z / hs);
    if (hit) {
      // Must be moving INTO the wall: velocity against its outward normal.
      const vn = sim.velocity.x * hit.nx + sim.velocity.y * hit.ny + sim.velocity.z * hit.nz;
      if (vn < 0) {
        sim.wallNX = hit.nx;
        sim.wallNY = hit.ny;
        sim.wallNZ = hit.nz;
        sim.wallTicks = WALL.budgetTicks;
        clipped = true;
        // Snap the body onto the face (capsule surface touching it), then kill
        // the into-wall velocity so the first clipped step slides along the
        // face instead of pushing through it all step.
        teleportBody(sim, { x: hit.px, y: hit.py, z: hit.pz });
        sim.velocity.x -= vn * hit.nx;
        sim.velocity.y -= vn * hit.ny;
        sim.velocity.z -= vn * hit.nz;
      }
    }
  } else if (
    // Springboard bounce: reachable exactly while the clip feature is asleep
    // (the attach branch above owns these same gates when it is awake).
    // Armed ONLY by a jump pressed mid-air (see above) -- holding the ground
    // jump into a face, or plain contact, does nothing.
    WALL.bounce &&
    sim.bounceArmed &&
    !sim.wallLocked &&
    sim.wallCooldownTicks === 0 &&
    !sim.grounded &&
    sim.dashTicks === 0 &&
    Math.hypot(sim.velocity.x, sim.velocity.z) >= WALL.minSpeedToAttach
  ) {
    // Probe ahead along the heading; on contact, kick the racer off the face
    // with the wall-jump vector WITHOUT entering a clip. Consumes the arm and
    // re-arms the wall lock -- like every wall exit, touching the ground is
    // the only reset: one bounce per airtime, no hover-bouncing a single face.
    //
    // The ANGLE knob is geometric: the cast originates at the body centre,
    // which can never get closer to a face than its radius, so a heading at
    // `bounceMinAngleDeg` off the surface registers only if the reach is
    // `radius / sin(angle)` -- anything shallower can never touch the face
    // deep enough to be caught, steeper approaches grab from further out.
    const minAngleDeg = Math.min(90, Math.max(5, WALL.bounceMinAngleDeg));
    const reach = (PLAYER.radius + 0.01) / Math.sin((minAngleDeg * Math.PI) / 180);
    const hs = Math.hypot(sim.velocity.x, sim.velocity.z);
    const hit = findWall(sim, sim.velocity.x / hs, 0, sim.velocity.z / hs, reach);
    if (hit) {
      // Must be moving INTO the wall: velocity against its outward normal.
      const vn = sim.velocity.x * hit.nx + sim.velocity.y * hit.ny + sim.velocity.z * hit.nz;
      if (vn < 0) {
        // The kick follows the held input: pressing INTO the wall keeps the
        // racer going forward into it (a vertical pop against the face);
        // pressing AWAY kicks off the face. Hands off the stick fall back to
        // the face's outward normal -- the plain bounce off the wall. Height
        // is the same either way; only the horizontal direction changes.
        const outX = hasWish ? wishX : hit.nx;
        const outZ = hasWish ? wishZ : hit.nz;
        sim.velocity.x = outX * WALL.jumpOut;
        sim.velocity.y = hit.ny * WALL.jumpOut + WALL.jumpUp;
        sim.velocity.z = outZ * WALL.jumpOut;
        sim.bounceArmed = false;
        sim.wallLocked = true;
      }
    }
  }

  // --- dash --------------------------------------------------------------
  // While dashing, horizontal velocity is left exactly as the dash set it:
  // steering, accel and friction are all skipped, so the dash flies straight.
  // Once it ends the ordinary accel/friction below bleed the excess off.
  const dashing = sim.dashTicks > 0 || tryStartDash(sim, input, wishX, wishZ, hasWish);
  sim.dashedThisStep = dashing;

  if (dashing && clipped) {
    endWall(sim, true);
    clipped = false;
  }

  // Peel: holding hard away from the wall ends the clip before steering.
  if (clipped && hasWish) {
    const into = wishX * sim.wallNX + wishZ * sim.wallNZ;
    if (into >= WALL.peelThreshold) {
      endWall(sim, true);
      clipped = false;
    }
  }

  if (!dashing) {
    if (clipped) {
      wallSteer(sim, wishX, wishZ, hasWish, dt);
    } else {
      // A boost raises the top speed for a moment, and while it lasts letting
      // go of the stick coasts instead of braking: a boost pad should carry you
      // even if you are not touching anything.
      const boosted = sim.boostTicks > 0;
      const topSpeed = boosted ? BOOST.speed : MOVE.runSpeed;
      const targetSpeed = sim.carrying ? topSpeed * CORE.carrierSpeedFactor : topSpeed;
      const control = sim.grounded ? 1 : MOVE.airControl;
      const accel = MOVE.accel * control;
      const decel = MOVE.friction * (sim.grounded ? 1 : MOVE.airControl);

      if (hasWish) {
        velocity.x = approach(velocity.x, wishX * targetSpeed, accel * dt);
        velocity.z = approach(velocity.z, wishZ * targetSpeed, accel * dt);
      } else if (boosted) {
        // Coast: keep the boost's velocity.
      } else {
        velocity.x = approach(velocity.x, 0, decel * dt);
        velocity.z = approach(velocity.z, 0, decel * dt);
      }
    }
  }

  // --- jump and gravity --------------------------------------------------
  // Vertical motion is deliberately untouched by the dash: gravity keeps
  // acting and a jump still works mid-dash. A flat, gravity-free air dash
  // would turn every dash into a 4-unit hover across gaps the course was laid
  // out to make you jump, and would need its own rule for what "grounded"
  // means mid-air. Leaving Y alone keeps the dash a purely horizontal burst
  // with one rule: the horizontal velocity is frozen, nothing else changes.
  //
  // A clip changes the same rule its own way: while on a wall, jump is the
  // wall-jump (kick off the face), and gravity is replaced by the wall's slide
  // or climb -- the wall holds the racer instead.
  if (clipped && input.jump) {
    // Level-triggered like every jump: holding jump into a wall kicks off the
    // instant the clip lands; tap jump into a wall to attach and run it. The
    // cooldown stops same-face jump-spam from becoming a cheap climb.
    sim.velocity.x = sim.wallNX * WALL.jumpOut;
    sim.velocity.y = sim.wallNY * WALL.jumpOut + WALL.jumpUp;
    sim.velocity.z = sim.wallNZ * WALL.jumpOut;
    endWall(sim, true);
    clipped = false;
  } else if (input.jump && sim.grounded) {
    velocity.y = MOVE.jumpSpeed;
    sim.grounded = false;
  }

  if (!clipped) {
    velocity.y += GRAVITY.y * dt;
  }

  // --- resolve against the world ----------------------------------------
  const current = sim.body.translation();
  const desired: Vec3Obj = {
    x: velocity.x * dt,
    y: velocity.y * dt,
    z: velocity.z * dt,
  };

  // Filtered by the racer's own groups, so the sweep -- including autostep and
  // snap-to-ground -- sees course geometry only. See GROUP_RACER.
  sim.controller.computeColliderMovement(sim.collider, desired, undefined, RACER_GROUPS);
  const movement = sim.controller.computedMovement();
  sim.grounded = sim.controller.computedGrounded();

  // Landing cancels downward velocity; otherwise gravity accumulates and the
  // capsule sticks to the floor with a force it can never escape. A clipped
  // racer is not "landing" -- the controller can report ground when the face
  // meets the floor, and zeroing a climb or a wall-slide there would yank it.
  if (sim.grounded && velocity.y < 0 && !clipped) {
    velocity.y = 0;
  }

  sim.body.setNextKinematicTranslation({
    x: current.x + movement.x,
    y: current.y + movement.y,
    z: current.z + movement.z,
  });

  sim.horizontalSpeed = Math.hypot(velocity.x, velocity.z);

  // --- dash bookkeeping ---------------------------------------------------
  // At the END of the step, so a dash lasts exactly `DASH.durationTicks`
  // moving steps, the published `dashTicks` is "steps still to fly", and the
  // tick a dash ends does not also burn a cooldown tick: the next dash can
  // start no sooner than `DASH.cooldownTicks` whole non-dashing steps later.
  if (dashing) {
    sim.dashTicks -= 1;
    if (sim.dashTicks === 0) sim.dashCooldownTicks = DASH.cooldownTicks;
  } else if (sim.dashCooldownTicks > 0) {
    sim.dashCooldownTicks -= 1;
  }
  if (sim.boostTicks > 0) sim.boostTicks -= 1;

  // --- wall bookkeeping ---------------------------------------------------
  // The budget counts clipping STEPS: attach sets `budgetTicks`, every clipped
  // step decrements at the end, and the step that reaches 0 costs the
  // cooldown. Deliberate exits (wall-jump, peel, dash, budget out) all pay it,
  // so a corner cannot be hover-climbed forever; a LOST face stays free of the
  // cooldown but -- like every exit -- re-arms the wall lock, so nothing
  // re-attaches until the racer lands.
  if (clipped) {
    sim.wallTicks -= 1;
    if (sim.wallTicks === 0) endWall(sim, true);
  } else if (sim.wallCooldownTicks > 0) {
    sim.wallCooldownTicks -= 1;
  }

  // Latch the raw jump input for the NEXT step's edge detection.
  sim.prevJump = input.jump;
}

/**
 * Start a dash if the rules allow one this step. Returns whether it started.
 *
 * Direction is the stick if there is one, else wherever momentum is already
 * carrying the body. With neither there is nothing to aim at, so nothing fires
 * and -- because no dash happened -- no cooldown is spent either; holding dash
 * while standing still must not quietly eat the next one.
 *
 * Air dashes are allowed. A carrier can never start one: that is the whole
 * cost of holding the Core. A dash already under way when the Core arrives
 * (the steal itself happens mid-dash) is left to finish; only the START is
 * gated, which keeps the rule a single check rather than a cancel path the
 * client would have to predict on the exact tick the server hands it the Core.
 */
function tryStartDash(
  sim: SimBody,
  input: MoveInputData,
  wishX: number,
  wishZ: number,
  hasWish: boolean,
): boolean {
  if (!input.dash || sim.carrying || sim.dashCooldownTicks !== 0) return false;

  let dirX = wishX;
  let dirZ = wishZ;
  if (!hasWish) {
    const speed = Math.hypot(sim.velocity.x, sim.velocity.z);
    if (speed < DASH_MIN_MOMENTUM) return false;
    dirX = sim.velocity.x / speed;
    dirZ = sim.velocity.z / speed;
  }

  sim.velocity.x = dirX * DASH.speed;
  sim.velocity.z = dirZ * DASH.speed;
  sim.dashTicks = DASH.durationTicks;
  return true;
}

// ------------------------------------------------------------------ walls

/** A wall face the controller's last sweep touched, as unit outward normal. */
/**
 * A wall face this body is against (or within a hair of): its unit outward
 * normal in world space, plus where the capsule centre must sit to ride it.
 */
interface WallContact {
  nx: number;
  ny: number;
  nz: number;
  /** Pin target: body-centre position with the capsule surface on the face. */
  px: number;
  py: number;
  pz: number;
}

/**
 * Probe for the wall face ahead of the body, or null.
 *
 * The body never penetrates a face while clipped -- the into-wall velocity is
 * removed every step -- so the controller's sweep goes quiet a step after
 * every attach: it only reports contacts for actual penetration, and a body
 * riding a face barely touches it. A SHORT SOLID RAY is the honest check: the
 * same course-only filter as the sweep, deterministic by construction (both
 * sides query the same static geometry and get the same answer, exactly like
 * `grounded`), and it doubles as a forgiving grab for the attach.
 *
 * `dirX/Y/Z` is the probe direction: the horizontal heading for an attach,
 * the stored back-normal for a clipped refresh. `reach` overrides the cast
 * length -- the bounce extends it to `radius / sin(angle)` so its minimum
 * approach angle is encoded geometrically (see the bounce branch); the
 * attach/refresh use the default `WALL.probeDist`.
 */
function findWall(
  sim: SimBody,
  dirX: number,
  dirY: number,
  dirZ: number,
  reach: number = WALL.probeDist,
): WallContact | null {
  const len = Math.hypot(dirX, dirY, dirZ);
  if (len < 1e-4) return null;

  const t = sim.body.translation();
  const dx = dirX / len;
  const dy = dirY / len;
  const dz = dirZ / len;
  const hit = sim.world.castRayAndGetNormal(
    new Ray({ x: t.x, y: t.y, z: t.z }, { x: dx, y: dy, z: dz }),
    reach,
    true,
    undefined,
    RACER_GROUPS,
  );
  if (!hit) return null;

  const n = hit.normal;
  // A wall is vertical: the floor, a slope, or a ceiling is not. (A ceiling is
  // also physically unreachable while riding a face -- the face plane itself
  // stands between the capsule and any wall-top above it -- but a low lip you
  // clip past must not read as a wall either.)
  if (Math.abs(n.y) > WALL.maxWallSlope) return null;
  const nlen = Math.hypot(n.x, n.y, n.z);
  if (nlen < 1e-4) return null;
  const nx = n.x / nlen;
  const ny = n.y / nlen;
  const nz = n.z / nlen;

  // Pin the capsule surface to the face: the hit point (on the face plane)
  // pushed out along the normal by the capsule radius.
  return {
    nx,
    ny,
    nz,
    px: t.x + dx * hit.timeOfImpact + nx * PLAYER.radius,
    py: t.y + dy * hit.timeOfImpact + ny * PLAYER.radius,
    pz: t.z + dz * hit.timeOfImpact + nz * PLAYER.radius,
  };
}

/**
 * Steering while clipped to a wall: run along the face, climb it, or slide it.
 *
 * The wish is projected onto the wall plane for the horizontal run; holding
 * the stick TOWARD the wall (wish dot normal <= -threshold) instead runs the
 * racer UP the face, still steerable along it (diagonal face-runs). Either
 * way the into-wall velocity is removed every step, so the body rides the
 * plane the controller resolves instead of pushing through it.
 *
 * Speeds carry the carrier factor, so holding the Core clips at 0.9x.
 */
function wallSteer(sim: SimBody, wishX: number, wishZ: number, hasWish: boolean, dt: number): void {
  const { velocity } = sim;
  const f = sim.carrying ? CORE.carrierSpeedFactor : 1;
  const run = WALL.runSpeed * f;
  const climb = WALL.climbSpeed * f;
  const into = hasWish ? wishX * sim.wallNX + wishZ * sim.wallNZ : 0;

  if (into <= -WALL.climbThreshold) {
    velocity.y = approach(velocity.y, climb, WALL.climbAccel * dt);
  } else {
    velocity.y = approach(velocity.y, -WALL.slideSpeed, WALL.slideAccel * dt);
  }

  if (hasWish) {
    const alongX = wishX - sim.wallNX * into;
    const alongZ = wishZ - sim.wallNZ * into;
    const along = Math.hypot(alongX, alongZ);
    if (along > 1e-4) {
      velocity.x = approach(velocity.x, (alongX / along) * run, MOVE.accel * dt);
      velocity.z = approach(velocity.z, (alongZ / along) * run, MOVE.accel * dt);
    }
  } else {
    velocity.x = approach(velocity.x, 0, MOVE.friction * 0.5 * dt);
    velocity.z = approach(velocity.z, 0, MOVE.friction * 0.5 * dt);
  }

  const vn = velocity.x * sim.wallNX + velocity.y * sim.wallNY + velocity.z * sim.wallNZ;
  velocity.x -= vn * sim.wallNX;
  velocity.y -= vn * sim.wallNY;
  velocity.z -= vn * sim.wallNZ;
}

/**
 * End a wall clip. `cooldown: true` for every exit that could be abused as a
 * free reset (wall-jump, peel, dash, budget out); false for a lost face.
 *
 * Every exit re-arms the wall lock: the racer cannot attach to any wall again
 * until it touches the ground (see `wallLocked` in the step).
 */
function endWall(sim: SimBody, cooldown: boolean): void {
  sim.wallTicks = 0;
  sim.wallNX = 0;
  sim.wallNY = 0;
  sim.wallNZ = 0;
  if (cooldown) sim.wallCooldownTicks = WALL.cooldownTicks;
  sim.wallLocked = true;
}

/**
 * Teleport to an arbitrary feet position, zero all velocity and clear any dash.
 *
 * The dash counters reset with the velocity: a dash that survived a teleport
 * would fling the body out of its spawn at dash speed, and a leftover cooldown
 * would make a fresh start feel broken. `carrying` is NOT touched -- whether a
 * respawn costs the Core is a game rule the room owns.
 */
export function moveSimBody(sim: SimBody, feetX: number, feetY: number, feetZ: number): void {
  sim.dashTicks = 0;
  sim.dashCooldownTicks = 0;
  sim.boostTicks = 0;
  sim.wallTicks = 0;
  sim.wallCooldownTicks = 0;
  sim.wallNX = 0;
  sim.wallNY = 0;
  sim.wallNZ = 0;
  sim.wallLocked = false;
  sim.velocity.x = 0;
  sim.velocity.y = 0;
  sim.velocity.z = 0;
  sim.grounded = false;
  sim.horizontalSpeed = 0;

  teleportBody(sim, { x: feetX, y: feetY + PLAYER.halfHeight + PLAYER.radius, z: feetZ });
}

/**
 * Cut the capsule to a body-centre position, instantly, body AND collider.
 *
 * setTranslation, not setNextKinematicTranslation: an instantaneous cut is not
 * a step the simulation should interpolate toward.
 *
 * The collider is moved explicitly because Rapier only re-derives a collider's
 * pose from its body inside `world.step()`. Moving the body alone leaves the
 * collider where it was, and the very next `computeColliderMovement` sweeps
 * from that stale pose. On the client that is a rollback bug: after adopting
 * truth the first replayed step tests walls from the MISPREDICTED position,
 * misses a rail the server hit, and the body ends up inside it. The harness
 * caught exactly that on a mid-dash rollback beside the start rail. The
 * capsule sits at the body origin, so the two translations are the same.
 */
export function teleportBody(sim: SimBody, centre: Vec3Obj): void {
  sim.body.setTranslation(centre, true);
  sim.collider.setTranslation(centre);
}

/**
 * Apply every pad the body overlaps this step.
 *
 * Boost: if the racer is already moving the pad's way (any positive component
 * along it), horizontal velocity snaps to the pad's direction at boost speed
 * and the boost timer refills, every tick the racer is on it -- so a strip of
 * boost pads is a conveyor that also straightens you out. Jump: a grounded racer is
 * launched up; the next tick it is airborne, so it cannot re-trigger mid-climb.
 */
function applyPads(sim: SimBody): void {
  if (sim.pads.length === 0) return;
  const p = sim.body.translation();
  const r = PLAYER.radius;
  const h = PLAYER.halfHeight + PLAYER.radius;

  for (const pad of sim.pads) {
    if (
      p.x + r <= pad.min.x || p.x - r >= pad.max.x ||
      p.y + h <= pad.min.y || p.y - h >= pad.max.y ||
      p.z + r <= pad.min.z || p.z - r >= pad.max.z
    ) {
      continue;
    }
    if (pad.kind === 'boost') {
      // Directional: a boost only grabs a racer already moving its way. Run
      // across it or against it and nothing happens. Without this, an outward
      // boost on a lane you must run IN along was a trap: it threw you back,
      // you ran at it again, it threw you back again.
      if (sim.velocity.x * pad.dirX + sim.velocity.z * pad.dirZ <= 0) continue;
      sim.velocity.x = pad.dirX * BOOST.speed;
      sim.velocity.z = pad.dirZ * BOOST.speed;
      sim.boostTicks = BOOST.ticks;
    } else if (sim.grounded) {
      sim.velocity.y = JUMP_PAD.speed;
      sim.grounded = false;
    }
  }
}

/**
 * Euler degrees (X, then Y, then Z) to a quaternion -- the same convention as
 * Three's default Euler order, so the collider and the mesh agree. Written out
 * here because this module may not import Three.
 */
export function eulerDegreesToQuat(rotation: Vec3): { x: number; y: number; z: number; w: number } {
  const half = Math.PI / 360;
  const c1 = Math.cos(rotation[0] * half);
  const c2 = Math.cos(rotation[1] * half);
  const c3 = Math.cos(rotation[2] * half);
  const s1 = Math.sin(rotation[0] * half);
  const s2 = Math.sin(rotation[1] * half);
  const s3 = Math.sin(rotation[2] * half);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  };
}

/** Move `current` toward `target` by at most `maxDelta`. */
function approach(current: number, target: number, maxDelta: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

// ---------------------------------------------------------------- course

/**
 * Build the course's colliders.
 *
 * Shared deliberately: if the client and server built these from separate code
 * they could disagree by a fraction of a unit, and the character controller
 * would resolve that disagreement as a phantom wall the client cannot see. One
 * function, one course, two identical worlds.
 *
 * All colliders live on a single fixed body at the origin, each offset by its
 * own translation. Rapier treats that as one compound static object, which is
 * cheaper than a body per solid.
 */
export function buildCourseColliders(world: World, course: Course): RigidBody {
  const staticBody = world.createRigidBody(RigidBodyDesc.fixed());

  for (const solid of course.solids) {
    const [sx, sy, sz] = solid.size;
    const [px, py, pz] = solid.position;

    world.createCollider(
      ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2)
        .setTranslation(px, py, pz)
        .setFriction(WORLD.friction)
        .setRestitution(WORLD.restitution)
        .setCollisionGroups(COURSE_GROUPS)
        .setRotation(eulerDegreesToQuat(solid.rotation ?? [0, 0, 0])),
      staticBody,
    );
  }

  return staticBody;
}

export interface GroundProbe {
  /** Topmost solid surface at or below `fromY`, or null if nothing is below. */
  topY: number | null;
}

/**
 * Find the highest solid surface beneath a point.
 *
 * Used to drop a respawning player onto whichever pad they fell from, so a
 * respawn never leaves them embedded inside geometry. Queries the collider set
 * directly rather than casting a ray — cheaper and needs no collision pipeline
 * state.
 */
export function probeGround(world: World, x: number, z: number, fromY: number): GroundProbe {
  let best = -Infinity;

  world.forEachCollider((collider) => {
    // Only boxes exist in the course format today. If a second primitive is
    // added this must grow a branch rather than silently ignoring it.
    if (!(collider.shape instanceof Cuboid)) return;
    // Ramps are rotated, and the containment test below is axis-aligned. A
    // respawn point is never on a ramp, so they are simply not candidates.
    if (Math.abs(collider.rotation().w) < 0.999999) return;
    const half = collider.shape.halfExtents;

    const t = collider.translation();
    // Horizontal containment test against the box.
    if (x < t.x - half.x || x > t.x + half.x) return;
    if (z < t.z - half.z || z > t.z + half.z) return;

    const top = t.y + half.y;
    if (top <= fromY && top > best) best = top;
  });

  return { topY: best === -Infinity ? null : best };
}

/**
 * The feet position a player respawns at: the real surface under the spawn
 * point, lifted by a hair so the capsule resolves a landing instead of
 * starting interpenetrated.
 *
 * The `spawn` Y in a course file is nominal. Only the colliders know where the
 * floor actually is, so the colliders get the final say.
 */
export function respawnFeet(
  world: World,
  course: Course,
  clearance = 0.05,
): { x: number; y: number; z: number } {
  const [sx, sy, sz] = course.spawn;
  const probe = probeGround(world, sx, sz, sy + 4);
  return {
    x: sx,
    y: probe.topY !== null ? probe.topY + clearance : sy,
    z: sz,
  };
}