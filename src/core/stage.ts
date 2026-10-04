/**
 * Stage — renderer, scene and camera
 *
 * Owns everything WebGPU-related. Nothing else in the codebase should
 * import from 'three/webgpu'; use the objects handed back here instead.
 */

import * as THREE from 'three/webgpu';
import { CAMERA } from '../constants.ts';

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
  renderer.toneMappingExposure = 1.0;

  // WebGPU needs an explicit init before the first frame. This also
  // negotiates the WebGL2 fallback when WebGPU is unavailable.
  await renderer.init();

  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fc7ec);

  const camera = new THREE.PerspectiveCamera(
    CAMERA.fov,
    globalThis.innerWidth / globalThis.innerHeight,
    CAMERA.near,
    CAMERA.far,
  );
  camera.position.set(0, CAMERA.height, CAMERA.distance);

  const onResize = () => {
    const w = globalThis.innerWidth;
    const h = globalThis.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  globalThis.addEventListener('resize', onResize);

  return {
    renderer,
    scene,
    camera,
    render: () => renderer.render(scene, camera),
    dispose: () => {
      globalThis.removeEventListener('resize', onResize);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}