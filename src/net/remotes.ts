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
import { NEON, RACER_IDENTITY } from '../render/palette.ts';
import { createCharacter, type Character, type CharacterState } from '../render/character.ts';
import type { PlayerStateInstance } from '../shared/state.ts';
import type { Session } from './session.ts';

/**
 * Each racer gets a distinct hue so people stay tellable apart.
 *
 * The saturated racer set from render/palette.ts, minus its first entry, which
 * is the local racer's own colour -- so nobody else ever looks like you.
 */
const IDENTITY = RACER_IDENTITY.slice(1);


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

export interface RacerVisuals {
  /**
   * Interpolate every remote racer onto its smoothed position and animate it.
   * `delta` is the real frame delta in seconds.
   */
  sync(delta: number): void;

  /**
   * Hide or show every remote racer at once. The ready lobby shows nobody, so
   * the ballot is about the map, not the racers standing on it. Racers joined
   * while hidden join already hidden and reappear in place.
   */
  setVisible(visible: boolean): void;

  dispose(): void;
}

interface Racer {
  /** The shared mannequin from render/character.ts. */
  character: Character;
  label: THREE.Sprite;
  /** Identity hue the tint returns to when not carrying or airborne. */
  color: THREE.Color;
}

/** Reused per racer per frame, so `sync` allocates nothing. */
const characterState: CharacterState = {
  x: 0, y: 0, z: 0, vx: 0, vz: 0, speed: 0, grounded: true, dashing: false, carrying: false,
};

export function createRacerVisuals(scene: THREE.Scene, session: Session): RacerVisuals {
  const racers = new Map<string, Racer>();
  let racersVisible = true;

  const applyVisibility = (racer: Racer, visible: boolean): void => {
    racer.character.setVisible(visible);
    racer.label.visible = visible;
  };

  const add = (id: string, name: string) => {
    const identity = new THREE.Color(IDENTITY[racers.size % IDENTITY.length]!);

    const character = createCharacter(scene, identity);

    const label = makeLabel(name, identity);
    scene.add(label);

    const racer: Racer = { character, label, color: identity };
    racers.set(id, racer);
    return racer;
  };

  const remove = (id: string) => {
    const racer = racers.get(id);
    if (!racer) return;
    scene.remove(racer.label);
    racer.character.dispose();
    (racer.label.material as THREE.Material).dispose();
    racers.delete(id);
  };

  return {
    sync(delta) {
      const selfId = session.sessionId;

      // Drop racers that left.
      for (const id of [...racers.keys()]) {
        if (!session.room.state.players.has(id)) remove(id);
      }

      session.room.state.players.forEach((player: PlayerStateInstance, id: string) => {
        if (id === selfId) return;

        let racer = racers.get(id);
        if (!racer) racer = add(id, player.name);

        // The lobby shows no racers: anyone who joined while hidden stays
        // hidden in place, and the label goes with them. The frame after the
        // lobby ends, `setVisible(true)` brings them all back.
        if (!racersVisible) {
          applyVisibility(racer, false);
          return;
        }

        // The smoothed read. Falls back to raw authority before the first
        // interpolation sample arrives, so a racer never pops in at the origin.
        const p = session.positionOf(player);
        const carrying = id === session.room.state.carrierId;

        // Velocity, speed and grounded come straight from the replicated state,
        // which runs ~100ms ahead of the interpolated position. For facing and
        // the run cycle that lead is invisible; for position it would not be.
        characterState.x = p.x;
        characterState.y = p.y;
        characterState.z = p.z;
        characterState.vx = player.vx;
        characterState.vz = player.vz;
        characterState.speed = player.speed;
        characterState.grounded = player.grounded;
        characterState.dashing = player.dashTicks > 0;
        characterState.carrying = carrying;
        racer.character.update(characterState, delta);

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
        tintScratch.copy(carrying ? CARRIER : racer.color);
        racer.character.tint.lerp(tintScratch, 0.2);

        const glowTarget = carrying ? GLOW_CARRIER : player.dashTicks > 0 ? GLOW_DASH : GLOW_BASE;
        racer.character.glow += (glowTarget - racer.character.glow) * 0.3;

        // The Core's holder keeps the label on during results too, so the final
        // screen still says who is who.
        racer.label.visible = true;
      });
    },

    setVisible(visible) {
      racersVisible = visible;
      for (const racer of racers.values()) applyVisibility(racer, visible);
    },

    dispose() {
      for (const id of [...racers.keys()]) remove(id);
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