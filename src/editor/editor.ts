/**
 * Course editor — `?editor`
 *
 * A visual authoring tool for `src/courses/*.json`, living inside the client
 * itself. Open the game with `?editor` and `main.ts` boots this instead: the
 * stage, the course meshes and a frame loop, and a panel. No server, no
 * physics, no HUD — nothing that belongs to a match.
 *
 * Saving never touches the server. "Save" downloads the course JSON (and on
 * browsers with the File System Access API, "Save to disk" writes a file you
 * pick directly); the file lands in `src/courses/` by hand and the next room
 * picks it up. That is deliberate: the load-bearing rule in this codebase is
 * that clients never name paths the server reads, and a zero-server editor
 * needs no endpoint to guard — there is simply nothing here that can reach
 * the machine the game runs on. Validation is the same `parseCourse` the
 * server runs, so a file that saves clean is a file the room will accept.
 *
 * Controls:
 *   drag (left)    orbit around the target
 *   drag (right)   pan the target
 *   wheel          dolly
 *   click          select a solid, pad, decor piece, spawn or Core point
 *   arrows         nudge in the view plane (Shift = 0.1 fine step)
 *   E / Q          nudge up / down
 *   Del            delete the selection
 *   Esc            deselect
 *   Ctrl+S         save (download)
 *
 * No undo, on purpose: the file on disk is the undo — reopen it. That keeps
 * the editor a thin view over the course data rather than a second document
 * format with its own history to get wrong.
 */

import * as THREE from 'three/webgpu';
import { startFrameLoop } from '../core/loop.ts';
import { createStage } from '../core/stage.ts';
import { buildCourse, type CourseHandle } from '../course/build.ts';
import { ATMOS, NEON, PALETTE } from '../render/palette.ts';
import {
  parseCourse,
  type Course,
  type CourseAtmosphere,
  type CourseDecor,
  type CoursePad,
  type CourseSolid,
  type DecorKind,
  type PadKind,
  type Vec3,
} from '../shared/course.ts';

/**
 * Every course file that shipped with this build, inlined by Vite.
 *
 * The game itself never imports these files — the server ships the running
 * course over the wire — but the editor is a tool, and a tool with no server
 * behind it still needs something to open. The glob lives in this module,
 * which `main.ts` imports dynamically, so a player who never types `?editor`
 * never downloads a course file.
 */
const bundled = import.meta.glob('../courses/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

/**
 * The decor kinds the parser accepts.
 *
 * Mirrored rather than imported: `DECOR_KINDS` in shared/course.ts is private
 * to the parser, and the parser is the authority — offering a kind it does not
 * know fails loudly at save time with the exact path, which is how drift here
 * would get caught.
 */
const DECOR_KINDS_ADDABLE: DecorKind[] = [
  'tower', 'ring', 'block', 'billboard', 'tree', 'watertower',
  'statue', 'traffic', 'searchlight', 'water', 'cable', 'ball',
];

/** Starting sizes for newly added decor, per kind. Rough is fine; edit after. */
const DECOR_SIZE_DEFAULT: Partial<Record<DecorKind, Vec3>> = {
  tower: [6, 20, 6],
  ring: [8, 0.5, 8],
  block: [4, 4, 4],
  billboard: [8, 4, 0.5],
  tree: [3, 6, 3],
  watertower: [2.5, 3.5, 2.5],
  statue: [2, 7, 2],
  traffic: [24, 0.3, 4],
  searchlight: [2, 2, 2],
  water: [30, 0.3, 16],
  cable: [0.4, 0.4, 0.4],
  ball: [3, 3, 3],
};

// The three lists the format has, as the panel's tabs address them.
type ListKey = 'solids' | 'pads' | 'decor';
// What a selection points at. The first three are list entries keyed by id;
// the two points are singular and carry their own fixed id for symmetry.
type SelGroup = ListKey | 'spawn' | 'coreSpawn';

interface Sel {
  group: SelGroup;
  id: string;
}

interface SelectionBounds {
  position: THREE.Vector3;
  scale: THREE.Vector3;
  rotation: [number, number, number];
}

/** Minimal typings for the File System Access API, which TS's DOM lib omits. */
interface WritableFile {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}
interface PickedFileHandle {
  createWritable(): Promise<WritableFile>;
}
interface SavePickerOptions {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}
type SavePicker = (options?: SavePickerOptions) => Promise<PickedFileHandle>;

/**
 * A starter course, run through the parser like any other file: if this
 * template ever drifts from what the engine accepts, the failure belongs
 * here — at "New" — rather than on somebody's first save.
 */
function templateCourse(): Course {
  return parseCourse(
    {
      id: 'takk-new',
      name: 'New Course',
      spawn: [0, 1, 8],
      killY: -20,
      coreSpawn: [0, 2.05, 0],
      solids: [{ id: 'floor', kind: 'box', position: [0, -1, 0], size: [24, 2, 24], color: '#b35bf7' }],
      pads: [],
      decor: [],
    },
    'built-in template',
  );
}

/** An id not yet used by any element — ids share one namespace across lists. */
function uniqueId(course: Course, base: string): string {
  const taken = new Set<string>();
  for (const solid of course.solids) taken.add(solid.id);
  for (const pad of course.pads) taken.add(pad.id);
  for (const piece of course.decor) taken.add(piece.id);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * The download name for a course id.
 *
 * The format lets `id` be any non-empty string, so the FILENAME gets
 * sanitised separately — the JSON itself keeps the id exactly as authored.
 */
function safeFileName(id: string): string {
  const cleaned = id.replace(/[^\w.-]+/g, '-').replace(/^-+/, '');
  return `${cleaned || 'course'}.json`;
}

/** `../courses/takk-arena.json` → `takk-arena`. */
function baseName(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  return file.endsWith('.json') ? file.slice(0, -5) : file;
}

const deg = THREE.MathUtils.degToRad;

/** Nudged positions would otherwise carry camera-maths garbage into the file. */
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** `PALETTE.base` as the `#rrggbb` string the course format stores. */
const baseHex = `#${PALETTE.base.toString(16).padStart(6, '0')}`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export async function bootEditor(container: HTMLElement): Promise<void> {
  const stage = await createStage(container);
  const scene = stage.scene;
  const camera = stage.camera;
  const canvas = stage.renderer.domElement;

  // --- state --------------------------------------------------------------

  // Replaced wholesale by the first adopt() below; `let` because load and
  // New swap the whole document, exactly as a map swap does in the game.
  let course: Course = templateCourse();
  let handle: CourseHandle | null = null;
  let sel: Sel | null = null;
  let activeList: ListKey = 'solids';
  /** Unsaved edits exist — arms the unload guard and the discard confirms. */
  let edited = false;
  /** Rebuild flags: immediate (nudges, adds) vs a 250ms trailing debounce (typing). */
  let rebuildNow = false;
  let rebuildAt = 0;

  /** Mark the document edited and schedule a scene rebuild. */
  function touch(debounce: boolean): void {
    edited = true;
    if (debounce) rebuildAt = performance.now() + 250;
    else {
      rebuildNow = true;
      rebuildAt = 0;
    }
  }

  // --- the two points, as scene markers -----------------------------------

  // The format has no mesh for spawn or coreSpawn — the game draws neither —
  // so the editor adds its own. Grouped so they are one thing to keep alive.
  const markers = new THREE.Group();
  const spawnMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 16, 12),
    new THREE.MeshBasicMaterial({ color: new THREE.Color('#ead2a9'), toneMapped: false }),
  );
  const coreMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.7, 16, 12),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(NEON.cyan), toneMapped: false }),
  );
  markers.add(spawnMarker, coreMarker);
  scene.add(markers);

  function updateMarkers(): void {
    spawnMarker.position.set(course.spawn[0], course.spawn[1], course.spawn[2]);
    if (course.coreSpawn) {
      coreMarker.visible = true;
      coreMarker.position.set(course.coreSpawn[0], course.coreSpawn[1], course.coreSpawn[2]);
    } else {
      coreMarker.visible = false;
    }
  }

  // --- selection cage -----------------------------------------------------

  // The cage is the same twelve edges every solid wears, drawn through
  // geometry so a selection stays visible inside a building-sized box.
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const highlight = new THREE.LineSegments(
    new THREE.EdgesGeometry(unitBox),
    new THREE.LineBasicMaterial({
      color: new THREE.Color(NEON.white),
      toneMapped: false,
      depthTest: false,
    }),
  );
  highlight.renderOrder = 10;
  highlight.visible = false;
  scene.add(highlight);

  function updateHighlight(): void {
    const bounds = selectionBounds();
    if (!bounds) {
      highlight.visible = false;
      return;
    }
    highlight.visible = true;
    highlight.position.copy(bounds.position);
    highlight.scale.copy(bounds.scale);
    highlight.rotation.set(bounds.rotation[0], bounds.rotation[1], bounds.rotation[2]);
  }

  function selectionBounds(): SelectionBounds | null {
    const s = sel;
    if (!s) return null;

    const box = (position: Vec3, size: Vec3, rotation?: Vec3): SelectionBounds => ({
      position: new THREE.Vector3(position[0], position[1], position[2]),
      scale: new THREE.Vector3(size[0], size[1], size[2]),
      rotation: rotation ? [deg(rotation[0]), deg(rotation[1]), deg(rotation[2])] : [0, 0, 0],
    });

    if (s.group === 'spawn') return box(course.spawn, [1.6, 1.6, 1.6]);
    if (s.group === 'coreSpawn') {
      return course.coreSpawn ? box(course.coreSpawn, [2, 2, 2]) : null;
    }

    const item = selectedListItem();
    if (!item) return null;
    if (s.group === 'solids') {
      const solid = item as CourseSolid;
      return box(solid.position, solid.size, solid.rotation);
    }
    if (s.group === 'decor') {
      const piece = item as CourseDecor;
      if (piece.kind === 'cable' && piece.to) {
        // A cable is a line: span its two ends with an axis-aligned cage
        // rather than pretending its `size` box is the whole piece.
        const from = piece.position;
        const to = piece.to;
        const pad = 1;
        const min = [Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.min(from[2], to[2])];
        const max = [Math.max(from[0], to[0]), Math.max(from[1], to[1]), Math.max(from[2], to[2])];
        return box(
          [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
          [max[0] - min[0] + pad, max[1] - min[1] + pad, max[2] - min[2] + pad],
        );
      }
      return box(piece.position, piece.size, [0, piece.rotationY ?? 0, 0]);
    }
    const padItem = item as CoursePad;
    return box(padItem.position, padItem.size);
  }

  // --- pick proxies -------------------------------------------------------

  // Every element gets an invisible stand-in that exists only to be
  // raycast. Reverse-engineering picks from the real meshes is hopeless:
  // buildCourse welds solids into plain cubes with no ids, and a pad or a
  // tower is several visual parts rather than one box. Proxies sit on a
  // layer the camera never renders (layer 1) and the raycaster below only
  // tests that layer, so they cost a scene node each and nothing else.
  const PICK_LAYER = 1;
  const proxies: THREE.Mesh[] = [];
  // Never rendered, so one shared material is enough; `visible: true` on
  // purpose — visibility, not layers, would be unreliable to reason about.
  const proxyMaterial = new THREE.MeshBasicMaterial();
  const proxySphere = new THREE.SphereGeometry(1, 12, 8);
  const raycaster = new THREE.Raycaster();
  raycaster.layers.set(PICK_LAYER);

  function rebuildProxies(): void {
    for (const proxy of proxies) scene.remove(proxy);
    proxies.length = 0;

    const push = (
      selection: Sel,
      geometry: THREE.BufferGeometry,
      position: Vec3,
      size: Vec3,
      rotation?: Vec3,
    ): THREE.Mesh => {
      const proxy = new THREE.Mesh(geometry, proxyMaterial);
      proxy.layers.set(PICK_LAYER);
      proxy.position.set(position[0], position[1], position[2]);
      proxy.scale.set(size[0], size[1], size[2]);
      if (rotation) proxy.rotation.set(deg(rotation[0]), deg(rotation[1]), deg(rotation[2]));
      proxy.userData['pick'] = selection;
      scene.add(proxy);
      proxies.push(proxy);
      return proxy;
    };

    for (const solid of course.solids) {
      push({ group: 'solids', id: solid.id }, unitBox, solid.position, solid.size, solid.rotation);
    }
    for (const pad of course.pads) {
      push({ group: 'pads', id: pad.id }, unitBox, pad.position, pad.size);
    }
    for (const piece of course.decor) {
      if (piece.kind === 'cable' && piece.to) {
        // Oriented slab from end to end so the whole span is clickable.
        const from = piece.position;
        const to = piece.to;
        const dx = to[0] - from[0];
        const dy = to[1] - from[1];
        const dz = to[2] - from[2];
        const length = Math.hypot(dx, dy, dz);
        const thickness = Math.max(piece.size[0], piece.size[1], 1);
        const proxy = push(
          { group: 'decor', id: piece.id },
          unitBox,
          [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2],
          [thickness, thickness, length],
        );
        const direction = new THREE.Vector3(dx, dy, dz);
        if (direction.lengthSq() > 1e-9) {
          proxy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.normalize());
        }
      } else {
        push({ group: 'decor', id: piece.id }, unitBox, piece.position, piece.size, [
          0,
          piece.rotationY ?? 0,
          0,
        ]);
      }
    }
    push({ group: 'spawn', id: 'spawn' }, proxySphere, course.spawn, [1.2, 1.2, 1.2]);
    if (course.coreSpawn) {
      push({ group: 'coreSpawn', id: 'coreSpawn' }, proxySphere, course.coreSpawn, [1.5, 1.5, 1.5]);
    }
  }

  function pick(clientX: number, clientY: number): void {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(proxies, false)[0];
    if (!hit) {
      select(null);
      return;
    }
    select(hit.object.userData['pick'] as Sel);
  }

  // --- rebuild ------------------------------------------------------------

  function rebuild(): void {
    rebuildNow = false;
    rebuildAt = 0;
    handle?.dispose();
    handle = buildCourse(scene, course);
    stage.setAtmosphere(course.atmosphere);
    rebuildProxies();
    updateMarkers();
    updateHighlight();
    renderHeader();
  }

  // --- camera -------------------------------------------------------------

  // The game's rig follows a racer; an editor needs to look at a place. The
  // standard orbit model: a target, a spherical offset from it, and three
  // gestures on three buttons. Both orbit and pan are grab-consistent —
  // drag down and what you are holding moves down the screen.
  const rig = { target: new THREE.Vector3(), yaw: 0.9, pitch: 0.45, dist: 60 };

  function applyCamera(): void {
    const cosPitch = Math.cos(rig.pitch);
    camera.position.set(
      rig.target.x + Math.sin(rig.yaw) * cosPitch * rig.dist,
      rig.target.y + Math.sin(rig.pitch) * rig.dist,
      rig.target.z + Math.cos(rig.yaw) * cosPitch * rig.dist,
    );
    camera.lookAt(rig.target);
  }

  function frameCourse(): void {
    // Bounds from the solids as if unrotated: a ramp reaching a little past
    // its axis-aligned box is a rounding error against flying the camera to
    // the wrong end of the map.
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const solid of course.solids) {
      minX = Math.min(minX, solid.position[0] - solid.size[0] / 2);
      minY = Math.min(minY, solid.position[1] - solid.size[1] / 2);
      minZ = Math.min(minZ, solid.position[2] - solid.size[2] / 2);
      maxX = Math.max(maxX, solid.position[0] + solid.size[0] / 2);
      maxY = Math.max(maxY, solid.position[1] + solid.size[1] / 2);
      maxZ = Math.max(maxZ, solid.position[2] + solid.size[2] / 2);
    }
    if (!Number.isFinite(minX)) return; // parser forbids zero solids; belt and braces
    rig.target.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    rig.yaw = 0.9;
    rig.pitch = 0.45;
    rig.dist = Math.max(
      24,
      Math.max(maxX - minX, maxY - minY, maxZ - minZ) * 1.4 + 16,
    );
  }

  // --- pointer ------------------------------------------------------------

  let dragButton = -1;
  let downAt = 0;
  let moved = 0;

  canvas.style.cursor = 'grab';
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  canvas.addEventListener('pointerdown', (event) => {
    dragButton = event.button;
    downAt = performance.now();
    moved = 0;
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', (event) => {
    if (dragButton < 0) return;
    const dx = event.movementX;
    const dy = event.movementY;
    moved += Math.abs(dx) + Math.abs(dy);
    if (dragButton === 0) {
      rig.yaw -= dx * 0.005;
      rig.pitch = Math.min(1.45, Math.max(-1.45, rig.pitch + dy * 0.005));
    } else {
      // Pan the TARGET, scaled by distance so the world tracks the cursor.
      const k = rig.dist * 0.0016;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
      rig.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    }
  });

  canvas.addEventListener('pointerup', (event) => {
    if (dragButton < 0) return;
    // A click — not a drag — selects. Six pixels of slop and most of a
    // second: an orbit that barely started should not quietly re-target.
    const wasClick = dragButton === 0 && moved < 6 && performance.now() - downAt < 600;
    dragButton = -1;
    canvas.style.cursor = 'grab';
    if (wasClick) pick(event.clientX, event.clientY);
  });

  canvas.addEventListener('pointercancel', () => {
    dragButton = -1;
    canvas.style.cursor = 'grab';
  });

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      rig.dist = Math.min(500, Math.max(6, rig.dist * Math.exp(event.deltaY * 0.0012)));
    },
    { passive: false },
  );

  // --- selection ----------------------------------------------------------

  function select(next: Sel | null): void {
    sel = next;
    if (
      next &&
      (next.group === 'solids' || next.group === 'pads' || next.group === 'decor')
    ) {
      activeList = next.group;
    }
    renderElements();
    renderInspector();
    updateHighlight();
  }

  function selectedListItem(): CourseSolid | CoursePad | CourseDecor | null {
    const s = sel;
    if (!s) return null;
    if (s.group === 'solids') return course.solids.find((entry) => entry.id === s.id) ?? null;
    if (s.group === 'pads') return course.pads.find((entry) => entry.id === s.id) ?? null;
    if (s.group === 'decor') return course.decor.find((entry) => entry.id === s.id) ?? null;
    return null;
  }

  /** The live position array of whatever is selected, for nudges. */
  function selectedPosition(): Vec3 | null {
    const s = sel;
    if (!s) return null;
    if (s.group === 'spawn') return course.spawn;
    if (s.group === 'coreSpawn') return course.coreSpawn ?? null;
    const item = selectedListItem();
    return item ? item.position : null;
  }

  // --- keyboard -----------------------------------------------------------

  globalThis.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    const typing =
      target !== null &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');

    // Save beats the browser's own "Save page as", fields included.
    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyS') {
      event.preventDefault();
      saveDownload();
      return;
    }
    if (typing) return;

    if (event.code === 'Escape') {
      select(null);
      return;
    }
    if (!sel) return;

    if (event.code === 'Delete' || event.code === 'Backspace') {
      event.preventDefault();
      deleteSelection();
      return;
    }

    // Arrows move in the VIEW plane — Left is always left on screen, which
    // world axes are not — and E/Q climb the world. Shift drops to a fine
    // step. Rounded on the way in: a camera-relative delta is otherwise a
    // page of irrational digits in the saved file.
    const step = event.shiftKey ? 0.1 : 0.5;
    let screenRight = 0;
    let screenForward = 0;
    let worldUp = 0;
    if (event.code === 'ArrowLeft') screenRight = -step;
    else if (event.code === 'ArrowRight') screenRight = step;
    else if (event.code === 'ArrowUp') screenForward = step;
    else if (event.code === 'ArrowDown') screenForward = -step;
    else if (event.code === 'KeyE') worldUp = step;
    else if (event.code === 'KeyQ') worldUp = -step;
    else return;

    event.preventDefault();
    const position = selectedPosition();
    if (!position) return;
    const forward = new THREE.Vector3().subVectors(rig.target, camera.position);
    forward.y = 0;
    if (forward.lengthSq() < 1e-9) forward.set(0, 0, -1);
    else forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
    position[0] = round3(position[0] + right.x * screenRight + forward.x * screenForward);
    position[1] = round3(position[1] + worldUp);
    position[2] = round3(position[2] + right.z * screenRight + forward.z * screenForward);
    touch(true);
    // The cage follows now, not at the next frame's rebuild — a nudge that
    // lagged its own outline would feel broken.
    updateMarkers();
    updateHighlight();
  });

  // --- element operations -------------------------------------------------

  function deleteSelection(): void {
    const s = sel;
    if (!s) return;
    if (s.group === 'spawn' || s.group === 'coreSpawn') {
      status('spawn and the Core point can be moved, not deleted', true);
      return;
    }
    if (s.group === 'solids') course.solids = course.solids.filter((entry) => entry.id !== s.id);
    else if (s.group === 'pads') course.pads = course.pads.filter((entry) => entry.id !== s.id);
    else course.decor = course.decor.filter((entry) => entry.id !== s.id);
    touch(true);
    select(null);
  }

  function duplicateSelection(): void {
    const s = sel;
    if (!s || s.group === 'spawn' || s.group === 'coreSpawn') return;
    const item = selectedListItem();
    if (!item) return;
    const copy = structuredClone(item);
    copy.id = uniqueId(course, `${item.id}-copy`);
    // Offset on X and Z: a copy hidden exactly inside its original looks
    // like nothing happened, and one axis alone disappears when the camera
    // looks down it.
    copy.position[0] = round3(copy.position[0] + 1);
    copy.position[2] = round3(copy.position[2] + 1);
    if (s.group === 'solids') {
      const list = course.solids;
      list.splice(list.findIndex((entry) => entry.id === s.id) + 1, 0, copy as CourseSolid);
    } else if (s.group === 'pads') {
      const list = course.pads;
      list.splice(list.findIndex((entry) => entry.id === s.id) + 1, 0, copy as CoursePad);
    } else {
      const list = course.decor;
      list.splice(list.findIndex((entry) => entry.id === s.id) + 1, 0, copy as CourseDecor);
    }
    touch(true);
    select({ group: s.group, id: copy.id });
  }

  /** Where new elements land: the camera's target, snapped to a half metre. */
  function placementPoint(): Vec3 {
    return [round3(Math.round(rig.target.x * 2) / 2), round3(Math.round(rig.target.y * 2) / 2), round3(Math.round(rig.target.z * 2) / 2)];
  }

  function addSolid(): void {
    const item: CourseSolid = {
      id: uniqueId(course, 'box'),
      kind: 'box',
      position: placementPoint(),
      size: [4, 1, 4],
    };
    course.solids.push(item);
    touch(true);
    select({ group: 'solids', id: item.id });
  }

  function addPad(kind: PadKind): void {
    const item: CoursePad = {
      id: uniqueId(course, kind),
      kind,
      position: placementPoint(),
      size: [4, 0.4, 4],
    };
    // The parser demands a direction from a boost pad and ignores one on a
    // jump pad, so give it here and drop it there — the saved file then
    // holds exactly what the format says it should.
    if (kind === 'boost') item.direction = [0, 1];
    course.pads.push(item);
    touch(true);
    select({ group: 'pads', id: item.id });
  }

  function addDecor(kind: DecorKind): void {
    const position = placementPoint();
    const item: CourseDecor = {
      id: uniqueId(course, kind),
      kind,
      position,
      size: DECOR_SIZE_DEFAULT[kind] ?? [4, 4, 4],
    };
    // The two kinds with parser-mandated fields get theirs up front, so the
    // piece is saveable the instant it exists.
    if (kind === 'billboard') item.text = 'TEKK';
    if (kind === 'cable') item.to = [position[0] + 10, position[1], position[2]];
    course.decor.push(item);
    touch(true);
    select({ group: 'decor', id: item.id });
  }

  function changePadKind(item: CoursePad, kind: PadKind): void {
    item.kind = kind;
    if (kind === 'boost' && !item.direction) item.direction = [0, 1];
    if (kind === 'jump') delete item.direction;
    touch(true);
  }

  function changeDecorKind(item: CourseDecor, kind: DecorKind): void {
    item.kind = kind;
    if (kind === 'billboard' && !item.text) item.text = 'TEKK';
    if (kind === 'cable' && !item.to) {
      item.to = [item.position[0] + 10, item.position[1], item.position[2]];
    }
    // `cap` is towers-only; carrying it off a tower would fail the save.
    if (kind !== 'tower' && item.cap !== undefined) {
      delete item.cap;
      delete item.capHeight;
    }
    touch(true);
  }

  // --- load / save --------------------------------------------------------

  function adopt(next: Course): void {
    course = next;
    sel = null;
    activeList = 'solids';
    edited = false;
    frameCourse();
    rebuild();
    renderCourseFields();
    renderElements();
    renderInspector();
    status(`loaded "${next.id}" — ${next.solids.length} solids, ${next.pads.length} pads`);
  }

  function guardEdits(): boolean {
    return !edited || globalThis.confirm('Discard unsaved changes?');
  }

  /** The course as the server would see it, or a loud reason it would not. */
  function validatedCourse(): Course | null {
    try {
      // Round-tripped through the parser on purpose: the file that leaves
      // here is the file that parses, with boost directions normalised and
      // every rule checked, not merely JSON that looks right.
      return parseCourse(structuredClone(course), `${course.id || 'course'}.json`);
    } catch (err) {
      status(err instanceof Error ? err.message : String(err), true);
      return null;
    }
  }

  function saveDownload(): void {
    const valid = validatedCourse();
    if (!valid) return;
    const json = `${JSON.stringify(valid, null, 2)}\n`;
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = el('a');
    link.href = url;
    link.download = safeFileName(valid.id);
    link.click();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000);
    edited = false;
    status(`saved ${link.download} — drop it into src/courses/ and restart the server`);
  }

  const pickerApi = (globalThis as unknown as { showSaveFilePicker?: SavePicker })
    .showSaveFilePicker;

  async function saveDisk(): Promise<void> {
    if (!pickerApi) return;
    const valid = validatedCourse();
    if (!valid) return;
    try {
      const handle = await pickerApi.call(globalThis, {
        suggestedName: safeFileName(valid.id),
        types: [{ description: 'Course JSON', accept: { 'application/json': ['.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(`${JSON.stringify(valid, null, 2)}\n`);
      await writable.close();
      edited = false;
      status(`wrote ${safeFileName(valid.id)}`);
    } catch (err) {
      // Backing out of the dialog is not a failure.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      status(err instanceof Error ? err.message : String(err), true);
    }
  }

  function openBundled(path: string): boolean {
    if (!guardEdits()) return false;
    const raw = bundled[path];
    if (raw === undefined) {
      status(`"${baseName(path)}" is not in this build`, true);
      return false;
    }
    try {
      // Clone first: parseCourse shares its vectors with the object it
      // reads, and editing through them would corrupt the inlined copy for
      // every later "Open" in this session.
      adopt(parseCourse(structuredClone(raw), baseName(path)));
      return true;
    } catch (err) {
      status(err instanceof Error ? err.message : String(err), true);
      return false;
    }
  }

  async function openFile(file: File): Promise<void> {
    if (!guardEdits()) return;
    try {
      adopt(parseCourse(JSON.parse(await file.text()), file.name));
    } catch (err) {
      status(err instanceof Error ? err.message : String(err), true);
    }
  }

  // --- panel --------------------------------------------------------------
  //
  // Built once; the render functions below replaceChildren() their own
  // sections. Typing in a field never re-renders the field it is typing in —
  // only the list or the header follow a rename — so focus is never yanked
  // out of an input mid-word.

  const panel = el('div', 'ed-panel');
  container.appendChild(panel);

  const head = el('header', 'ed-head');
  const title = el('span', 'ed-title', 'COURSE EDITOR');
  const fileLabel = el('span', 'ed-file');
  const counts = el('span', 'ed-counts');
  head.append(title, fileLabel, counts);

  const statusLine = el('div', 'ed-status');
  statusLine.hidden = true;

  function status(message: string, isError = false): void {
    statusLine.textContent = message;
    statusLine.classList.toggle('is-err', isError);
    statusLine.hidden = false;
  }

  function sectionLabel(text: string): HTMLSpanElement {
    return el('span', 'ed-label', text);
  }

  function fieldBlock(labelText: string, ...controls: HTMLElement[]): HTMLDivElement {
    const block = el('div', 'ed-f');
    block.append(sectionLabel(labelText));
    const row = el('div', 'ed-row');
    row.append(...controls);
    block.append(row);
    return block;
  }

  function textInput(value: string, onInput: (value: string) => void): HTMLInputElement {
    const input = el('input', 'ed-in');
    input.type = 'text';
    input.value = value;
    input.addEventListener('input', () => onInput(input.value));
    return input;
  }

  function numberInput(value: number, step: number, onInput: (value: number) => void): HTMLInputElement {
    const input = el('input', 'ed-in');
    input.type = 'number';
    input.step = String(step);
    input.value = String(round3(value));
    input.addEventListener('input', () => {
      const parsed = Number.parseFloat(input.value);
      if (Number.isFinite(parsed)) onInput(round3(parsed));
    });
    return input;
  }

  /** A colour swatch wired to the course field behind it. */
  function colorInput(value: string, onInput: (value: string) => void): HTMLInputElement {
    const input = el('input', 'ed-in ed-color');
    input.type = 'color';
    input.value = value;
    input.addEventListener('input', () => onInput(input.value));
    return input;
  }

  function vec3Controls(vec: Vec3, step: number, onChange: () => void): HTMLInputElement[] {
    const inputs: HTMLInputElement[] = [];
    for (let axis = 0; axis < 3; axis++) {
      inputs.push(
        numberInput(vec[axis], step, (value) => {
          vec[axis] = value;
          onChange();
        }),
      );
    }
    return inputs;
  }

  function vec3Row(labelText: string, vec: Vec3, step: number, onChange: () => void): HTMLDivElement {
    return fieldBlock(labelText, ...vec3Controls(vec, step, onChange));
  }

  function selectInput(
    options: Array<{ value: string; label: string }>,
    current: string,
    onChange: (value: string) => void,
  ): HTMLSelectElement {
    const select = el('select', 'ed-in');
    for (const option of options) {
      const node = el('option');
      node.value = option.value;
      node.textContent = option.label;
      select.append(node);
    }
    select.value = current;
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  function button(labelText: string, onClick: () => void, mini = false): HTMLButtonElement {
    const button = el('button', mini ? 'ed-btn ed-mini' : 'ed-btn', labelText);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }

  /**
   * The pattern for every optional field the format has (`color`, `rotation`,
   * `cap`): absent renders an "add" button, present renders the control plus
   * a "clear". Toggling creates or DELETES the key, so a saved file holds no
   * stray zero-rotation or default colour the author never chose.
   */
  function optionalField(
    labelText: string,
    present: boolean,
    onAdd: () => void,
    onClear: () => void,
    controls: () => HTMLElement[],
  ): HTMLDivElement {
    if (!present) return fieldBlock(labelText, button('add', onAdd, true));
    return fieldBlock(labelText, ...controls(), button('clear', onClear, true));
  }

  // --- file row -----------------------------------------------------------

  const fileRow = el('div', 'ed-row');
  const openSelect = el('select', 'ed-in ed-open');
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.hidden = true;

  const firstOption = el('option');
  firstOption.value = '';
  firstOption.textContent = 'Open…';
  openSelect.append(firstOption);
  const bundledNames = Object.keys(bundled)
    .map((path) => ({ path, name: baseName(path) }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of bundledNames) {
    const option = el('option');
    option.value = entry.path;
    option.textContent = entry.name;
    openSelect.append(option);
  }
  if (bundledNames.length === 0) openSelect.hidden = true;

  fileRow.append(
    button('New', () => {
      if (!guardEdits()) return;
      adopt(templateCourse());
      status('new course — Save to write it to src/courses/');
    }),
    button('Save', saveDownload),
  );
  if (pickerApi) fileRow.append(button('Save to disk…', () => void saveDisk()));
  fileRow.append(
    openSelect,
    button('File…', () => fileInput.click()),
    fileInput,
  );

  openSelect.addEventListener('change', () => {
    const path = openSelect.value;
    if (path === '') return;
    // A cancelled discard-confirm or a failed parse falls back to the
    // placeholder; a successful load keeps showing what is now open.
    if (!openBundled(path)) openSelect.value = '';
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) void openFile(file);
  });

  // --- course fields ------------------------------------------------------

  const courseFields = el('div', 'ed-section');

  function renderCourseFields(): void {
    courseFields.replaceChildren();
    courseFields.append(sectionLabel('Course'));

    const idInput = textInput(course.id, (value) => {
      course.id = value;
      renderHeader();
      touch(false);
    });
    const nameInput = textInput(course.name, (value) => {
      course.name = value;
      touch(false);
    });
    courseFields.append(fieldBlock('id (file name)', idInput), fieldBlock('name', nameInput));

    courseFields.append(
      vec3Row('spawn — Y is the feet', course.spawn, 0.5, () => {
        touch(false);
        updateMarkers();
        updateHighlight();
      }),
    );

    if (course.coreSpawn) {
      courseFields.append(
        vec3Row('coreSpawn', course.coreSpawn, 0.5, () => {
          touch(false);
          updateMarkers();
          updateHighlight();
        }),
        fieldBlock(
          'core point',
          button('clear', () => {
            delete course.coreSpawn;
            if (sel?.group === 'coreSpawn') select(null);
            touch(true);
            renderCourseFields();
          }, true),
        ),
      );
    } else {
      courseFields.append(
        fieldBlock(
          'coreSpawn',
          button('add', () => {
            course.coreSpawn = [course.spawn[0], course.spawn[1] + 1, course.spawn[2]];
            touch(true);
            renderCourseFields();
          }, true),
        ),
      );
    }

    const killYInput = numberInput(course.killY, 1, (value) => {
      course.killY = value;
      touch(false);
    });
    courseFields.append(fieldBlock('killY', killYInput));

    // --- atmosphere -------------------------------------------------------
    // The old "own city (drops the grid)" checkbox grew into a real field:
    // each course brings its own background, fog colour and fog density.
    // Declaring any of them means the course owns its look, so the generic
    // grid and horizon towers step aside (see shared/course.ts `atmosphere`).
    const atmo = course.atmosphere;
    const ensureAtmo = (): CourseAtmosphere => {
      if (!course.atmosphere) course.atmosphere = {};
      return course.atmosphere;
    };
    // The block exists only while at least one key is set, so a saved file
    // never carries an empty atmosphere that silently drops the grid.
    const pruneAtmo = (): void => {
      const a = course.atmosphere;
      if (
        a &&
        a.background === undefined &&
        a.fog === undefined &&
        a.fogDensity === undefined
      ) {
        delete course.atmosphere;
      }
    };

    courseFields.append(sectionLabel('atmosphere'));
    courseFields.append(
      optionalField(
        'background',
        atmo?.background !== undefined,
        () => {
          ensureAtmo().background = baseHex;
          touch(true);
          renderCourseFields();
        },
        () => {
          delete ensureAtmo().background;
          pruneAtmo();
          touch(true);
          renderCourseFields();
        },
        () => {
          const value = atmo?.background;
          if (value === undefined) return [];
          return [
            colorInput(value, (next) => {
              ensureAtmo().background = next;
              touch(false);
            }),
          ];
        },
      ),
      // Fog falls back to the background colour unless written apart, so the
      // add button offers the current background as the coherent default.
      optionalField(
        'fog',
        atmo?.fog !== undefined,
        () => {
          ensureAtmo().fog = atmo?.background ?? baseHex;
          touch(true);
          renderCourseFields();
        },
        () => {
          delete ensureAtmo().fog;
          pruneAtmo();
          touch(true);
          renderCourseFields();
        },
        () => {
          const value = atmo?.fog;
          if (value === undefined) return [];
          return [
            colorInput(value, (next) => {
              ensureAtmo().fog = next;
              touch(false);
            }),
          ];
        },
      ),
      optionalField(
        'fog density',
        atmo?.fogDensity !== undefined,
        () => {
          ensureAtmo().fogDensity = ATMOS.fogDensity;
          touch(true);
          renderCourseFields();
        },
        () => {
          delete ensureAtmo().fogDensity;
          pruneAtmo();
          touch(true);
          renderCourseFields();
        },
        () => {
          const value = atmo?.fogDensity;
          if (value === undefined) return [];
          return [
            numberInput(value, 0.001, (next) => {
              ensureAtmo().fogDensity = next;
              touch(false);
            }),
          ];
        },
      ),
    );
    if (atmo) {
      courseFields.append(
        el(
          'div',
          'ed-note',
          'Own atmosphere: the generic grid and horizon towers drop out. ' +
            'Clear all three to bring the generic look back.',
        ),
      );
    }
  }

  // --- tabs / add row / list ---------------------------------------------

  const tabsRow = el('nav', 'ed-tabs');
  const addRow = el('div', 'ed-row');
  const decorKindSelect = el('select', 'ed-in ed-kindsel');
  for (const kind of DECOR_KINDS_ADDABLE) {
    const option = el('option');
    option.value = kind;
    option.textContent = kind;
    decorKindSelect.append(option);
  }
  const listEl = el('ul', 'ed-list');

  function renderElements(): void {
    const countsByList: Record<ListKey, number> = {
      solids: course.solids.length,
      pads: course.pads.length,
      decor: course.decor.length,
    };

    tabsRow.replaceChildren();
    for (const key of ['solids', 'pads', 'decor'] as ListKey[]) {
      const tab = button(`${key} ${countsByList[key]}`, () => {
        activeList = key;
        renderElements();
      });
      tab.classList.add('ed-tab');
      if (key === activeList) tab.classList.add('is-on');
      tabsRow.append(tab);
    }

    addRow.replaceChildren();
    if (activeList === 'solids') {
      addRow.append(button('+ box', addSolid, true));
    } else if (activeList === 'pads') {
      addRow.append(
        button('+ boost', () => addPad('boost'), true),
        button('+ jump', () => addPad('jump'), true),
      );
    } else {
      addRow.append(button('+ decor', () => addDecor(decorKindSelect.value as DecorKind), true), decorKindSelect);
    }

    listEl.replaceChildren();
    const entries: Array<{ id: string; kind: string }> =
      activeList === 'solids'
        ? course.solids.map((entry) => ({ id: entry.id, kind: entry.kind }))
        : activeList === 'pads'
          ? course.pads.map((entry) => ({ id: entry.id, kind: entry.kind }))
          : course.decor.map((entry) => ({ id: entry.id, kind: entry.kind }));

    if (entries.length === 0) {
      const empty = el('li', 'ed-item is-empty', `no ${activeList} yet`);
      listEl.append(empty);
      return;
    }
    for (const entry of entries) {
      const row = el('li', 'ed-item', entry.id);
      row.append(el('span', 'ed-kind', entry.kind));
      if (sel && sel.group === activeList && sel.id === entry.id) row.classList.add('is-sel');
      row.addEventListener('click', () => select({ group: activeList, id: entry.id }));
      listEl.append(row);
    }
  }

  // --- inspector ----------------------------------------------------------

  const inspector = el('div', 'ed-inspector');

  function renderInspector(): void {
    inspector.replaceChildren();
    const s = sel;
    if (!s) {
      inspector.append(
        sectionLabel('Inspector'),
        el('div', 'ed-empty', 'Nothing selected. Click an element in the scene, or a row in the list.'),
      );
      return;
    }

    if (s.group === 'spawn' || s.group === 'coreSpawn') {
      const vec = s.group === 'spawn' ? course.spawn : course.coreSpawn;
      inspector.append(sectionLabel(s.group === 'spawn' ? 'Spawn' : 'Core spawn'));
      if (!vec) {
        select(null);
        return;
      }
      inspector.append(
        vec3Row('position', vec, 0.5, () => {
          touch(false);
          updateMarkers();
          updateHighlight();
        }),
      );
      inspector.append(
        el(
          'div',
          'ed-note',
          s.group === 'spawn'
            ? 'Y is the feet. Keep it above killY and over a solid — the respawn probe only understands unrotated boxes.'
            : 'Where the Core rests. Hover it a little above its dais, out of any ramp.',
        ),
      );
      return;
    }

    const item = selectedListItem();
    if (!item) {
      select(null);
      return;
    }
    const label = s.group === 'solids' ? 'Solid' : s.group === 'pads' ? 'Pad' : 'Decor';
    inspector.append(sectionLabel(label));

    // The rename path retargets the selection so the list highlight, the
    // proxies and the cage all agree on the new id at the next rebuild —
    // and re-renders only the LIST, never this input under the cursor.
    inspector.append(
      fieldBlock(
        'id',
        textInput(item.id, (value) => {
          const previous = item.id;
          item.id = value;
          if (s.id === previous) s.id = value;
          renderElements();
          touch(false);
        }),
      ),
    );

    inspector.append(
      vec3Row('position', item.position, 0.5, () => {
        touch(false);
        updateHighlight();
      }),
      vec3Row('size', item.size, 0.5, () => {
        touch(false);
        updateHighlight();
      }),
    );

    if (s.group === 'solids') renderSolidFields(item as CourseSolid);
    else if (s.group === 'pads') renderPadFields(item as CoursePad);
    else renderDecorFields(item as CourseDecor);

    const actions = el('div', 'ed-row');
    actions.append(button('duplicate', duplicateSelection), button('delete', deleteSelection));
    inspector.append(actions);
  }

  function renderSolidFields(solid: CourseSolid): void {
    inspector.append(
      optionalField(
        'rotation ° — ramp, ±60',
        solid.rotation !== undefined,
        () => {
          solid.rotation = [10, 0, 0];
          touch(true);
          renderInspector();
        },
        () => {
          delete solid.rotation;
          touch(true);
          renderInspector();
        },
        () =>
          vec3Controls(solid.rotation ?? [0, 0, 0], 1, () => {
            touch(false);
            updateHighlight();
          }),
      ),
      optionalField(
        'colour — neon edge',
        solid.color !== undefined,
        () => {
          solid.color = '#9ec7fa';
          touch(true);
          renderInspector();
        },
        () => {
          delete solid.color;
          touch(true);
          renderInspector();
        },
        () => [
          colorInput(solid.color ?? '#9ec7fa', (next) => {
            solid.color = next;
            touch(false);
          }),
        ],
      ),
      fieldBlock(
        'style',
        selectInput(
          [
            { value: '', label: 'deck (dark mass)' },
            { value: 'building', label: 'building (lit city)' },
          ],
          solid.style === 'building' ? 'building' : '',
          (value) => {
            if (value === 'building') solid.style = 'building';
            else delete solid.style;
            touch(true);
          },
        ),
      ),
    );
  }

  function renderPadFields(pad: CoursePad): void {
    inspector.append(
      fieldBlock(
        'kind',
        selectInput(
          [
            { value: 'boost', label: 'boost (throws you)' },
            { value: 'jump', label: 'jump (launches you)' },
          ],
          pad.kind,
          (value) => {
            changePadKind(pad, value as PadKind);
            renderInspector();
            renderElements();
          },
        ),
      ),
    );
    if (pad.kind === 'boost') {
      const direction = pad.direction ?? [0, 1];
      inspector.append(
        fieldBlock(
          'direction x, z — normalised on save',
          numberInput(direction[0], 0.1, (value) => {
            direction[0] = value;
            touch(false);
          }),
          numberInput(direction[1], 0.1, (value) => {
            direction[1] = value;
            touch(false);
          }),
        ),
      );
    } else {
      inspector.append(el('div', 'ed-note', 'Jump pads fire a grounded racer straight up.'));
    }
  }

  function renderDecorFields(piece: CourseDecor): void {
    inspector.append(
      fieldBlock(
        'kind',
        selectInput(
          DECOR_KINDS_ADDABLE.map((kind) => ({ value: kind, label: kind })),
          piece.kind,
          (value) => {
            changeDecorKind(piece, value as DecorKind);
            renderInspector();
            renderElements();
          },
        ),
      ),
      optionalField(
        'rotationY °',
        piece.rotationY !== undefined,
        () => {
          piece.rotationY = 0;
          touch(true);
          renderInspector();
        },
        () => {
          delete piece.rotationY;
          touch(true);
          renderInspector();
        },
        () => [
          numberInput(piece.rotationY ?? 0, 5, (value) => {
            piece.rotationY = value;
            touch(false);
            updateHighlight();
          }),
        ],
      ),
      optionalField(
        'colour — accent',
        piece.color !== undefined,
        () => {
          piece.color = '#4eabe8';
          touch(true);
          renderInspector();
        },
        () => {
          delete piece.color;
          touch(true);
          renderInspector();
        },
        () => {
          return [
            colorInput(piece.color ?? '#4eabe8', (next) => {
              piece.color = next;
              touch(false);
            }),
          ];
        },
      ),
    );

    if (piece.kind === 'billboard') {
      inspector.append(
        fieldBlock(
          'text — max 24',
          textInput(piece.text ?? '', (value) => {
            piece.text = value.slice(0, 24);
            touch(false);
          }),
        ),
      );
    }
    if (piece.kind === 'traffic') {
      inspector.append(
        fieldBlock(
          'cars 1–200',
          numberInput(piece.count ?? 20, 1, (value) => {
            piece.count = Math.min(200, Math.max(1, value));
            touch(false);
          }),
        ),
      );
    }
    if (piece.kind === 'cable' && piece.to) {
      inspector.append(
        vec3Row('to — the far end', piece.to, 0.5, () => {
          touch(false);
          updateHighlight();
        }),
      );
    }
    if (piece.kind === 'tower') {
      inspector.append(
        fieldBlock(
          'cap',
          selectInput(
            [
              { value: '', label: 'none' },
              { value: 'spire', label: 'spire' },
              { value: 'stepped', label: 'stepped' },
            ],
            piece.cap ?? '',
            (value) => {
              if (value === 'spire' || value === 'stepped') {
                piece.cap = value;
                if (piece.capHeight === undefined) piece.capHeight = 6;
              } else {
                delete piece.cap;
                delete piece.capHeight;
              }
              touch(true);
              renderInspector();
            },
          ),
        ),
      );
      if (piece.cap) {
        inspector.append(
          fieldBlock(
            'capHeight',
            numberInput(piece.capHeight ?? 6, 1, (value) => {
              piece.capHeight = value;
              touch(false);
            }),
          ),
        );
      }
    }
  }

  // --- header / hint ------------------------------------------------------

  function renderHeader(): void {
    fileLabel.textContent = safeFileName(course.id);
    counts.textContent = `${course.solids.length} solids · ${course.pads.length} pads · ${course.decor.length} decor`;
  }

  const hint = el(
    'footer',
    'ed-hint',
    'drag orbit · right-drag pan · wheel zoom · click select · arrows nudge (⇧ fine) · ' +
      'E/Q up/down · Del remove · Ctrl+S save · no undo — reopen the file to revert',
  );

  panel.append(head, statusLine, fileRow, courseFields, tabsRow, addRow, listEl, inspector, hint);

  // --- frame loop ---------------------------------------------------------

  const loop = startFrameLoop(({ delta }) => {
    try {
      if (rebuildNow || (rebuildAt !== 0 && performance.now() >= rebuildAt)) rebuild();
      applyCamera();
      handle?.update(delta);
      stage.render();
    } catch (err) {
      // The loop re-arms before it calls us, so one bad frame costs a
      // console line, not the session.
      console.error('TEKK editor frame error:', err);
    }
  });

  globalThis.addEventListener('beforeunload', (event) => {
    if (!edited) return;
    event.preventDefault();
    event.returnValue = '';
  });

  globalThis.addEventListener('beforeunload', () => {
    loop.stop();
    handle?.dispose();
  });

  // Live course access from the console, mirroring the game's TEKK hook.
  Object.assign(globalThis, {
    TEKK_EDITOR: {
      get course(): Course {
        return course;
      },
      get selection(): Sel | null {
        return sel;
      },
    },
  });

  // --- first document -----------------------------------------------------

  const firstPath =
    Object.keys(bundled).find((path) => baseName(path) === 'takk-arena') ??
    Object.keys(bundled)[0];
  if (firstPath !== undefined) {
    try {
      adopt(parseCourse(structuredClone(bundled[firstPath]), baseName(firstPath)));
    } catch (err) {
      adopt(templateCourse());
      status(`bundled course failed to parse: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  } else {
    adopt(templateCourse());
  }

  console.info(
    `TEKK — course editor on "${course.id}" (${course.solids.length} solids) — ` +
      'no server connected: Save downloads the JSON, drop it in src/courses/ and restart the server',
  );
}
