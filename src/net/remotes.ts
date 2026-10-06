/**
 * Remote racer visuals
 *
 * Draws the other people in the room from interpolated server state. These are
 * never simulated locally — they are followers, exactly like the meshes in
 * render/scene.ts. The one difference is the source: they read
 * `predict.value()`, which is the smoothed stream, not raw authority.
 */

import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  clamp,
  color,
  dot,
  mix,
  mul,
  normalize,
  normalWorld,
  oneMinus,
  pow,
  positionWorld,
  saturate,
  sub,
  uniform,
} from 'three/tsl';

import { PLAYER } from '../constants.ts';
import { NEON, PALETTE, POST } from '../render/palette.ts';
import type { PlayerStateInstance } from '../shared/state.ts';
import type { Session } from './session.ts';

/**
 * Each racer gets a distinct hue so four people stay tellable apart.
 *
 * Drawn from the same ramp as everything else rather than the previous six
 * arbitrary brights. A remote racer's identity is carried entirely by this
 * colour, so the ramp is spaced far enough apart to stay readable at a glance
 * while the racer is moving.
 */
const IDENTITY = [NEON.cyan, NEON.magenta, NEON.blue, NEON.violet, NEON.amber];

/** Airborne tint, matching the local player's cue in render/scene.ts. */
const AIRBORNE = new THREE.Color(NEON.amber);

/**
 * The carrier's tint: the ramp's white, which no identity colour uses, so the
 * Core holder is the one hot-white silhouette in the arena regardless of whose
 * hue they are. Matches the local player's carrier cue in render/scene.ts.
 */
const CARRIER = new THREE.Color(NEON.white);

/** Rim gain multipliers. Above 1 so bloom picks them up; carrier outranks dash. */
const GLOW_BASE = 1;
const GLOW_DASH = 1.9;
const GLOW_CARRIER = 2.4;

/**
 * Scratch colour for the per-frame airborne lerp.
 *
 * Module-level rather than allocated inside `sync`: `sync` runs once per rendered
 * frame per racer, and a fresh Color per racer per frame is exactly the kind of
 * churn the render loop should not have.
 */
const tintScratch = new THREE.Color();

/**
 * The node produced by a colour uniform.
 *
 * Spelled out explicitly rather than as `ReturnType<typeof uniform>`: that bare
 * `ReturnType` erases the generics to `unknown`, and the vector constructors then
 * refuse the value. Note the first type parameter is the *node* type and the
 * second is the *value* type, which is the opposite of what the name suggests.
 * Annotating a TSL node too loosely is the same bug twice in this project.
 */
type ColorUniform = THREE.UniformNode<'color', THREE.Color>;
type FloatUniform = THREE.UniformNode<'float', number>;

/**
 * The emissive fresnel rim shared by every remote racer.
 *
 * Identical construction to the local player's rim in render/scene.ts, minus the
 * tint: the graph is built once here and reused, and only the per-racer colour
 * uniform differs. Building the graph inside the per-racer loop would compile a
 * separate shader variant for each colour, which is the expensive way to get six
 * near-identical materials.
 */
function iridescentRim(tint: ColorUniform, glow: FloatUniform): THREE.Node {
  const viewDir = normalize(sub(cameraPosition, positionWorld));
  const fresnel = pow(oneMinus(saturate(dot(normalize(normalWorld), viewDir))), 2.6);

  const hueLow = mix(color(NEON.magenta), tint, clamp(mul(fresnel, 2), 0, 1));
  const hue = mix(hueLow, color(NEON.cyan), clamp(mul(sub(fresnel, 0.5), 2), 0, 1));
  return mul(hue, mul(fresnel, mul(glow, POST.emissiveGain)));
}

export interface RacerVisuals {
  /** Interpolate every remote racer onto its smoothed position. */
  sync(): void;
  dispose(): void;
}

interface Racer {
  capsule: THREE.Mesh;
  label: THREE.Sprite;
  color: THREE.Color;
  tint: ColorUniform;
  /** Rim gain multiplier: the carrier and dash cues. */
  glow: FloatUniform;
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
    const identity = new THREE.Color(IDENTITY[racers.size % IDENTITY.length]!);

    // Dark body lit by its own rim — the same treatment as the local player, so
    // remote racers read as part of this world rather than as a different kind
    // of object pasted into it.
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE.mass),
      roughness: 0.35,
      metalness: 0.1,
    });
    const tint = uniform(identity.clone());
    const glow = uniform(GLOW_BASE);
    material.emissiveNode = iridescentRim(tint, glow);

    const capsule = new THREE.Mesh(capsuleGeometry, material);
    scene.add(capsule);

    const label = makeLabel(name, identity);
    scene.add(label);

    const racer: Racer = { capsule, label, color: identity, tint, glow, material };
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

        // Airborne racers shift to amber, matching the local player's cue.
        //
        // Lerped on the tint uniform rather than the material's base colour: the
        // body is near-black now, so tinting it would do nothing visible. The
        // hue is the same amber the cue used before the restyle, so it keeps
        // meaning the same thing.
        //
        // The carrier overrides it with white and a much stronger rim: it is the
        // one fact every player needs to read at a glance. A dash is a brief
        // brightening only, so it never competes with the carrier cue.
        const carrying = id === session.room.state.carrierId;
        tintScratch.copy(carrying ? CARRIER : player.grounded ? racer.color : AIRBORNE);
        racer.tint.value.lerp(tintScratch, 0.2);

        const glowTarget = carrying ? GLOW_CARRIER : player.dashTicks > 0 ? GLOW_DASH : GLOW_BASE;
        racer.glow.value += (glowTarget - racer.glow.value) * 0.3;

        // The Core's holder keeps the label on during results too, so the final
        // screen still says who is who.
        racer.label.visible = true;
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
    // No backing plate. The previous version filled the whole sprite with 55%
    // black, which was readable over a bright daytime course and is an opaque
    // smear over a near-black one. The hairline below carries the separation
    // instead.
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // Set before measuring: `measureText` uses the current font, and measuring
    // with the 10px default made every label sit off-centre.
    ctx.font = '500 22px ui-sans-serif, "Helvetica Neue", Helvetica, Arial, sans-serif';

    // Uppercase with manual tracking, because canvas 2D has no letter-spacing in
    // a portable form across browsers and the wide tracking is the whole look.
    const text = name.slice(0, 12).toUpperCase();
    const spacing = 2;
    let width = 0;
    for (const ch of text) width += ctx.measureText(ch).width + spacing;
    width -= spacing;

    let x = (canvas.width - width) / 2;
    for (const ch of text) {
      ctx.fillStyle = `#${color.getHexString()}`;
      ctx.fillText(ch, x, 34);
      x += ctx.measureText(ch).width + spacing;
    }

    ctx.fillStyle = `#${color.getHexString()}`;
    ctx.globalAlpha = 0.4;
    ctx.fillRect((canvas.width - width) / 2, 42, width, 1);
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