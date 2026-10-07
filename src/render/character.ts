/**
 * The racer character
 *
 * A blocky mannequin: cube head with a lit visor slit, box segments for every
 * limb, dark joints between them, the whole body glowing in the racer's colour,
 * and light trails off the feet (and the hands, mid-dash).
 *
 * Purely visual. The physics body is still the capsule in shared/sim.ts and
 * nothing here is ever read back, so the character can change freely without
 * touching prediction. It is sized to fit inside that capsule (0.8 wide, 1.8
 * tall) so it never visibly clips through a wall the capsule stopped at.
 *
 * Every motion is procedural, driven by state the client already has: speed
 * and velocity (run cycle, facing), grounded (air pose, landing squash),
 * dashing (lunge pose, hand trails) and carrying (arms up, holding the Core
 * overhead -- the one pose every player must read at a glance). No skeleton,
 * no animation clips, no assets to load.
 *
 * Shared by the local racer (render/scene.ts) and remote racers
 * (net/remotes.ts), so both always look and move identically.
 */

import * as THREE from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  color,
  dot,
  mix,
  mul,
  add,
  normalize,
  normalWorld,
  oneMinus,
  pow,
  positionWorld,
  saturate,
  sub,
  uniform,
  vec3,
} from 'three/tsl';

import { MOVE, PLAYER } from '../constants.ts';
import { NEON, PALETTE, POST } from './palette.ts';
import { fxBeat } from './fx.ts';

/** See net/remotes.ts for why these node types are spelled out. */
type Vec3Uniform = THREE.UniformNode<'vec3', THREE.Vector3>;
type FloatUniform = THREE.UniformNode<'float', number>;

export interface CharacterState {
  /** Body centre, as the sim and the replicated state report it. */
  x: number;
  y: number;
  z: number;
  /** Horizontal velocity: drives facing. */
  vx: number;
  vz: number;
  /** Horizontal speed: drives the run cycle. */
  speed: number;
  grounded: boolean;
  dashing: boolean;
  carrying: boolean;
}

export interface Character {
  /**
   * The emissive tint, live. Callers lerp it toward the identity, airborne or
   * carrier colour exactly as they did for the capsule.
   */
  readonly tint: THREE.Color;
  /** Glow gain multiplier: 1 at rest, higher for the dash and carrier cues. */
  glow: number;
  /** Pose and animate. `delta` is the real frame delta in seconds. */
  update(state: CharacterState, delta: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

// ---------------------------------------------------------------- proportions
// Feet at y=0 in the root's frame; hips at 0.9, head top at ~1.8. Model faces
// +Z; the root is rotated to the direction of travel.

const LEG = { thigh: 0.42, shin: 0.4, foot: 0.08 } as const;
const HIP_Y = LEG.thigh + LEG.shin + LEG.foot; // 0.9: exactly half the capsule
const TORSO_H = 0.46;
const HEAD = 0.3;
const UPPER_ARM = 0.27;
const FOREARM = 0.24;

/**
 * Distance travelled per full run cycle (two strides), in world units. ~3
 * cycles a second at full run speed: a sprinter's cadence. The first value
 * (2.6) was tuned at the old run speed of 9 and became a cartoon leg-blur at 13.
 */
const CYCLE_LENGTH = 4.4;

/** Samples per trail, and how often a new one is taken. */
const TRAIL_SAMPLES = 14;
const TRAIL_INTERVAL = 1 / 60;

/** Dash afterimages: pool size, seconds each one lives, seconds between them. */
const GHOSTS = 4;
const GHOST_LIFE = 0.22;
const GHOST_INTERVAL = 0.035;

/** Below this horizontal speed the racer keeps its last facing. */
const FACING_MIN_SPEED = 0.6;

export function createCharacter(scene: THREE.Scene, identity: THREE.ColorRepresentation): Character {
  // The tint lives in a THREE.Color callers can lerp, mirrored into a vec3
  // uniform each frame. A colour-typed uniform would be simpler, but the TSL
  // typings refuse to multiply one by a float node; a vec3 has no such problem.
  const tintColor = new THREE.Color(identity);
  const tint = uniform(new THREE.Vector3(tintColor.r, tintColor.g, tintColor.b)) as unknown as Vec3Uniform;
  const glow = uniform(1) as unknown as FloatUniform;

  // --- materials ------------------------------------------------------------
  // The body glows in the racer's colour with a brighter fresnel rim, so the
  // silhouette reads even against a bright neon floor; the lights still shade
  // the faces so the boxes read as volumes rather than flat stickers. Joints
  // are near-black, which is what gives the mannequin its segmented look.
  const viewDir = normalize(sub(cameraPosition, positionWorld));
  const fresnel = pow(oneMinus(saturate(dot(normalize(normalWorld), viewDir))), 2.2);

  const bodyMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.4, metalness: 0.15 });
  bodyMat.colorNode = mul(tint, 0.75);
  bodyMat.emissiveNode = mul(tint, mul(add(0.1, mul(fresnel, 0.85)), mul(glow, POST.emissiveGain)));

  const jointMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0.2 });
  jointMat.colorNode = color(PALETTE.mass);
  jointMat.emissiveNode = mul(tint, mul(fresnel, 0.25));

  // The visor is the face: the brightest thing on the body, pure white so it
  // stays readable whatever the racer's colour.
  const visorMat = new THREE.MeshBasicNodeMaterial();
  const visor = new THREE.Color(NEON.white).multiplyScalar(POST.emissiveGain * 1.6);
  visorMat.colorNode = vec3(visor.r, visor.g, visor.b);

  // Neon edges: every body segment is outlined like the arena's solids, in a
  // brightened version of the racer's colour. This is what makes the racer
  // belong to the world -- the course is drawn in lit edges, and now so are
  // the people in it. Joints and the visor stay un-outlined, so the outline
  // traces the armour plates and the dark gaps between them read as gaps.
  const edgeMat = new THREE.LineBasicNodeMaterial({ toneMapped: false });
  edgeMat.colorNode = mul(mix(tint, vec3(1, 1, 1), 0.3), mul(glow, POST.emissiveGain * 1.35));

  const geometries: THREE.BufferGeometry[] = [];
  const box = (
    w: number, h: number, d: number,
    material: THREE.Material,
    parent: THREE.Object3D,
    x: number, y: number, z: number,
  ): THREE.Mesh => {
    const geometry = new THREE.BoxGeometry(w, h, d);
    geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    if (material === bodyMat) {
      const edges = new THREE.EdgesGeometry(geometry);
      geometries.push(edges);
      mesh.add(new THREE.LineSegments(edges, edgeMat));
    }
    return mesh;
  };
  const pivot = (parent: THREE.Object3D, x: number, y: number, z: number): THREE.Group => {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    parent.add(group);
    return group;
  };

  // --- skeleton of pivots ---------------------------------------------------
  const root = new THREE.Group();
  scene.add(root);

  const hips = pivot(root, 0, HIP_Y, 0);
  box(0.34, 0.14, 0.2, bodyMat, hips, 0, 0, 0);

  const torso = pivot(hips, 0, 0.07, 0);
  box(0.22, 0.08, 0.16, jointMat, torso, 0, 0.03, 0); // waist
  box(0.42, 0.34, 0.25, bodyMat, torso, 0, 0.27, 0); // chest
  box(0.32, 0.1, 0.2, bodyMat, torso, 0, 0.11, 0); // belly

  const neck = pivot(torso, 0, TORSO_H, 0);
  box(0.1, 0.07, 0.1, jointMat, neck, 0, 0.02, 0);
  const head = pivot(neck, 0, 0.05, 0);
  box(HEAD, HEAD, HEAD, bodyMat, head, 0, HEAD / 2, 0);
  // Visor slit on the front face, slightly proud of it so it never z-fights.
  box(0.22, 0.05, 0.02, visorMat, head, 0.01, HEAD * 0.58, HEAD / 2 + 0.006);

  interface Limb { upper: THREE.Group; lower: THREE.Group; end: THREE.Object3D }

  const arm = (side: 1 | -1): Limb => {
    const shoulder = pivot(torso, side * 0.27, TORSO_H - 0.05, 0);
    box(0.13, 0.13, 0.13, jointMat, shoulder, 0, 0, 0);
    box(0.11, UPPER_ARM - 0.04, 0.11, bodyMat, shoulder, 0, -UPPER_ARM / 2 - 0.02, 0);
    const elbow = pivot(shoulder, 0, -UPPER_ARM, 0);
    box(0.09, 0.06, 0.09, jointMat, elbow, 0, 0, 0);
    box(0.1, FOREARM - 0.04, 0.1, bodyMat, elbow, 0, -FOREARM / 2 - 0.02, 0);
    const hand = box(0.12, 0.12, 0.12, bodyMat, elbow, 0, -FOREARM - 0.04, 0);
    return { upper: shoulder, lower: elbow, end: hand };
  };

  const leg = (side: 1 | -1): Limb => {
    const hip = pivot(hips, side * 0.1, -0.05, 0);
    box(0.15, LEG.thigh - 0.06, 0.16, bodyMat, hip, 0, -LEG.thigh / 2, 0);
    const knee = pivot(hip, 0, -LEG.thigh, 0);
    box(0.11, 0.07, 0.11, jointMat, knee, 0, 0, 0);
    box(0.13, LEG.shin - 0.06, 0.14, bodyMat, knee, 0, -LEG.shin / 2 - 0.01, 0);
    const foot = box(0.14, LEG.foot, 0.26, bodyMat, knee, 0, -LEG.shin - LEG.foot / 2 + 0.05, 0.05);
    return { upper: hip, lower: knee, end: foot };
  };

  const armL = arm(-1);
  const armR = arm(1);
  const legL = leg(-1);
  const legR = leg(1);

  // Splay the arms a hair so they never sit inside the torso box.
  armL.upper.rotation.z = -0.1;
  armR.upper.rotation.z = 0.1;

  // --- trails -----------------------------------------------------------------
  // World-space ribbons: a short history of a limb's position, drawn as a strip
  // that tapers and fades with age. Additive, so they read as light, and their
  // brightness is scaled by an `aFade` attribute rather than opacity -- with
  // additive blending, darker IS more transparent.
  const trailMat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  trailMat.colorNode = mul(tint, mul(attribute('aFade', 'float'), mul(glow, POST.emissiveGain)));

  interface Trail {
    source: THREE.Object3D;
    mesh: THREE.Mesh;
    positions: THREE.BufferAttribute;
    fade: THREE.BufferAttribute;
    history: Float32Array; // TRAIL_SAMPLES * 3, newest first
    width: number;
    primed: boolean;
  }

  const trailIndex: number[] = [];
  for (let i = 0; i < TRAIL_SAMPLES - 1; i++) {
    const a = i * 2;
    trailIndex.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }

  const makeTrail = (source: THREE.Object3D, width: number): Trail => {
    const geometry = new THREE.BufferGeometry();
    const positions = new THREE.BufferAttribute(new Float32Array(TRAIL_SAMPLES * 2 * 3), 3);
    const fade = new THREE.BufferAttribute(new Float32Array(TRAIL_SAMPLES * 2), 1);
    positions.setUsage(THREE.DynamicDrawUsage);
    fade.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', positions);
    geometry.setAttribute('aFade', fade);
    geometry.setIndex(trailIndex);
    geometries.push(geometry);

    const mesh = new THREE.Mesh(geometry, trailMat);
    // The geometry moves every frame in world space; its bounds would be stale.
    mesh.frustumCulled = false;
    scene.add(mesh);
    return {
      source,
      mesh,
      positions,
      fade,
      history: new Float32Array(TRAIL_SAMPLES * 3),
      width,
      primed: false,
    };
  };

  // Foot trails hang off fixed anchors at heel height on the ROOT, not off the
  // feet. The feet swing up, down, forward and back every stride, and a trail
  // that followed them drew a jagged sawtooth along the ground; anchored to the
  // body's path it is one clean streak of light per side, like the reference.
  const heelL = pivot(root, -0.12, 0.07, -0.12);
  const heelR = pivot(root, 0.12, 0.07, -0.12);
  const footTrails = [makeTrail(heelL, 0.06), makeTrail(heelR, 0.06)];
  const handTrails = [makeTrail(armL.end, 0.05), makeTrail(armR.end, 0.05)];

  const scratch = new THREE.Vector3();

  /** Shift history back one slot when a sample is due, then pin the head to the limb. */
  const sampleTrail = (trail: Trail, push: boolean): void => {
    trail.source.getWorldPosition(scratch);
    const h = trail.history;
    if (!trail.primed) {
      for (let i = 0; i < TRAIL_SAMPLES; i++) {
        h[i * 3] = scratch.x;
        h[i * 3 + 1] = scratch.y;
        h[i * 3 + 2] = scratch.z;
      }
      trail.primed = true;
    } else if (push) {
      h.copyWithin(3, 0, (TRAIL_SAMPLES - 1) * 3);
    }
    h[0] = scratch.x;
    h[1] = scratch.y;
    h[2] = scratch.z;
  };

  /** Rebuild the ribbon: a vertical strip, tapering and fading toward the tail. */
  const writeTrail = (trail: Trail, intensity: number): void => {
    const h = trail.history;
    const pos = trail.positions.array as Float32Array;
    const fade = trail.fade.array as Float32Array;
    for (let i = 0; i < TRAIL_SAMPLES; i++) {
      const life = 1 - i / (TRAIL_SAMPLES - 1);
      const half = trail.width * (0.25 + 0.75 * life);
      const o = i * 6;
      pos[o] = h[i * 3]!;
      pos[o + 1] = h[i * 3 + 1]! + half;
      pos[o + 2] = h[i * 3 + 2]!;
      pos[o + 3] = h[i * 3]!;
      pos[o + 4] = h[i * 3 + 1]! - half;
      pos[o + 5] = h[i * 3 + 2]!;
      const f = intensity * life * life;
      fade[i * 2] = f;
      fade[i * 2 + 1] = f;
    }
    trail.positions.needsUpdate = true;
    trail.fade.needsUpdate = true;
    trail.mesh.visible = intensity > 0.01;
  };

  // --- dash afterimages ---------------------------------------------------------
  // Frozen copies of the whole body left behind during a dash, each fading out
  // on its own. A pool, so a dash allocates nothing: the copies are cloned once
  // here (sharing geometry) and only their pose and fade change afterwards.
  //
  // Each ghost has its own material because each fades independently; the
  // graph is identical, so they share one compiled shader.
  interface Ghost { root: THREE.Object3D; nodes: THREE.Object3D[]; fade: FloatUniform; age: number }
  const sourceNodes: THREE.Object3D[] = [];
  root.traverse((node) => sourceNodes.push(node));
  const ghostMats: THREE.Material[] = [];
  const ghosts: Ghost[] = [];
  for (let i = 0; i < GHOSTS; i++) {
    const fade = uniform(0) as unknown as FloatUniform;
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    material.colorNode = mul(tint, mul(fade, POST.emissiveGain * 0.9));
    ghostMats.push(material);

    const copy = root.clone(true);
    const nodes: THREE.Object3D[] = [];
    copy.traverse((node) => {
      nodes.push(node);
      if (node instanceof THREE.Mesh) node.material = material;
      // Afterimages are soft silhouettes; full-brightness outlines would
      // make every ghost as loud as the racer itself.
      if (node instanceof THREE.LineSegments) node.visible = false;
    });
    copy.visible = false;
    scene.add(copy);
    ghosts.push({ root: copy, nodes, fade, age: GHOST_LIFE });
  }
  let nextGhost = 0;
  let ghostClock = 0;

  const spawnGhost = (): void => {
    const ghost = ghosts[nextGhost]!;
    nextGhost = (nextGhost + 1) % GHOSTS;
    for (let i = 0; i < sourceNodes.length; i++) {
      const from = sourceNodes[i]!;
      const to = ghost.nodes[i]!;
      to.position.copy(from.position);
      to.quaternion.copy(from.quaternion);
      to.scale.copy(from.scale);
    }
    ghost.age = 0;
    ghost.root.visible = true;
  };

  // --- animation state --------------------------------------------------------
  let phase = 0;
  let facing = 0;
  let lastFacing = 0;
  let bank = 0;
  let clock = 0;
  let trailClock = 0;
  let wasGrounded = true;
  // Smoothed blend weights, all 0..1.
  let runW = 0;
  let airW = 0;
  let dashW = 0;
  let carryW = 0;
  let landW = 0;
  let footTrailW = 0;
  let handTrailW = 0;

  const ease = (current: number, target: number, rate: number, dt: number): number =>
    current + (target - current) * (1 - Math.exp(-rate * dt));
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

  return {
    tint: tintColor,

    get glow() {
      return glow.value;
    },
    set glow(value: number) {
      glow.value = value;
    },

    update(state, delta) {
      const dt = Math.max(0, delta);
      clock += dt;
      tint.value.set(tintColor.r, tintColor.g, tintColor.b);

      // --- facing ----------------------------------------------------------
      // From velocity, not from input: remotes have no input, and velocity is
      // what the eye reads as "going that way". Shortest-arc easing so a turn
      // through the +/-PI seam does not spin the long way round.
      if (state.speed > FACING_MIN_SPEED) {
        const target = Math.atan2(state.vx, state.vz);
        let diff = target - facing;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        facing += diff * (1 - Math.exp(-16 * dt));
      }

      // --- blend weights ---------------------------------------------------
      const runAmount = Math.min(1, state.speed / MOVE.runSpeed);
      runW = ease(runW, state.dashing ? 1 : runAmount, 10, dt);
      airW = ease(airW, state.grounded ? 0 : 1, 12, dt);
      dashW = ease(dashW, state.dashing ? 1 : 0, 22, dt);
      carryW = ease(carryW, state.carrying ? 1 : 0, 8, dt);

      // A landing is the frame grounded flips back on: a quick squash that
      // decays on its own.
      if (state.grounded && !wasGrounded) landW = 1;
      wasGrounded = state.grounded;
      landW = Math.max(0, landW - dt * 6);

      // Stride locked to distance covered, so feet do not skate at any speed.
      // Frozen in the air: legs hold the tuck instead of running on nothing.
      if (state.grounded) phase += (state.speed / CYCLE_LENGTH) * Math.PI * 2 * dt;

      // Bank into turns, like a sprinter leaning round a bend. Read from how
      // fast the facing is swinging, so remotes bank too.
      const yawRate = dt > 0 ? (facing - lastFacing) / dt : 0;
      lastFacing = facing;
      const bankTarget = Math.max(-0.38, Math.min(0.38, -yawRate * 0.07)) * runW * (1 - airW);
      bank = ease(bank, bankTarget, 10, dt);

      // --- sprint ------------------------------------------------------------
      // A sprint, not a jog: the thigh drives high in front and only trails a
      // little behind, the heel kicks up during recovery, the torso leans in,
      // and the arms PUMP -- elbows near 90 degrees, fist up to the face on the
      // forward swing, hand past the hip on the back swing. The first version
      // swung straight arms with a fixed bend, which read as reaching forward.
      const s = Math.sin(phase);
      const c = Math.cos(phase);
      const r = runW;
      const thighOf = (f: number): number => -r * (f > 0 ? 1.2 * f : 0.55 * f);
      const armOf = (f: number): number => r * (f > 0 ? 0.85 * f : 1.2 * f);

      let thighL = thighOf(s);
      let thighR = thighOf(-s);
      // The knee folds while its leg swings forward (recovery), straightens
      // for the plant.
      let kneeL = r * (0.15 + 1.7 * Math.max(0, c));
      let kneeR = r * (0.15 + 1.7 * Math.max(0, -c));
      let armSwingL = armOf(s);
      let armSwingR = armOf(-s);
      let elbowL = -(0.3 + 1.25 * r);
      let elbowR = elbowL;
      let lean = 0.06 + 0.3 * r;
      // Twice per cycle: the body rises in each flight phase between steps.
      let bob = 0.07 * r * Math.abs(s);
      let headPitch = -lean * 0.6;

      // --- idle: groove on the kick drum ---------------------------------------
      // Standing still, the racer bounces at the knees and nods on every beat
      // of the music (render/fx.ts). The arena pulses on the same beat, so a
      // room of idle racers moves as one -- the techno does the talking.
      const groove = (1 - r) * (1 - airW);
      if (groove > 0.001) {
        const beat = fxBeat.value;
        kneeL += 0.32 * beat * groove;
        kneeR += 0.32 * beat * groove;
        thighL -= 0.16 * beat * groove;
        thighR -= 0.16 * beat * groove;
        bob -= 0.045 * beat * groove;
        headPitch += 0.2 * beat * groove;
        lean += 0.06 * beat * groove;
        elbowL -= 0.25 * beat * groove;
        elbowR -= 0.25 * beat * groove;
      }

      // --- air: knees tucked, arms out for balance --------------------------
      thighL = lerp(thighL, -1.0, airW);
      kneeL = lerp(kneeL, 1.45, airW);
      thighR = lerp(thighR, 0.35, airW);
      kneeR = lerp(kneeR, 1.0, airW);
      armSwingL = lerp(armSwingL, -0.9, airW);
      armSwingR = lerp(armSwingR, 0.7, airW);
      elbowL = lerp(elbowL, -0.9, airW);
      elbowR = lerp(elbowR, -0.6, airW);
      bob = lerp(bob, 0, airW);

      // --- dash: a lunging punch ------------------------------------------------
      // The dash IS the steal, so it reads as an attack: the right fist drives
      // straight out ahead, the left arm whips back, the body goes nearly flat
      // and the back leg extends.
      thighL = lerp(thighL, -1.15, dashW);
      kneeL = lerp(kneeL, 1.5, dashW);
      thighR = lerp(thighR, 1.05, dashW);
      kneeR = lerp(kneeR, 0.35, dashW);
      armSwingR = lerp(armSwingR, -1.65, dashW);
      elbowR = lerp(elbowR, -0.08, dashW);
      armSwingL = lerp(armSwingL, 1.2, dashW);
      elbowL = lerp(elbowL, -0.4, dashW);
      lean = lerp(lean, 0.85, dashW);
      headPitch = lerp(headPitch, -0.6, dashW);

      // --- carrying: both arms up, holding the Core overhead ------------------
      // Applied last so it wins over every other arm pose: the holder must be
      // recognisable from across the arena in any state.
      armSwingL = lerp(armSwingL, -2.85, carryW);
      armSwingR = lerp(armSwingR, -2.85, carryW);
      elbowL = lerp(elbowL, -0.35, carryW);
      elbowR = lerp(elbowR, -0.35, carryW);
      lean = lerp(lean, lean * 0.5, carryW);

      // --- apply -----------------------------------------------------------
      legL.upper.rotation.x = thighL;
      legL.lower.rotation.x = kneeL;
      legR.upper.rotation.x = thighR;
      legR.lower.rotation.x = kneeR;
      armL.upper.rotation.x = armSwingL;
      armR.upper.rotation.x = armSwingR;
      armL.lower.rotation.x = elbowL;
      armR.lower.rotation.x = elbowR;
      torso.rotation.x = lean;
      head.rotation.x = headPitch;
      // Hips and shoulders counter-twist against the stride; it is what makes
      // the run read as a run rather than as legs swinging under a statue.
      hips.rotation.y = 0.14 * r * s * (1 - airW);
      torso.rotation.y = -0.24 * r * s * (1 - airW);

      const squash = 0.14 * landW;
      root.scale.set(1 + squash * 0.5, 1 - squash, 1 + squash * 0.5);
      root.position.set(state.x, state.y - (PLAYER.halfHeight + PLAYER.radius) + bob, state.z);
      root.rotation.y = facing;
      root.rotation.z = bank;
      root.updateMatrixWorld(true);

      // --- trails ----------------------------------------------------------
      // Feet stream light while running fast and always in a dash; hands only
      // in a dash, which is what makes the lunge read as an attack.
      footTrailW = ease(footTrailW, state.dashing ? 1 : Math.max(0, runAmount - 0.45) * 0.6, 10, dt);
      handTrailW = ease(handTrailW, state.dashing ? 0.8 : 0, 14, dt);

      trailClock += dt;
      const push = trailClock >= TRAIL_INTERVAL;
      if (push) trailClock %= TRAIL_INTERVAL;
      for (const trail of footTrails) {
        sampleTrail(trail, push);
        writeTrail(trail, footTrailW);
      }
      for (const trail of handTrails) {
        sampleTrail(trail, push);
        writeTrail(trail, handTrailW);
      }

      // --- afterimages -------------------------------------------------------
      ghostClock += dt;
      if (state.dashing && root.visible && ghostClock >= GHOST_INTERVAL) {
        ghostClock = 0;
        spawnGhost();
      }
      for (const ghost of ghosts) {
        if (!ghost.root.visible) continue;
        ghost.age += dt;
        const life = 1 - ghost.age / GHOST_LIFE;
        if (life <= 0) {
          ghost.root.visible = false;
          continue;
        }
        ghost.fade.value = 0.55 * life * life;
      }
    },

    setVisible(visible) {
      root.visible = visible;
      for (const trail of [...footTrails, ...handTrails]) {
        if (!visible) trail.mesh.visible = false;
      }
    },

    dispose() {
      scene.remove(root);
      for (const trail of [...footTrails, ...handTrails]) scene.remove(trail.mesh);
      for (const geometry of geometries) geometry.dispose();
      bodyMat.dispose();
      jointMat.dispose();
      visorMat.dispose();
      edgeMat.dispose();
      trailMat.dispose();
      for (const ghost of ghosts) scene.remove(ghost.root);
      for (const material of ghostMats) material.dispose();
    },
  };
}
