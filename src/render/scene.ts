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
import { CAMERA, PLAYER } from '../constants.ts';
import type { Pose } from '../physics/player.ts';

/**
 * Where the local racer is and what it is doing.
 *
 * Passed in rather than read from a body, because the position comes from the
 * *predicted* simulation and can differ from anything the server has
 * confirmed. The render layer has no business knowing where that came from.
 */
export interface LocalPose extends Pose {
  grounded: boolean;
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

  dispose(): void;
}

const clamp = (value: number, lo: number, hi: number): number =>
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

  // --- lighting ----------------------------------------------------------
  const hemi = new THREE.HemisphereLight(0xffffff, 0x50603a, 2.2);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
  sun.position.set(40, 60, 25);
  scene.add(sun);

  // --- local racer -------------------------------------------------------
  const playerMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(PLAYER.radius, PLAYER.halfHeight * 2, 8, 16),
    new THREE.MeshStandardMaterial({ color: 0xff6b3d, roughness: 0.5 }),
  );
  scene.add(playerMesh);

  // A flat ring under the capsule reads as a contact cue, which makes grounded
  // vs airborne obvious without a shadow map.
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.45, 0.6, 24),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }),
  );
  marker.rotation.x = -Math.PI / 2;
  scene.add(marker);

  const tint = new THREE.Color();
  const baseColor = new THREE.Color(0xff6b3d);
  const airborneColor = new THREE.Color(0x8fd4ff);

  const followTarget = new THREE.Vector3();
  const followPoint = new THREE.Vector3();
  const cameraOffset = new THREE.Vector3();

  let yaw = 0;
  // Annotated because CAMERA is `as const`; without it this narrows to the
  // literal 0.5 and `orbit()` cannot assign to it.
  let pitch: number = CAMERA.pitch;
  let snapping = true;

  return {
    sync(pose, dt) {
      playerMesh.position.set(pose.x, pose.y, pose.z);

      // The ring stays at ground level rather than following the capsule, so it
      // doubles as a height cue while airborne.
      marker.position.set(pose.x, 0.02, pose.z);

      // Tint by grounded state so air control is visually readable.
      tint.copy(pose.grounded ? baseColor : airborneColor);
      (playerMesh.material as THREE.MeshStandardMaterial).color.lerp(tint, 0.25);

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
    },

    orbit(y, p) {
      yaw = y;
      pitch = clamp(p, CAMERA.minPitch, CAMERA.maxPitch);
    },

    dispose() {
      scene.remove(playerMesh, marker, hemi, sun);
      playerMesh.geometry.dispose();
      (playerMesh.material as THREE.Material).dispose();
      marker.geometry.dispose();
      (marker.material as THREE.Material).dispose();
    },
  };
}