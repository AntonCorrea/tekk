/**
 * Wardrobe Showcase — a standalone fullscreen view that renders a grid of
 * spinning avatars, one per cosmetic in each category (trails, colours, hats,
 * gears). Item avatars wear the stock grey body so the cosmetic reads. No
 * server, no HUD, no input — just the catalogue on display.
 *
 * Reached via `?showcase=1` (or `?showcase`).
 */

import * as THREE from 'three/webgpu';
import { createCharacter, type Character } from '../render/character.ts';
import {
  TRAILS,
  DEFAULT_TRAIL,
  isTrail,
} from '../shared/cosmetics.ts';
import {
  BODY_COLORS,
  isBodyColor,
} from '../shared/cosmetics.ts';
import {
  HATS,
  isHat,
} from '../shared/cosmetics.ts';
import {
  GEARS,
  isGear,
} from '../shared/cosmetics.ts';
import { CAMERA, PLAYER } from '../constants.ts';
import { PALETTE, POST, ATMOS } from '../render/palette.ts';
import { buildFarField } from '../render/skyline.ts';
import { createPostChain, type PostChain } from '../render/post.ts';

/**
 * Every non-colour avatar wears the stock grey body (`body-stock` in the
 * catalog) so trails, hats and gear read as the item, not as body paint.
 */
const STOCK_BODY = 0x888888;

/** One spinning dummy in the grid. */
interface Dummy {
  character: Character;
  root: THREE.Object3D;
  yaw: number;
}

/** A row of dummies sharing a category label. */
interface Row {
  label: string;
  dummies: Dummy[];
  /** World-space centre of the row (x, z). */
  centreX: number;
  centreZ: number;
}

/** Build a showcase stage: renderer, scene, camera, post chain. */
async function createShowcaseStage(
  container: HTMLElement,
): Promise<{
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  post: PostChain;
  renderer: THREE.WebGPURenderer;
  canvas: HTMLCanvasElement;
  dispose: () => void;
}> {
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio, 2));
  renderer.setSize(globalThis.innerWidth, globalThis.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = POST.exposure;
  await renderer.init();

  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.base);

  const fog = new THREE.FogExp2(PALETTE.base, ATMOS.fogDensity * 0.35);
  scene.fog = fog;

  const camera = new THREE.PerspectiveCamera(
    80, // wider than the game's 72° to fit the full grid
    globalThis.innerWidth / globalThis.innerHeight,
    CAMERA.near,
    CAMERA.far,
  );
  // Further back and slightly higher to frame all 4 rows (z = 7..-5) and the
  // widest row (trails: 5 items × 3.6 = 18 units wide).
  camera.position.set(0, 7, 26);
  camera.lookAt(0, 1.2, 1);

  const farField = buildFarField();
  scene.add(farField.group);

  const post = createPostChain(renderer, scene, camera);

  const onResize = (): void => {
    const w = globalThis.innerWidth;
    const h = globalThis.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  globalThis.addEventListener('resize', onResize);

  const dispose = (): void => {
    globalThis.removeEventListener('resize', onResize);
    scene.remove(farField.group);
    farField.dispose();
    post.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };

  return { scene, camera, post, renderer, canvas: renderer.domElement, dispose };
}

/** Create one dummy character at world position (x, 0, z). */
function createDummy(
  scene: THREE.Scene,
  identityHex: number,
  x: number,
  z: number,
): Dummy {
  const character = createCharacter(scene, identityHex, DEFAULT_TRAIL);
  const root = character.root;
  root.position.set(x, 0, z);
  scene.add(root);
  return {
    character,
    root,
    yaw: 0,
  };
}

/** Build all rows from the catalogs. */
function buildRows(scene: THREE.Scene): Row[] {
  const rows: Row[] = [];

  // --- Trails row ---
  const trailEntries = Object.entries(TRAILS).filter(([id]) => isTrail(id));
  const trailDummies: Dummy[] = [];
  const trailSpacing = 3.6;
  const trailStartX = -((trailEntries.length - 1) * trailSpacing) / 2;
  for (let i = 0; i < trailEntries.length; i++) {
    const [id] = trailEntries[i]!;
    const x = trailStartX + i * trailSpacing;
    const dummy = createDummy(scene, STOCK_BODY, x, 7);
    dummy.character.setTrail(id);
    trailDummies.push(dummy);
  }
  rows.push({ label: 'Trails', dummies: trailDummies, centreX: 0, centreZ: 7 });

  // --- Body Colours row ---
  const colorEntries = Object.entries(BODY_COLORS).filter(([id]) => isBodyColor(id));
  const colorDummies: Dummy[] = [];
  const colorSpacing = 3.6;
  const colorStartX = -((colorEntries.length - 1) * colorSpacing) / 2;
  for (let i = 0; i < colorEntries.length; i++) {
    const [, def] = colorEntries[i]!;
    const x = colorStartX + i * colorSpacing;
    const identityHex = def.color ?? 0x888888;
    const dummy = createDummy(scene, identityHex, x, 3);
    dummy.character.tint.setHex(identityHex);
    colorDummies.push(dummy);
  }
  rows.push({ label: 'Body Colours', dummies: colorDummies, centreX: 0, centreZ: 3 });

  // --- Hats row ---
  const hatEntries = Object.entries(HATS).filter(([id]) => isHat(id));
  const hatDummies: Dummy[] = [];
  const hatSpacing = 3.6;
  const hatStartX = -((hatEntries.length - 1) * hatSpacing) / 2;
  for (let i = 0; i < hatEntries.length; i++) {
    const [id] = hatEntries[i]!;
    const x = hatStartX + i * hatSpacing;
    const dummy = createDummy(scene, STOCK_BODY, x, -1);
    dummy.character.setHat(id);
    hatDummies.push(dummy);
  }
  rows.push({ label: 'Hats', dummies: hatDummies, centreX: 0, centreZ: -1 });

  // --- Gears row ---
  const gearEntries = Object.entries(GEARS).filter(([id]) => isGear(id));
  const gearDummies: Dummy[] = [];
  const gearSpacing = 4.0;
  const gearStartX = -((gearEntries.length - 1) * gearSpacing) / 2;
  for (let i = 0; i < gearEntries.length; i++) {
    const [id] = gearEntries[i]!;
    const x = gearStartX + i * gearSpacing;
    const dummy = createDummy(scene, STOCK_BODY, x, -5);
    dummy.character.setGear(id);
    gearDummies.push(dummy);
  }
  rows.push({ label: 'Gear', dummies: gearDummies, centreX: 0, centreZ: -5 });

  return rows;
}

/** Draw category labels in HTML overlay. */
function createLabelOverlay(rows: Row[]): HTMLElement {
  const overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.pointerEvents = 'none';
  overlay.style.fontFamily = 'var(--grotesk), system-ui, sans-serif';
  overlay.style.color = '#fff';
  overlay.style.textAlign = 'center';
  overlay.style.zIndex = '100';

  // Title
  const title = document.createElement('div');
  title.textContent = 'Wardrobe Showcase';
  title.style.fontSize = 'clamp(18px, 3vw, 28px)';
  title.style.fontWeight = '600';
  title.style.letterSpacing = '0.18em';
  title.style.textTransform = 'uppercase';
  title.style.marginTop = '24px';
  title.style.textShadow = '0 0 16px #000';
  overlay.appendChild(title);

  // Row labels (positioned in screen space — we'll update per frame)
  const rowLabels: HTMLElement[] = [];
  for (const row of rows) {
    const label = document.createElement('div');
    label.textContent = row.label;
    label.style.position = 'absolute';
    label.style.fontSize = '12px';
    label.style.fontWeight = '500';
    label.style.letterSpacing = '0.14em';
    label.style.textTransform = 'uppercase';
    label.style.color = 'var(--ink-dim)';
    label.style.textShadow = '0 0 8px #000';
    label.style.whiteSpace = 'nowrap';
    overlay.appendChild(label);
    rowLabels.push(label);
  }

  // Footer hint
  const hint = document.createElement('div');
  hint.textContent = 'Auto-rotating • Close tab to return';
  hint.style.fontSize = '10px';
  hint.style.fontWeight = '500';
  hint.style.letterSpacing = '0.18em';
  hint.style.textTransform = 'uppercase';
  hint.style.color = 'var(--ink-faint)';
  hint.style.position = 'fixed';
  hint.style.bottom = '24px';
  hint.style.left = '50%';
  hint.style.transform = 'translateX(-50%)';
  overlay.appendChild(hint);

  // Store refs for per-frame projection
  (overlay as any).__rowLabels = rowLabels;
  (overlay as any).__rows = rows;

  return overlay;
}

/** Project a world point to screen coordinates. */
function worldToScreen(
  vec: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
): { x: number; y: number } {
  const v = vec.clone().project(camera);
  return {
    x: (v.x * 0.5 + 0.5) * width,
    y: (-v.y * 0.5 + 0.5) * height,
  };
}

/** Main showcase entry point. */
export async function bootShowcase(container: HTMLElement): Promise<void> {
  const { scene, camera, post, canvas, dispose } = await createShowcaseStage(
    container,
  );

  const rows = buildRows(scene);
  const overlay = createLabelOverlay(rows);
  document.body.appendChild(overlay);

  // --- camera rig (orbit/pan/zoom, same as editor) --------------------------
  const rig = { target: new THREE.Vector3(0, 1.2, 1), yaw: 0.9, pitch: 0.45, dist: 26 };

  function applyCamera(): void {
    const cosPitch = Math.cos(rig.pitch);
    camera.position.set(
      rig.target.x + Math.sin(rig.yaw) * cosPitch * rig.dist,
      rig.target.y + Math.sin(rig.pitch) * rig.dist,
      rig.target.z + Math.cos(rig.yaw) * cosPitch * rig.dist,
    );
    camera.lookAt(rig.target);
  }
  applyCamera(); // initial placement

  let dragButton = -1;
  let moved = 0;

  canvas.style.cursor = 'grab';
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  canvas.addEventListener('pointerdown', (event) => {
    dragButton = event.button;
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
      // Left drag: orbit
      rig.yaw -= dx * 0.005;
      rig.pitch = Math.min(1.45, Math.max(-1.45, rig.pitch + dy * 0.005));
    } else {
      // Right/middle drag: pan target
      const k = rig.dist * 0.0016;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
      rig.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    }
    applyCamera();
  });

  canvas.addEventListener('pointerup', () => {
    if (dragButton < 0) return;
    dragButton = -1;
    canvas.style.cursor = 'grab';
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
      applyCamera();
    },
    { passive: false },
  );

  let lastTime = performance.now();

  function frame(): void {
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 1 / 30);
    lastTime = now;

    // Auto-rotate each dummy slowly (0.15 rad/s ≈ 8.6°/s)
    const spinSpeed = 0.15;
    for (const row of rows) {
      for (const dummy of row.dummies) {
        dummy.yaw += spinSpeed * dt;
        // Pass the dummy's world position so character.update() places it correctly.
        // After update(), re-apply our yaw (the character aligns root.rotation.y to
        // `facing` derived from velocity; with speed=0 it would otherwise snap to 0).
        const state = {
          x: dummy.root.position.x,
          // The character expects state.y = capsule center height (feet at 0 → center at halfHeight+radius = 0.9).
          // We set the dummy's root.position.y to 0, so pass 0.9 here.
          y: PLAYER.halfHeight + PLAYER.radius,
          z: dummy.root.position.z,
          vx: 0,
          vz: 0,
          speed: 0,
          grounded: true,
          dashing: false,
          carrying: false,
        };
        dummy.character.update(state, dt);
        dummy.root.rotation.y = dummy.yaw;
      }
    }

    // Update row label positions (project row centres to screen)
    const w = globalThis.innerWidth;
    const h = globalThis.innerHeight;
    const rowLabels = (overlay as any).__rowLabels as HTMLElement[];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const label = rowLabels[i]!;
      const screen = worldToScreen(
        new THREE.Vector3(row.centreX, 2.2, row.centreZ),
        camera,
        w,
        h,
      );
      label.style.left = `${screen.x}px`;
      label.style.top = `${screen.y}px`;
      label.style.transform = 'translate(-50%, -50%)';
    }

    post.pipeline.render();
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);

  // Cleanup on unload (not strictly needed for a tab-close page, but tidy)
  globalThis.addEventListener('beforeunload', () => {
    for (const row of rows) {
      for (const dummy of row.dummies) {
        dummy.character.dispose();
        scene.remove(dummy.root);
      }
    }
    overlay.remove();
    dispose();
  });
}