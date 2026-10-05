/**
 * Course visuals
 *
 * Turns a validated Course definition into Three.js meshes. Client-only —
 * the colliders are built by the shared `buildCourseColliders` in
 * shared/sim.ts, because the server needs the same geometry and a server that
 * cannot import Three.js is the whole reason that split exists.
 *
 * Meshes are followers. They never feed anything back into the simulation.
 */

import * as THREE from 'three/webgpu';
import type { Course } from '../shared/course.ts';
import { GOAL } from '../constants.ts';

export interface CourseHandle {
  readonly goalMesh: THREE.Mesh;
  /** Remove every mesh from the scene. Colliders are disposed separately. */
  dispose(): void;
}

const DEFAULT_SOLID_COLOR = '#4f7f4a';

export function buildCourse(scene: THREE.Scene, course: Course): CourseHandle {
  // One unit cube shared by every solid; each mesh scales to its own size.
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const meshes: THREE.Mesh[] = [];

  for (const solid of course.solids) {
    const [sx, sy, sz] = solid.size;
    const [px, py, pz] = solid.position;

    const color = solid.color ?? DEFAULT_SOLID_COLOR;
    let material = materials.get(color);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        roughness: 0.95,
      });
      materials.set(color, material);
    }

    const mesh = new THREE.Mesh(cube, material);
    mesh.position.set(px, py, pz);
    mesh.scale.set(sx, sy, sz);
    scene.add(mesh);
    meshes.push(mesh);
  }

  // --- goal gate ---------------------------------------------------------
  const [gx, gy, gz] = course.goal.position;
  const [gw, gh, gd] = course.goal.size;

  const goalMaterial = new THREE.MeshStandardMaterial({
    color: GOAL.color,
    emissive: new THREE.Color(GOAL.emissive),
    transparent: true,
    opacity: GOAL.opacity,
    roughness: 0.3,
  });

  const goalMesh = new THREE.Mesh(new THREE.BoxGeometry(gw, gh, gd), goalMaterial);
  goalMesh.position.set(gx, gy, gz);
  scene.add(goalMesh);

  // A frame around the gate reads as a finish line rather than a floating box.
  const frameMaterial = new THREE.MeshStandardMaterial({
    color: GOAL.frameColor,
    emissive: new THREE.Color(GOAL.emissive),
    roughness: 0.4,
  });

  const frameParts: THREE.Mesh[] = [];
  const addFramePart = (offset: [number, number, number], size: [number, number, number]) => {
    const part = new THREE.Mesh(cube, frameMaterial);
    part.position.set(gx + offset[0], gy + offset[1], gz + offset[2]);
    part.scale.set(size[0], size[1], size[2]);
    scene.add(part);
    frameParts.push(part);
  };

  const t = GOAL.frameThickness;
  addFramePart([0, gh / 2 + t / 2, 0], [gw + t * 2, t, t]);
  addFramePart([0, -gh / 2 - t / 2, 0], [gw + t * 2, t, t]);
  addFramePart([gw / 2 + t / 2, 0, 0], [t, gh, t]);
  addFramePart([-gw / 2 - t / 2, 0, 0], [t, gh, t]);

  return {
    goalMesh,

    dispose() {
      for (const mesh of meshes) scene.remove(mesh);
      for (const part of frameParts) scene.remove(part);
      scene.remove(goalMesh);

      cube.dispose();
      goalMesh.geometry.dispose();
      goalMaterial.dispose();
      frameMaterial.dispose();
      for (const material of materials.values()) material.dispose();
    },
  };
}

/** Cosmetic pulse on the goal gate. Called once per rendered frame. */
export function pulseGoal(mesh: THREE.Mesh, elapsedSeconds: number): void {
  const material = mesh.material as THREE.MeshStandardMaterial;
  material.emissiveIntensity =
    0.6 + Math.sin(elapsedSeconds * GOAL.pulseHz * Math.PI * 2) * 0.4;
}