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
import { CAMERA, FIXED_TIMESTEP, PLAYER } from '../constants.ts';
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
  /** Copy the predicted state into meshes. Call once per rendered frame. */
  sync(pose: LocalPose): void;
  dispose(): void;
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

  const cameraTarget = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();
  const tint = new THREE.Color();
  const baseColor = new THREE.Color(0xff6b3d);
  const airborneColor = new THREE.Color(0x8fd4ff);

  return {
    sync(pose) {
      playerMesh.position.set(pose.x, pose.y, pose.z);

      // The ring stays at ground level rather than following the capsule, so it
      // doubles as a height cue while airborne.
      marker.position.set(pose.x, 0.02, pose.z);

      // Tint by grounded state so air control is visually readable.
      tint.copy(pose.grounded ? baseColor : airborneColor);
      (playerMesh.material as THREE.MeshStandardMaterial).color.lerp(tint, 0.25);

      // Smooth follow camera, locked to the world Z axis for now.
      cameraTarget.set(pose.x, pose.y + CAMERA.height, pose.z + CAMERA.distance);
      stage.camera.position.lerp(
        cameraTarget,
        1 - Math.exp(-CAMERA.smoothing * FIXED_TIMESTEP),
      );

      lookTarget.set(pose.x, pose.y + CAMERA.lookAtHeight, pose.z);
      stage.camera.lookAt(lookTarget);
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