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
import { NEON, PALETTE, POST } from '../render/palette.ts';

export interface CourseHandle {
  /** Null for goal-less courses such as the Core Rush arena. */
  readonly goalMesh: THREE.Mesh | null;
  /** Remove every mesh from the scene. Colliders are disposed separately. */
  dispose(): void;
}

/**
 * HDR multiplier for the neon edge lines.
 *
 * Above 1 on purpose. The bloom threshold is a luminance cutoff, and a colour
 * authored inside 0..1 can sit below it no matter how saturated it looks in
 * isolation — the surrounding scene is what decides. Multiplying past 1 pushes
 * the lines over the cutoff so they actually glow, which is the entire point of
 * drawing them.
 */
const EDGE_GAIN = POST.edgeGain;

/**
 * Fallback edge hue for a solid with no `color` in the course JSON.
 *
 * Light blue from the ramp. Only reachable if a future course omits the field,
 * since every solid in `tekk-01.json` sets one.
 */
const DEFAULT_SOLID_COLOR = '#9ec7fa';

/**
 * Turn a course colour into a neon edge colour.
 *
 * Hue is preserved exactly — that is the whole point of reading the colour off
 * each pad rather than assigning a palette index — and only saturation and
 * lightness are adjusted, to guarantee the result lands in a range that reads as
 * light rather than as paint.
 *
 * Lightness is **clamped into a window, not forced to a value.** This matters
 * because the course colours are already palette pastels rather than dark
 * surface tones: forcing a single lightness darkened them and threw away the
 * character that distinguishes one pad from the next. The window admits both a
 * dark authored colour and a pale brand pastel, so the pads can differ in tone as
 * well as hue.
 *
 * The result is then scaled past 1 by the edge gain, which is what puts it over
 * the bloom threshold. Channel values clip on purpose — that clipping is the
 * glow.
 */
function neonFromHex(hex: string, gain: number): THREE.Color {
  const color = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  color.setHSL(hsl.h, Math.max(hsl.s, 0.7), Math.min(Math.max(hsl.l, 0.55), 0.72));
  return color.multiplyScalar(gain);
}

export function buildCourse(scene: THREE.Scene, course: Course): CourseHandle {
  // One unit cube shared by every solid; each mesh scales to its own size.
  const cube = new THREE.BoxGeometry(1, 1, 1);

  // One material for every solid body.
  //
  // The previous build coloured each solid from the JSON, which made the lane
  // read as a set of coloured blocks. A single near-black material instead lets
  // the light describe the architecture: the pads are wide so their top faces
  // catch the key light and read as decks, the rails are thin verticals that
  // read as edges, and neither needs a colour to be distinguishable.
  const massMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(PALETTE.mass),
    roughness: 0.88,
    metalness: 0.05,
  });

  // The cube's twelve edges, built once. One line per silhouette is what makes
  // a dark mass read as architecture rather than as a hole in the scene.
  //
  // Note these stay 1px: neither WebGPU nor WebGL supports linewidth on line
  // primitives. That is not a compromise here — a hairline is the technical
  // look being asked for, and the bloom pass gives it the apparent thickness.
  const edgeGeometry = new THREE.EdgesGeometry(cube);

  const edgeMaterials = new Map<string, THREE.LineBasicMaterial>();
  const meshes: THREE.Mesh[] = [];
  const edges: THREE.LineSegments[] = [];

  for (const solid of course.solids) {
    const [sx, sy, sz] = solid.size;
    const [px, py, pz] = solid.position;

    const mesh = new THREE.Mesh(cube, massMaterial);
    mesh.position.set(px, py, pz);
    mesh.scale.set(sx, sy, sz);
    scene.add(mesh);
    meshes.push(mesh);

    const key = solid.color ?? DEFAULT_SOLID_COLOR;
    let edgeMaterial = edgeMaterials.get(key);
    if (!edgeMaterial) {
      edgeMaterial = new THREE.LineBasicMaterial({
        color: neonFromHex(key, EDGE_GAIN),
        // Out of tone mapping so the neon reads at its authored brightness
        // rather than being compressed toward grey along with everything else.
        toneMapped: false,
      });
      edgeMaterials.set(key, edgeMaterial);
    }

    const edge = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    edge.position.set(px, py, pz);
    edge.scale.set(sx, sy, sz);
    scene.add(edge);
    edges.push(edge);
  }

  // --- goal gate ---------------------------------------------------------
  // Only courses with a finish line get one; the arena has none.
  let goalMesh: THREE.Mesh | null = null;
  let goalMaterial: THREE.MeshBasicMaterial | null = null;
  let frameMaterial: THREE.LineBasicMaterial | null = null;
  const frameParts: THREE.LineSegments[] = [];

  if (course.goal) {
    const [gx, gy, gz] = course.goal.position;
    const [gw, gh, gd] = course.goal.size;

    // The slab is the pulse target, so it is an unlit material: an unlit colour
    // can be driven past 1.0 and bloom, which a lit one cannot without a very
    // bright light pointed at it.
    goalMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(NEON.blue).multiplyScalar(0.9),
      transparent: true,
      opacity: GOAL.opacity,
      toneMapped: false,
    });
    // `pulseGoal` is called from the frame loop with only the mesh, so the
    // un-pulsed colour travels with the material rather than in a closure.
    goalMaterial.userData['baseColor'] = new THREE.Color(NEON.blue);

    goalMesh = new THREE.Mesh(new THREE.BoxGeometry(gw, gh, gd), goalMaterial);
    goalMesh.position.set(gx, gy, gz);
    scene.add(goalMesh);

    // A bright frame around the gate reads as a finish line rather than a floating
    // box. Static, so it stays legible while the slab pulses behind it.
    // Local const so the closure below sees a non-null material; the outer
    // `let` is only there for dispose().
    const frameMat = new THREE.LineBasicMaterial({
      // '#' + hex. Passing the bare `fbfaf9` — which is exactly what
      // `toString(16)` produces — looks like a valid colour and is not:
      // THREE.Color parses a leading '#' or a `0x` prefix, and treats any other
      // 6-character string as a named colour, fails, and silently falls back to
      // black. Only the live browser console surfaced this; tsc is happy either
      // way because the argument is still a string.
      color: neonFromHex(`#${NEON.white.toString(16).padStart(6, '0')}`, EDGE_GAIN),
      toneMapped: false,
    });

    frameMaterial = frameMat;

    const addFramePart =(offset: [number, number, number], size: [number, number, number]) => {
      // `edgeGeometry`, not `cube`. A LineSegments built from the raw BoxGeometry
      // would draw every triangle's edges including the face diagonals, turning
      // the gate into a wireframe scribble instead of a frame.
      const part = new THREE.LineSegments(edgeGeometry, frameMat);
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
  }

  return {
    goalMesh,

    dispose() {
      for (const mesh of meshes) scene.remove(mesh);
      for (const edge of edges) scene.remove(edge);
      for (const part of frameParts) scene.remove(part);
      if (goalMesh) scene.remove(goalMesh);

      cube.dispose();
      edgeGeometry.dispose();
      goalMesh?.geometry.dispose();
      goalMaterial?.dispose();
      frameMaterial?.dispose();
      for (const material of edgeMaterials.values()) material.dispose();
      massMaterial.dispose();
    },
  };
}

/**
 * Cosmetic pulse on the goal gate. Called once per rendered frame.
 *
 * Scales the material colour rather than `emissiveIntensity`, because the gate
 * is now unlit — `emissiveIntensity` only means anything to a lit material, and
 * would silently do nothing here.
 */
export function pulseGoal(mesh: THREE.Mesh | null, elapsedSeconds: number): void {
  if (!mesh) return;
  const material = mesh.material as THREE.MeshBasicMaterial;
  const base = material.userData['baseColor'] as THREE.Color | undefined;
  if (!base) return;

  const wave = Math.sin(elapsedSeconds * GOAL.pulseHz * Math.PI * 2);
  // Below 1 at the trough. A gate that never dims reads as a static wall; the
  // pulse is what marks it as the thing to race toward.
  material.color.copy(base).multiplyScalar(0.75 + wave * 0.25);
}