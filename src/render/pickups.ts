/**
 * Cosmetic pickup rendering
 *
 * One bobbing ball, a soft glow halo and a name label per untaken pickup: a
 * faceted sphere in the item's own colour (`itemColor`), haloed with the same
 * colour so it reads as findable treasure rather than parked geometry, with
 * its display name floating above. The halo is the Core's glow idiom (a
 * camera-facing additive sprite that clears the bloom threshold) minus the
 * shader: one white radial-gradient canvas tinted per item, breathing gently
 * on a per-ball phase.
 *
 * The layer is driven entirely by the REPLICATED pickup state, not the course
 * file — the server owns where the balls are, and a map swap refills the list,
 * which this layer sees as a rebuild.
 *
 * Taken balls vanish: the layer only creates nodes for untaken pickups, and a
 * rebuild the moment a ball flips is how "you got it" reads in the world. The
 * unlock toast that announces it is main.ts's job; the spark burst in the
 * item's colour, popped at the ball's last position as it vanishes, is this
 * layer's — so the flip reads as a collection, not a despawn.
 *
 * The canvas label is the same sprite technique the racer labels use
 * (`net/remotes.ts` `drawLabel`), duplicated here because that helper is
 * module-private and a pickup label is one static colour that never repaints.
 */

import * as THREE from 'three/webgpu';
import { isAcquirableItem, itemColor, itemName } from '../shared/cosmetics.ts';
import type { PickupStateInstance } from '../shared/state.ts';

/** The rendered ball's radius. Deliberately smaller than the capture radius. */
const BALL_RADIUS = 0.3;
/** The label sprite floats this far above the ball's bob centre. */
const LABEL_GAP = 0.75;
/** Bob and spin, so a ball reads as a thing to grab rather than parked geometry. */
const BOB = { amp: 0.12, freq: 1.6 } as const;
const SPIN = 1.4;
/** Glow halo sprite scale (world units): a soft disc ~2.5x the ball radius. */
const GLOW_SCALE = 1.5;
/** Halo brightness boost, so the item colour clears the bloom threshold. */
const GLOW_GAIN = 1.25;
/** Halo breathing rate (rad/s): a slow swell, not a hard flicker. */
const GLOW_PULSE = 2.2;
/**
 * Collection burst: a small spray of additive glow sprites in the item colour
 * (the same radial texture as the halo), popped at the ball's last position
 * the moment it flips to taken. Sized like a glowing dot on screen, not a
 * sub-pixel sphere — the first version's 0.07 m meshes were invisible.
 */
const BURST = {
  count: 18, // sparks per collection
  life: 0.7, // seconds to live
  speedMin: 2, // launch speed range (m/s)…
  speedMax: 5,
  up: 1.5, // upward bias, so the spray pops off the ball instead of collapsing into it
  gravity: 6, // downward pull (m/s²)
  spark: 0.45, // glow-sprite half-extent (m), jittered ± per spark
} as const;

export interface PickupLayer {
  /**
   * Reconcile the drawn balls with the replicated pickup list. Call once per
   * rendered frame, passing the current array and seconds since boot.
   */
  sync(pickups: readonly PickupStateInstance[], timeSec: number): void;
  dispose(): void;
}

export function createPickupLayer(scene: THREE.Scene): PickupLayer {
  // One group for everything the layer owns, so dispose() and rebuilds are a
  // single parent change.
  const group = new THREE.Group();
  scene.add(group);

  // Shared across every ball and node; rebuilt nodes reuse them.
  const ballGeometry = new THREE.IcosahedronGeometry(BALL_RADIUS, 1);
  // One canvas per DISTINCT label: the canvas is repainted per draw, so a
  // single shared texture would show the last-painted name on every ball.
  // Textures are cached by ITEM id and disposed with the layer.
  const labelTextures = new Map<string, THREE.SpriteMaterial>();
  labelTextures.set('', new THREE.SpriteMaterial());

  const labelMaterialFor = (itemId: string): THREE.SpriteMaterial => {
    const cached = labelTextures.get(itemId);
    if (cached) return cached;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return labelTextures.get('')!;
    drawLabelText(ctx, canvas, itemName(itemId).toUpperCase(), new THREE.Color(itemColor(itemId)));
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    labelTextures.set(itemId, material);
    return material;
  };

  // The glow halo: one shared white radial-gradient texture, tinted per item
  // through the sprite's colour. Cached by item id like the labels.
  const glowMaterials = new Map<string, THREE.SpriteMaterial>();
  let glowTexture: THREE.CanvasTexture | null = null;
  const glowMaterialFor = (itemId: string): THREE.SpriteMaterial => {
    const cached = glowMaterials.get(itemId);
    if (cached) return cached;
    glowTexture ??= makeGlowTexture();
    const material = new THREE.SpriteMaterial({
      map: glowTexture,
      // Tinted above 1.0 so the additive centre clears the bloom threshold
      // (the same knob POST.emissiveGain turns for every other glowing thing).
      color: new THREE.Color(itemColor(itemId)).multiplyScalar(GLOW_GAIN),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    glowMaterials.set(itemId, material);
    return material;
  };

  // --- collection burst ----------------------------------------------------
  // The moment a ball flips to taken the layer rebuilds anyway; the burst is
  // what makes that flip feel like a pickup rather than a despawn. Glow
  // sprites — the SAME radial texture as the halo — fly out of the ball's
  // last position in the item's colour, decelerate under a light gravity and
  // fade over ~0.7 s. One material tints the whole spray, so a burst is a
  // handful of sprites that die on their own, never pooled.
  interface Spark {
    sprite: THREE.Sprite;
    size: number;
    vx: number;
    vy: number;
    vz: number;
  }
  interface Burst {
    group: THREE.Group;
    material: THREE.SpriteMaterial;
    sparks: Spark[];
    life: number;
  }
  const bursts: Burst[] = [];

  function burstAt(x: number, y: number, z: number, item: string): void {
    if (!isAcquirableItem(item)) return;
    glowTexture ??= makeGlowTexture();
    const material = new THREE.SpriteMaterial({
      map: glowTexture,
      // Tinted above 1.0 so the spray clears the bloom threshold like the halo.
      color: new THREE.Color(itemColor(item)).multiplyScalar(GLOW_GAIN * 1.4),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const burstGroup = new THREE.Group();
    burstGroup.position.set(x, y, z);
    const sparks: Spark[] = [];
    for (let i = 0; i < BURST.count; i++) {
      const size = BURST.spark * (0.7 + 0.6 * Math.random());
      const sprite = new THREE.Sprite(material);
      sprite.scale.setScalar(size);
      // Random launch direction on the unit sphere, biased upward so the
      // spray reads as popping off the ball rather than into the floor.
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const speed = BURST.speedMin + Math.random() * (BURST.speedMax - BURST.speedMin);
      sparks.push({
        sprite,
        size,
        vx: Math.sin(phi) * Math.cos(theta) * speed,
        vy: Math.cos(phi) * speed + BURST.up,
        vz: Math.sin(phi) * Math.sin(theta) * speed,
      });
      burstGroup.add(sprite);
    }
    group.add(burstGroup);
    bursts.push({ group: burstGroup, material, sparks, life: BURST.life });
  }

  function tickBursts(dt: number): void {
    for (let i = bursts.length - 1; i >= 0; i--) {
      const burst = bursts[i]!;
      burst.life -= dt;
      if (burst.life <= 0) {
        group.remove(burst.group);
        burst.material.dispose();
        bursts.splice(i, 1);
        continue;
      }
      // The whole spray fades together, each spark shrinking to a glowing dot.
      const fade = burst.life / BURST.life;
      burst.material.opacity = fade;
      for (const spark of burst.sparks) {
        spark.vy -= BURST.gravity * dt;
        spark.sprite.position.x += spark.vx * dt;
        spark.sprite.position.y += spark.vy * dt;
        spark.sprite.position.z += spark.vz * dt;
        spark.sprite.scale.setScalar(spark.size * (0.4 + 0.6 * fade));
      }
    }
  }

  interface Node {
    ball: THREE.Mesh;
    glow: THREE.Sprite;
    label: THREE.Sprite;
    baseY: number;
    spin: number;
    /** Per-ball halo phase, so a cluster of pickups doesn't pulse in lockstep. */
    pulse: number;
  }

  const nodes: Node[] = [];
  // The whole-list fingerprint of the last sync. Any change — a map swap's
  // refill, a taken flip — rebuilds every node in one pass.
  let world = '';
  let lastTime = 0;
  // The untaken balls from the last rebuild, for the taken-flip diff below.
  let prevUntaken: readonly PickupStateInstance[] = [];

  function drawBall(id: string, item: string, x: number, y: number, z: number): Node | null {
    if (!isAcquirableItem(item)) return null;
    const color = new THREE.Color(itemColor(item));

    const material = new THREE.MeshBasicMaterial({ color, toneMapped: false });
    const ball = new THREE.Mesh(ballGeometry, material);
    ball.position.set(x, y, z);
    ball.renderOrder = 9;
    group.add(ball);

    // The halo: a camera-facing additive sprite in the item colour, riding the
    // ball and breathing on its own phase (set in `pulse` below).
    const glow = new THREE.Sprite(glowMaterialFor(item));
    glow.scale.setScalar(GLOW_SCALE);
    glow.renderOrder = 8;
    group.add(glow);

    // The display name, painted into a per-item canvas in the item colour.
    // Cached by item id, so every ball of the same item shares one material.
    const label = new THREE.Sprite(labelMaterialFor(item));
    label.position.set(x, y + LABEL_GAP, z);
    label.scale.set(2.1, 0.52, 1);
    label.renderOrder = 10;
    group.add(label);

    return {
      ball,
      glow,
      label,
      baseY: y,
      spin: id.length % 2 === 0 ? 1 : -1,
      pulse: (id.length * 1.7) % (Math.PI * 2),
    };
  }

  function rebuild(pickups: readonly PickupStateInstance[]): void {
    // Diff against the last build: a ball that WAS rendered and is no longer
    // untaken flipped to taken this patch — that is the collection moment, so
    // pop the spark burst at its last position. A map swap replaces every
    // ball with fresh ids, so nothing survives; bursting then would spray the
    // whole arena for a fake collection. Requiring at least one survivor also
    // keeps a whole-arena sweep quiet.
    const nextUntaken = pickups.filter((p) => !p.taken);
    const nextIds = new Set(nextUntaken.map((p) => p.id));
    const vanished = prevUntaken.filter((p) => !nextIds.has(p.id));
    if (vanished.length < prevUntaken.length) {
      for (const p of vanished) burstAt(p.x, p.y, p.z, p.item);
    }
    prevUntaken = nextUntaken;

    for (const node of nodes) {
      (node.ball.material as THREE.Material).dispose();
      group.remove(node.ball, node.glow, node.label);
    }
    nodes.length = 0;

    for (const pickup of pickups) {
      if (pickup.taken) continue;
      const node = drawBall(pickup.id, pickup.item, pickup.x, pickup.y, pickup.z);
      if (node) nodes.push(node);
    }
  }

  return {
    sync(pickups, timeSec) {
      // Fingerprint: id, item and taken per ball. Positions never change for
      // a live ball, so they need not sign the key.
      let key = '';
      for (const pickup of pickups) {
        key += `${pickup.id}|${pickup.item}|${pickup.taken ? 1 : 0};`;
      }
      if (key !== world) {
        world = key;
        rebuild(pickups);
      }

      // Animate the live balls. dt comes from the caller's clock so a hiccup
      // (a paused tab, a hitch) cannot yank the bob into a jump.
      const dt = Math.min(0.1, timeSec - lastTime);
      lastTime = timeSec;
      for (const node of nodes) {
        node.ball.position.y = node.baseY + Math.sin(timeSec * BOB.freq) * BOB.amp;
        node.ball.rotation.y += SPIN * node.spin * dt;
        // The halo rides the ball and breathes on its own phase, so a field of
        // pickups shimmers out of sync instead of thrumming together.
        node.glow.position.copy(node.ball.position);
        node.glow.scale.setScalar(GLOW_SCALE * (1 + 0.12 * Math.sin(timeSec * GLOW_PULSE + node.pulse)));
        node.label.position.y = node.ball.position.y + LABEL_GAP;
      }
      // Live bursts age with the same clock as the bob, so they ride dt rather
      // than frame rate.
      tickBursts(dt);
    },

    dispose() {
      for (const node of nodes) {
        (node.ball.material as THREE.Material).dispose();
      }
      nodes.length = 0;
      for (const material of labelTextures.values()) {
        material.map?.dispose();
        material.dispose();
      }
      labelTextures.clear();
      glowTexture?.dispose();
      glowTexture = null;
      for (const material of glowMaterials.values()) material.dispose();
      glowMaterials.clear();
      for (const burst of bursts) {
        group.remove(burst.group);
        burst.material.dispose();
      }
      bursts.length = 0;
      ballGeometry.dispose();
      scene.remove(group);
    },
  };
}

/**
 * The halo texture: a white radial falloff (hot core, faint skirt) shared by
 * every ball and tinted per item through each sprite's colour. Painted white
 * on purpose — with `AdditiveBlending` the material colour multiplies it.
 */
function makeGlowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const r = size / 2;
  const gradient = ctx.createRadialGradient(r, r, 0, r, r, r);
  gradient.addColorStop(0, 'rgba(255,255,255,0.9)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.28)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/**
 * Paint a pickup's name across the label canvas, remotes-style: uppercase with
 * manual tracking and a hairline underline, no backing plate — the hull text
 * reads by its own colour against the near-black scene.
 */
function drawLabelText(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  text: string,
  color: THREE.Color,
): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Set before measuring: `measureText` uses the current font, and measuring
  // with the 10px default made every label sit off-centre.
  ctx.font = '500 22px ui-sans-serif, "Helvetica Neue", Helvetica, Arial, sans-serif';

  const spacing = 2;
  let width = 0;
  for (const ch of text) width += ctx.measureText(ch).width + spacing;
  width -= spacing;

  const fill = `#${color.getHexString()}`;
  let x = (canvas.width - width) / 2;
  for (const ch of text) {
    ctx.fillStyle = fill;
    ctx.fillText(ch, x, 34);
    x += ctx.measureText(ch).width + spacing;
  }

  ctx.fillStyle = fill;
  ctx.globalAlpha = 0.4;
  ctx.fillRect((canvas.width - width) / 2, 42, width, 1);
}