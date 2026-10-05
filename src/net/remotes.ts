/**
 * Remote racer visuals
 *
 * Draws the other people in the room from interpolated server state. These are
 * never simulated locally — they are followers, exactly like the meshes in
 * render/scene.ts. The one difference is the source: they read
 * `predict.value()`, which is the smoothed stream, not raw authority.
 */

import * as THREE from 'three/webgpu';

import { PLAYER } from '../constants.ts';
import type { PlayerStateInstance } from '../shared/state.ts';
import type { Session } from './session.ts';

/** Airborne tint, matching the local player's cue in render/scene.ts. */
const REMOTE_AIRBORNE = 0xffd479;

/** Each racer gets a distinct hue so four people stay tellable apart. */
const PALETTE = [0x4da3ff, 0xff7b4d, 0xb46dff, 0x4dffb0, 0xffd400, 0xff4d94];

export interface RacerVisuals {
  /** Interpolate every remote racer onto its smoothed position. */
  sync(): void;
  dispose(): void;
}

interface Racer {
  capsule: THREE.Mesh;
  label: THREE.Sprite;
  color: THREE.Color;
  material: THREE.MeshStandardMaterial;
}

export function createRacerVisuals(scene: THREE.Scene, session: Session): RacerVisuals {
  const racers = new Map<string, Racer>();
  const capsuleGeometry = new THREE.CapsuleGeometry(
    PLAYER.radius,
    PLAYER.halfHeight * 2,
    8,
    16,
  );

  const add = (id: string, name: string) => {
    const color = new THREE.Color(PALETTE[racers.size % PALETTE.length]!);

    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
    const capsule = new THREE.Mesh(capsuleGeometry, material);
    scene.add(capsule);

    const label = makeLabel(name, color);
    scene.add(label);

    const racer: Racer = { capsule, label, color, material };
    racers.set(id, racer);
    return racer;
  };

  const remove = (id: string) => {
    const racer = racers.get(id);
    if (!racer) return;
    scene.remove(racer.capsule, racer.label);
    racer.material.dispose();
    (racer.label.material as THREE.Material).dispose();
    racers.delete(id);
  };

  return {
    sync() {
      const selfId = session.sessionId;

      // Drop racers that left.
      for (const id of [...racers.keys()]) {
        if (!session.room.state.players.has(id)) remove(id);
      }

      session.room.state.players.forEach((player: PlayerStateInstance, id: string) => {
        if (id === selfId) return;

        let racer = racers.get(id);
        if (!racer) racer = add(id, player.name);

        // The smoothed read. Falls back to raw authority before the first
        // interpolation sample arrives, so a racer never pops in at the origin.
        const p = session.positionOf(player);
        racer.capsule.position.set(p.x, p.y, p.z);

        // Label floats above the head and always faces the camera.
        racer.label.position.set(p.x, p.y + PLAYER.height * 0.85, p.z);

        // Airborne racers read brighter, matching the local player's cue.
        const target = player.grounded ? racer.color : new THREE.Color(REMOTE_AIRBORNE);
        racer.material.color.lerp(target, 0.2);

        // Hide finished racers' labels to reduce clutter on the results screen.
        racer.label.visible = player.finishedMs < 0;
      });
    },

    dispose() {
      for (const id of [...racers.keys()]) remove(id);
      capsuleGeometry.dispose();
    },
  };
}

/**
 * A canvas-textured sprite showing a racer's name.
 *
 * Sprites rather than DOM overlays: the racers move every frame, and keeping
 * their labels in the 3D scene means one projection path instead of two.
 */
function makeLabel(name: string, color: THREE.Color): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;

  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.font = 'bold 34px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = `#${color.getHexString()}`;
    ctx.fillText(name.slice(0, 12), canvas.width / 2, canvas.height / 2 + 1);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
  );
  sprite.scale.set(2.4, 0.6, 1);
  // Labels draw over geometry so a racer behind a rail is still identifiable.
  sprite.renderOrder = 10;

  return sprite;
}