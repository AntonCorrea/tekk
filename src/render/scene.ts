/**
 * Scene visuals
 *
 * Meshes are followers, never authorities. Every frame they copy whatever the
 * simulation reports — nothing here writes back into the sim.
 *
 * Lighting and the local racer only. Course geometry comes from
 * course/build.ts and other racers from net/remotes.ts, so this file does not
 * change when either of those does.
 */

import * as THREE from 'three/webgpu';

import type { Stage } from '../core/stage.ts';
import { CAMERA, MOVE } from '../constants.ts';
import { fxSpeed, reducedMotion } from './fx.ts';
import { NEON, PALETTE, RACER_IDENTITY, RAMP } from './palette.ts';
import { createCharacter } from './character.ts';
import type { Pose } from '../physics/player.ts';

/**
 * Where the local racer is and what it is doing.
 *
 * Passed in rather than read from a body, because the position comes from the
 * *predicted* simulation and can differ from anything the server has
 * confirmed. The render layer has no business knowing where that came from.
 */
export interface LocalPose extends Pose {
  /** Predicted horizontal velocity and speed: facing and the run cycle. */
  vx: number;
  vz: number;
  speed: number;
  grounded: boolean;
  /** You hold the Core: the capsule burns white, like a remote carrier. */
  carrying: boolean;
  /** Predicted dash in progress (`sim.dashTicks > 0`). */
  dashing: boolean;
}

export interface SceneVisuals {
  /**
   * Copy the predicted state into meshes. Call once per rendered frame.
   *
   * `dt` is the real frame delta in seconds. It is required, not optional:
   * cosmetic smoothing that takes a frame delta must be told what it was, or it
   * falls back to assuming a fixed refresh rate.
   */
  sync(pose: LocalPose, dt: number): void;

  /**
   * Point the camera at a yaw/pitch, in radians.
   *
   * Yaw 0 looks down -Z, which is the course's start direction, so the default
   * frame matches the world-Z-locked view this replaced. Purely client-side:
   * nothing here is sent to the server.
   */
  orbit(yaw: number, pitch: number): void;

  /**
   * Add screen-shake trauma, 0..1. Trauma decays on its own and shake grows
   * with its square, so small kicks stay subtle and big ones land hard.
   */
  kick(trauma: number): void;

  dispose(): void;
}

const clampNumber = (value: number, lo: number, hi: number): number =>
  value < lo ? lo : value > hi ? hi : value;

/**
 * Camera offset from the focus point for a given yaw and pitch.
 *
 * Yaw 0 places the camera on +Z, looking toward -Z. Pitch rotates the offset up
 * from there. Out-parameter rather than a returned Vector3 to keep this free of
 * per-frame allocation.
 */
function orbitOffset(out: THREE.Vector3, yaw: number, pitch: number): THREE.Vector3 {
  const horizontal = Math.cos(pitch) * CAMERA.distance;
  return out.set(
    Math.sin(yaw) * horizontal,
    Math.sin(pitch) * CAMERA.distance,
    Math.cos(yaw) * horizontal,
  );
}

export function buildScene(stage: Stage): SceneVisuals {
  const { scene } = stage;

  // --- lighting ------------------------------------------------------------
  // Built for a near-black scene. There is no sun and no sky, so every light
  // here is a shaping tool rather than an illumination source: one dim key so
  // the top faces of the architecture read as form, and two coloured rims from
  // behind to separate silhouettes from the fog.
  //
  // The previous build had a 2.4-intensity warm sun and a 2.2 hemisphere,
  // because it was rendering under a blue sky. Those numbers would blow out
  // completely here — hence the large drop.
  //
  // The hemisphere's ground colour is `PALETTE.base` rather than a dark grey on
  // purpose. Against a background of `#020202` a hemisphere that lights the
  // undersides with anything lighter reads as a grey fog sitting on the ground
  // plane, and the pads stop looking like they are above anything.
  const hemi = new THREE.HemisphereLight(NEON.violet, PALETTE.base, 0.5);
  scene.add(hemi);

  // Palette white rather than the previous hand-picked lavender `0xd8d4ff`. The
  // ramp's white is a cool `#F4FAFC`, which is close enough that the look is
  // unchanged, and it means the key light is a palette entry rather than a magic
  // number that nothing else can see.
  const key = new THREE.DirectionalLight(RAMP.white, 1.6);
  key.position.set(30, 50, 20);
  scene.add(key);

  const rimCyan = new THREE.DirectionalLight(NEON.cyan, 1.1);
  rimCyan.position.set(-40, 18, -35);
  scene.add(rimCyan);

  const rimMagenta = new THREE.DirectionalLight(NEON.magenta, 0.8);
  rimMagenta.position.set(38, 14, -40);
  scene.add(rimMagenta);

  // --- local racer ---------------------------------------------------------
  // The blocky mannequin from render/character.ts, the same one remote racers
  // use. The physics capsule is invisible now; this only follows it.
  const character = createCharacter(scene, RACER_IDENTITY[0]!);

  // A flat ring under the capsule reads as a contact cue, which makes grounded
  // vs airborne obvious without a shadow map. Neon rather than a dark shadow:
  // there is no lit ground here for a shadow to darken.
  const markerMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(NEON.cyan),
    transparent: true,
    opacity: 0.7,
    toneMapped: false,
  });
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.45, 0.62, 32),
    markerMaterial,
  );
  marker.rotation.x = -Math.PI / 2;
  scene.add(marker);

  const tint = new THREE.Color();
  // Your identity colour. The body no longer shifts to amber in the air: with
  // saturated racer hues that would strip your identity on every jump. The
  // ground ring below still carries the airborne cue.
  const identityTint = new THREE.Color(RACER_IDENTITY[0]!);
  const groundedMarker = new THREE.Color(NEON.cyan);
  const airborneMarker = new THREE.Color(NEON.amber);
  // Same white as remote carriers (net/remotes.ts), so the cue reads identically
  // whether it is you or someone else holding the Core.
  const carrierTint = new THREE.Color(NEON.white);

  const followTarget = new THREE.Vector3();
  const followPoint = new THREE.Vector3();
  const cameraOffset = new THREE.Vector3();

  let yaw = 0;
  // Annotated because CAMERA is `as const`; without it this narrows to the
  // literal 0.5 and `orbit()` cannot assign to it.
  let pitch: number = CAMERA.pitch;
  let snapping = true;

  // --- feel ------------------------------------------------------------------
  // Field of view opens with speed and punches wide on a dash: the cheapest,
  // strongest "this is fast" cue there is. Shake is trauma-based -- kicks add
  // trauma, it decays, and the offset is trauma squared -- so overlapping kicks
  // compound instead of fighting. Both respect reduced motion.
  let fov: number = CAMERA.fov;
  let trauma = 0;
  let shakeClock = 0;
  let wasDashing = false;
  let airTime = 0;
  let speedFx = 0;

  const kick = (amount: number): void => {
    if (reducedMotion) return;
    trauma = Math.min(1, trauma + amount);
  };

  return {
    sync(pose, dt) {
      character.update(pose, dt);

      // The ring stays at ground level rather than following the capsule, so it
      // doubles as a height cue while airborne.
      // Just above the deck surface. Hardcoded rather than derived from
      // `ATMOS.gridY`: the pads' top faces are at y=0 and the grid sits below
      // them, so tracking the grid would bury this ring inside the geometry.
      marker.position.set(pose.x, 0.02, pose.z);

      // The airborne tint moved from the mesh's base colour to the emissive
      // tint, because the base colour is now almost black and tinting it does
      // nothing visible. The hue is the same amber it always was, so the cue
      // keeps meaning the same thing.
      tint.copy(pose.carrying ? carrierTint : identityTint);
      character.tint.lerp(tint, 0.25);
      markerMaterial.color.lerp(
        pose.carrying ? carrierTint : pose.grounded ? groundedMarker : airborneMarker,
        0.25,
      );

      // Carrier burns hardest, a dash is a brief flare. Same multipliers as
      // remote racers. Eased rather than switched so a 9-tick dash reads as a
      // pulse instead of a flicker.
      const gainTarget = pose.carrying ? 2.4 : pose.dashing ? 1.9 : 1;
      character.glow += (gainTarget - character.glow) * 0.3;

      // --- follow camera ---------------------------------------------------
      // Position is offset from the racer by a fixed spherical rig (see
      // `orbitOffset`), so it only ever has to chase the racer's motion.
      //
      // The smoothing factor is built from the REAL frame delta. The previous
      // version passed FIXED_TIMESTEP here, which silently assumed 60fps: at
      // 144Hz it applied 2.5x the intended stiffness, pinning the camera to the
      // raw predicted pose and exposing every reconciliation rollback as a
      // visible twitch. The racer's predicted position is corrected ~20x/sec,
      // so an under-filtered camera reads as jitter rather than lag.
      const k = 1 - Math.exp(-CAMERA.smoothing * dt);

      followTarget.set(pose.x, pose.y + CAMERA.lookAtHeight, pose.z);
      // Snap on the first frame, otherwise the camera flies in from wherever
      // core/stage.ts seeded it.
      if (snapping) {
        followPoint.copy(followTarget);
        snapping = false;
      } else {
        followPoint.lerp(followTarget, k);
      }

      orbitOffset(cameraOffset, yaw, pitch);
      stage.camera.position.copy(followPoint).add(cameraOffset);
      stage.camera.lookAt(followPoint);

      // --- feel: kicks from your own movement -------------------------------
      if (pose.dashing && !wasDashing) kick(0.22);
      wasDashing = pose.dashing;
      // A landing only shakes after a real fall, not after stepping off a kerb.
      if (!pose.grounded) airTime += dt;
      else {
        if (airTime > 0.35) kick(Math.min(0.35, airTime * 0.4));
        airTime = 0;
      }

      // --- feel: FOV ---------------------------------------------------------
      const run = Math.min(1, pose.speed / MOVE.runSpeed);
      const fovTarget = reducedMotion
        ? CAMERA.fov
        : CAMERA.fov + 9 * run + (pose.dashing ? 16 : 0);
      // Opens fast, closes slower: the punch is the point, the recovery is not.
      const fovRate = fovTarget > fov ? 18 : 5;
      fov += (fovTarget - fov) * (1 - Math.exp(-fovRate * dt));
      if (Math.abs(stage.camera.fov - fov) > 0.01) {
        stage.camera.fov = fov;
        stage.camera.updateProjectionMatrix();
      }

      // --- feel: shake -------------------------------------------------------
      // Smooth pseudo-noise from incommensurate sines rather than random(): a
      // random offset per frame is framerate-dependent jitter, this is motion.
      trauma = Math.max(0, trauma - dt * 1.8);
      shakeClock += dt;
      if (trauma > 0) {
        const amp = trauma * trauma;
        const t = shakeClock * 38;
        stage.camera.position.x += amp * 0.45 * Math.sin(t * 1.0 + 0.3);
        stage.camera.position.y += amp * 0.35 * Math.sin(t * 1.37 + 1.1);
        stage.camera.position.z += amp * 0.45 * Math.sin(t * 0.83 + 2.4);
        stage.camera.rotateZ(amp * 0.05 * Math.sin(t * 1.21));
      }

      // --- feel: speed lines ---------------------------------------------------
      // Mostly a dash effect; flat-out running only hints at it.
      const speedTarget = reducedMotion ? 0 : pose.dashing ? 1 : Math.max(0, run - 0.85) * 0.8;
      speedFx += (speedTarget - speedFx) * (1 - Math.exp(-(speedTarget > speedFx ? 20 : 6) * dt));
      fxSpeed.value = speedFx;
    },

    kick,

    orbit(y, p) {
      yaw = y;
      pitch = clampNumber(p, CAMERA.minPitch, CAMERA.maxPitch);
    },

    dispose() {
      scene.remove(marker, hemi, key, rimCyan, rimMagenta);
      character.dispose();
      marker.geometry.dispose();
      markerMaterial.dispose();
    },
  };
}