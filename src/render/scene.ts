/**
 * Scene visuals
 *
 * Meshes are followers, never authorities. Every frame they copy whatever
 * the physics bodies report — nothing here writes back into the sim.
 *
 * Lighting only. Course geometry is built in course/build.ts from the
 * course definition, so swapping courses needs no changes in this file.
 */

import * as THREE from 'three/webgpu';
import type { Stage } from '../core/stage.ts';
import { CAMERA, FIXED_TIMESTEP, GOAL, PLAYER } from '../constants.ts';
import type { Player } from '../physics/player.ts';

export interface SceneVisuals {
  /** Copy physics state into meshes. Call once per rendered frame. */
  sync(player: Player): void;
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

  // --- player ------------------------------------------------------------
  const playerMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(PLAYER.radius, PLAYER.halfHeight * 2, 8, 16),
    new THREE.MeshStandardMaterial({ color: 0xff6b3d, roughness: 0.5 }),
  );
  scene.add(playerMesh);

  // A flat ring under the capsule reads as a contact cue, which makes
  // grounded vs airborne obvious without a shadow map.
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.45, 0.6, 24),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }),
  );
  marker.rotation.x = -Math.PI / 2;
  scene.add(marker);

  const cameraTarget = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();
  const playerColor = new THREE.Color();
  const baseColor = new THREE.Color(0xff6b3d);
  const airborneColor = new THREE.Color(0x8fd4ff);

  return {
    sync(player) {
      const t = player.body.translation();
      playerMesh.position.set(t.x, t.y, t.z);
      marker.position.set(t.x, 0.02, t.z);

      // Tint by grounded state so air control is visually readable.
      playerColor.copy(player.grounded ? baseColor : airborneColor);
      (playerMesh.material as THREE.MeshStandardMaterial).color.lerp(
        playerColor,
        0.25,
      );

      // Smooth follow camera, locked to the world Z axis for now.
      cameraTarget.set(t.x, t.y + CAMERA.height, t.z + CAMERA.distance);
      stage.camera.position.lerp(cameraTarget, 1 - Math.exp(-CAMERA.smoothing * FIXED_TIMESTEP));

      lookTarget.set(t.x, t.y + CAMERA.lookAtHeight, t.z);
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

/** Applied by the caller to the goal gate; kept here next to the other materials. */
export function pulseGoal(mesh: THREE.Mesh, elapsedSeconds: number): void {
  const material = mesh.material as THREE.MeshStandardMaterial;
  material.emissiveIntensity = 0.6 + Math.sin(elapsedSeconds * GOAL.pulseHz * Math.PI * 2) * 0.4;
}