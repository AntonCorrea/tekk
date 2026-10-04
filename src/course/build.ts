/**
 * Course construction
 *
 * Turns a validated Course definition into Three.js meshes and Rapier
 * colliders. This is the only place that knows how a course becomes
 * geometry — everything else reads positions.
 */

import * as THREE from 'three/webgpu';
import { ColliderDesc, Cuboid, RigidBodyDesc } from '@dimforge/rapier3d-compat';
import type { World } from '@dimforge/rapier3d-compat';
import type { Course } from '../shared/course.ts';
import { GOAL, WORLD } from '../constants.ts';

export interface CourseHandle {
  readonly goalMesh: THREE.Mesh;
  /** Remove every mesh from the scene and release the static body. */
  dispose(scene: THREE.Scene): void;
}

/**
 * Build the course.
 *
 * All colliders live on a single fixed body at the origin, each offset by
 * its own translation. Rapier treats this as one compound static object,
 * which is cheaper than a body per solid and keeps the count low.
 */
export function buildCourse(
  scene: THREE.Scene,
  world: World,
  course: Course,
): CourseHandle {
  const staticBody = world.createRigidBody(RigidBodyDesc.fixed());

  const cube = new THREE.BoxGeometry(1, 1, 1);
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const meshes: THREE.Mesh[] = [];

  for (const solid of course.solids) {
    const [sx, sy, sz] = solid.size;
    const [px, py, pz] = solid.position;

    world.createCollider(
      ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2)
        .setTranslation(px, py, pz)
        .setFriction(WORLD.friction)
        .setRestitution(WORLD.restitution),
      staticBody,
    );

    const color = solid.color ?? '#4f7f4a';
    let material = materials.get(color);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        roughness: 0.95,
      });
      materials.set(color, material);
    }

    // Unit cube scaled to size, so every solid shares one geometry.
    const mesh = new THREE.Mesh(cube, material);
    mesh.position.set(px, py, pz);
    mesh.scale.set(sx, sy, sz);
    scene.add(mesh);
    meshes.push(mesh);
  }

  // --- goal gate ---------------------------------------------------------
  const [gx, gy, gz] = course.goal.position;
  const [gw, gh, gd] = course.goal.size;

  const goalMesh = new THREE.Mesh(
    new THREE.BoxGeometry(gw, gh, gd),
    new THREE.MeshStandardMaterial({
      color: GOAL.color,
      emissive: new THREE.Color(GOAL.emissive),
      transparent: true,
      opacity: GOAL.opacity,
      roughness: 0.3,
    }),
  );
  goalMesh.position.set(gx, gy, gz);
  scene.add(goalMesh);

  // A frame around the gate reads as a finish line rather than a box.
  const frameMaterial = new THREE.MeshStandardMaterial({
    color: GOAL.frameColor,
    emissive: new THREE.Color(GOAL.emissive),
    roughness: 0.4,
  });
  const frameParts: THREE.Mesh[] = [];
  const addFramePart = (
    offset: [number, number, number],
    size: [number, number, number],
  ) => {
    const part = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), frameMaterial);
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
    dispose(scene) {
      for (const mesh of meshes) scene.remove(mesh);
      for (const part of frameParts) scene.remove(part);
      scene.remove(goalMesh);
      cube.dispose();
      for (const material of materials.values()) material.dispose();
      frameMaterial.dispose();
      (goalMesh.material as THREE.Material).dispose();
      world.removeRigidBody(staticBody);
    },
  };
}

export interface GroundProbe {
  /** Topmost solid surface at or below `fromY`, or null if nothing is below. */
  topY: number | null;
}

/**
 * Find the highest solid surface beneath a point.
 *
 * Used to drop a respawning player onto whichever pad they fell from, so
 * respawn never leaves them embedded inside geometry. Queries the collider
 * set directly rather than casting a ray — cheaper and needs no collision
 * pipeline state.
 */
export function probeGround(
  world: World,
  x: number,
  z: number,
  fromY: number,
): GroundProbe {
  let best = -Infinity;

  world.forEachCollider((collider) => {
    // Only boxes exist in the course format today. If a second primitive
    // is added this must grow a branch rather than silently ignoring it.
    if (!(collider.shape instanceof Cuboid)) return;
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