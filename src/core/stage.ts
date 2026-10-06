/**
 * Stage — renderer, scene, atmosphere and the render pipeline.
 *
 * Owns everything WebGPU-related. Nothing else in the codebase should import
 * from 'three/webgpu'; use the objects handed back here instead.
 */

import * as THREE from 'three/webgpu';
import { CAMERA } from '../constants.ts';
import { ATMOS, PALETTE, POST } from '../render/palette.ts';
import { buildFarField, type FarField } from '../render/skyline.ts';
import { createPostChain, type PostChain } from '../render/post.ts';

export interface Stage {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  render(): void;
  dispose(): void;
}

export async function createStage(container: HTMLElement): Promise<Stage> {
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio, 2));
  renderer.setSize(globalThis.innerWidth, globalThis.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // Slightly above 1. The scene is lit almost entirely by emissive and rim
  // light, so it lands much darker than a daylight-lit one and wants the lift.
  // Grouped with the other post weights so the whole image grade is one file.
  renderer.toneMappingExposure = POST.exposure;

  // WebGPU needs an explicit init before the first frame. This also
  // negotiates the WebGL2 fallback when WebGPU is unavailable.
  await renderer.init();

  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.base);

  // Exponential-squared fog, in the exact background colour.
  //
  // This is doing more work than it looks like. A scene with a near-black sky,
  // dark geometry and no visible sun has nothing to establish depth except
  // aerial perspective, and without it everything sits at the same apparent
  // distance and the lane reads as a couple of boxes rather than as a
  // kilometre. Fog is what makes the architecture monumental.
  scene.fog = new THREE.FogExp2(PALETTE.base, ATMOS.fogDensity);

  const camera = new THREE.PerspectiveCamera(
    CAMERA.fov,
    globalThis.innerWidth / globalThis.innerHeight,
    CAMERA.near,
    CAMERA.far,
  );
  // Placeholder only. The camera rig in render/scene.ts sets the real position
  // on its first sync, before anything is drawn, so this is never visible --
  // it just avoids a camera at the origin for the frame between construction and
  // the first sync.
  camera.position.set(0, CAMERA.height, CAMERA.distance);

  // --- ground grid ---------------------------------------------------------
  // A subtle technical grid, drawn as a texture rather than geometry. Line
  // geometry aliases badly at this scale -- a grid made of `LineSegments` crawls
  // and shimmers as the camera moves, which is exactly the effect a technical
  // grid is supposed to avoid.
  const gridTexture = buildGridTexture();
  const gridGeometry = new THREE.PlaneGeometry(ATMOS.gridExtent, ATMOS.gridExtent);
  const gridMaterial = new THREE.MeshBasicMaterial({
    map: gridTexture,
    transparent: true,
    depthWrite: false,
    // Left out of tone mapping on purpose. ACES compresses near-black hard, and
    // a grid authored just above black would be crushed to nothing by the time
    // it reached the screen. Fog still applies, so it still fades with distance.
    toneMapped: false,
  });
  const grid = new THREE.Mesh(gridGeometry, gridMaterial);
  grid.rotation.x = -Math.PI / 2;
  grid.position.y = ATMOS.gridY;
  scene.add(grid);

  // --- far field ------------------------------------------------------------
  // Towers on the horizon plus the stacked slabs beside the lane, added before
  // the post chain is built so the first pass already captures them. Set
  // dressing only — see render/skyline.ts for why the slabs are placed where
  // they are.
  const farField: FarField = buildFarField();
  scene.add(farField.group);

  // --- post-processing -----------------------------------------------------
  // Built after the scene exists, because the first pass captures it.
  const post: PostChain = createPostChain(renderer, scene, camera);

  const onResize = () => {
    const w = globalThis.innerWidth;
    const h = globalThis.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    // The post chain samples the framebuffer size for its aspect-corrected
    // vignette, so it needs no explicit resize -- but the pass node's render
    // target does, and that is driven by the renderer.
  };
  globalThis.addEventListener('resize', onResize);

  return {
    renderer,
    scene,
    camera,
    render: () => post.pipeline.render(),
    dispose: () => {
      globalThis.removeEventListener('resize', onResize);
      scene.remove(grid);
      gridGeometry.dispose();
      gridMaterial.dispose();
      gridTexture.dispose();
      scene.remove(farField.group);
      farField.dispose();
      post.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/**
 * A canvas-drawn grid tile, tiled across the ground plane.
 *
 * One tile is drawn once and repeated. The tile is deliberately almost entirely
 * transparent with a single hairline border, so the grid reads as ruled lines
 * on a dark surface rather than as a lit floor.
 */
function buildGridTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, size, size);
    ctx.strokeStyle = `#${PALETTE.grid.toString(16).padStart(6, '0')}`;
    ctx.lineWidth = 1;
    // Half-pixel inset so the stroke lands on one pixel column rather than
    // straddling two, which is what makes a 1px line look like a 2px smear.
    ctx.strokeRect(0.5, 0.5, size - 1, size - 1);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // Derived rather than configured, so the line spacing on screen is
  // `ATMOS.gridTile` world units no matter how the plane is resized.
  const repeats = Math.round(ATMOS.gridExtent / ATMOS.gridTile);
  texture.repeat.set(repeats, repeats);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  return texture;
}