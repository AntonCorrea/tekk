/**
 * THE CORE: the floating diamond everyone is chasing.
 *
 * Art brief: a vertically stretched bipyramid of flat-shaded triangular facets in
 * white / pink / cyan, with a white-hot nucleus inside. It has to be the single
 * brightest, most legible thing in the scene, readable from across an arena.
 *
 * How it reads as "brightest":
 *   - Every surface is an unlit emissive colour (MeshBasic/Sprite/Line node
 *     materials). The Core ignores scene lights on purpose: its brightness is a
 *     design constant, not something a stray light can dim.
 *   - Output levels are multiplied by POST.emissiveGain, the same knob every other
 *     glowing thing uses, so it tracks desktop/mobile tuning. Facets sit around
 *     1x gain, the edge lattice ~1.6x, the nucleus ~3.5x. Bloom's threshold is
 *     0.55-0.72, so the facets bloom a little, the edges a lot, the nucleus
 *     blows out to white. That gradient is what makes it look like a crystal with
 *     a light inside rather than a flat glowing shape.
 *   - Fog is switched off on every material. Scene fog would otherwise tint it
 *     toward the background at a distance, which is precisely when it must read.
 *
 * Why additive, double-sided, depth-write-off facets instead of opaque ones: it
 * lets the nucleus show through the crystal and makes front and back faces stack
 * into a denser core, which is what a glassy solid looks like with no real
 * refraction, and it needs no sorting. The crisp "technical" feel comes from the
 * flat facets plus a hard white edge lattice rather than from a smooth gloss.
 *
 * Presentational and client-only: nothing here touches simulation state.
 */

import * as THREE from 'three/webgpu';
import {
  abs,
  add,
  attribute,
  cameraPosition,
  clamp,
  color,
  dot,
  float,
  length,
  mix,
  mul,
  normalize,
  normalWorld,
  oneMinus,
  positionLocal,
  positionWorld,
  pow,
  saturate,
  sin,
  smoothstep,
  step,
  sub,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

import { NEON, POST } from './palette.ts';

export interface CoreVisualState {
  /** World position of the Core's centre. */
  x: number;
  y: number;
  z: number;
  /** True while someone holds it; false when it sits free on its spawn. */
  carried: boolean;
  /** True during the post-steal immunity window: a visible shimmer/flicker cue. */
  immune: boolean;
}

export interface CoreVisual {
  /** Per rendered frame. `now` in seconds, `delta` in seconds (real frame delta). */
  update(state: CoreVisualState, now: number, delta: number): void;
  /** Fire the energy wave once, at the Core's current position (carrier changed). */
  burst(): void;
  dispose(): void;
}

// --- tuning ------------------------------------------------------------------

/** Equator half-width and tip half-height. Stretched so it reads as a diamond, not a die. */
const RADIUS = 0.5;
const HALF_HEIGHT = 0.9;

/** Seconds a burst takes to expand and fade. */
const BURST_SECONDS = 0.7;
/** Overlapping bursts are pooled; a steal chain faster than this recycles the oldest. */
const BURST_SLOTS = 3;
/** World-space radius the wave reaches. Big enough to be seen across an arena. */
const BURST_RING_RADIUS = 7;
const BURST_SHELL_RADIUS = 4.2;

/** Spin in rad/s: quick and tight when carried, slow and grand when sitting free. */
const SPIN_CARRIED = 1.7;
const SPIN_FREE = 0.7;
/** Scale when free: slightly bigger so an unclaimed Core is findable. */
const SCALE_FREE = 1.22;
/** Rate (1/s) at which free/carried and immune blends settle. Exponential, so framerate-independent. */
const BLEND_RATE = 5;

/** Ground height the beam and ring sit on, a hair above the grid to avoid z-fighting. */
const GROUND_Y = 0.04;

// --- shader helpers ----------------------------------------------------------

/**
 * Uniform type is spelled out because TSL's inference widens an untyped uniform
 * and then rejects arithmetic (same trap as remotes.ts' colour uniform).
 */
type FloatUniform = THREE.UniformNode<'float', number>;

function applyCommon(material: THREE.NodeMaterial): void {
  // Fog off: see header. Tone mapping stays on so the Core grades like everything else.
  material.fog = false;
  material.depthWrite = false;
  material.transparent = true;
  material.blending = THREE.AdditiveBlending;
}

/** Inverted view-angle term: 0 face-on, 1 at the silhouette. */
function fresnelTerm(power: number) {
  const viewDir = normalize(sub(cameraPosition, positionWorld));
  return pow(oneMinus(saturate(abs(dot(normalize(normalWorld), viewDir)))), power);
}

// --- geometry ----------------------------------------------------------------

/**
 * A bipyramid whose 8 faces are each split into 4 triangles (32 facets), built by
 * hand and left un-normalised. THREE.PolyhedronGeometry with detail > 0 projects
 * the new vertices onto a sphere, which rounds the shape off; a sharp diamond
 * needs the subdivision to stay planar. Non-indexed so every facet owns its
 * vertices: that gives flat normals and a per-facet attribute for free.
 *
 * `facet` is a stable pseudo-random 0..1 per triangle, used to pick white / pink /
 * cyan and to desynchronise the sparkle. Derived from the index (not Math.random)
 * so the Core looks identical on every client and every load.
 */
function buildCrystalGeometry(): THREE.BufferGeometry {
  const top = new THREE.Vector3(0, HALF_HEIGHT, 0);
  const bottom = new THREE.Vector3(0, -HALF_HEIGHT, 0);
  const ring = [
    new THREE.Vector3(RADIUS, 0, 0),
    new THREE.Vector3(0, 0, RADIUS),
    new THREE.Vector3(-RADIUS, 0, 0),
    new THREE.Vector3(0, 0, -RADIUS),
  ];

  const positions: number[] = [];
  const facets: number[] = [];
  let tri = 0;
  const push = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, flip: boolean): void => {
    const order = flip ? [a, c, b] : [a, b, c];
    const h = Math.sin((tri + 1) * 91.345) * 43758.5453;
    const f = h - Math.floor(h);
    tri++;
    for (const v of order) {
      positions.push(v.x, v.y, v.z);
      facets.push(f);
    }
  };

  const mid = (a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 =>
    a.clone().add(b).multiplyScalar(0.5);

  for (let i = 0; i < 4; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % 4]!;
    for (const [apex, flip] of [
      [top, false],
      [bottom, true],
    ] as const) {
      const ab = mid(apex, p);
      const bc = mid(p, q);
      const ca = mid(q, apex);
      // All four sub-triangles share the parent face's winding.
      push(ab, p, bc, flip);
      push(ca, bc, q, flip);
      push(ab, bc, ca, flip);
      push(apex, ab, ca, flip);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('facet', new THREE.Float32BufferAttribute(facets, 1));
  geo.computeVertexNormals();
  return geo;
}

// --- the Core ----------------------------------------------------------------

export function createCoreVisual(scene: THREE.Scene): CoreVisual {
  const gain = POST.emissiveGain;

  // Shared uniforms: one write per frame drives every material that reads them.
  const uTime = uniform(0) as FloatUniform;
  /** 0 = flicker-free, 1 = fully shimmering. Smoothed so the cue fades rather than pops. */
  const uImmune = uniform(0) as FloatUniform;
  /** 0 = carried, 1 = free on its spawn. Drives beam, ground glow and halo size. */
  const uFree = uniform(0) as FloatUniform;

  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  // Immune cue: a smooth brightness pulse and a push toward cyan. A pulse reads
  // as "can't be touched right now" faster than a colour change alone, and
  // works for colour-blind players.
  //
  // Deliberately a sine at 2.5 Hz, not a hard flicker. Flashing above 3 Hz is
  // a photosensitive-seizure risk (WCAG 2.3.1), and this is the brightest,
  // most bloomed object on screen, shown on big screens at events. An earlier
  // version used a ~6 Hz square wave.
  const IMMUNE_PULSE_RAD_PER_S = 2 * Math.PI * 2.5;
  const flicker = mix(
    float(1),
    add(0.72, mul(0.28, sin(mul(uTime, IMMUNE_PULSE_RAD_PER_S)))),
    uImmune,
  );

  // Crystal facets ---------------------------------------------------------
  const crystalGeo = own(buildCrystalGeometry());

  const facet = attribute('facet', 'float');
  const white = color(NEON.white);
  const pink = color(NEON.magenta);
  const cyan = color(NEON.cyan);
  // Three-way pick with hard steps: facets are single flat colours, not gradients.
  const facetColor = mix(mix(white, pink, step(0.34, facet)), cyan, step(0.68, facet));
  // A fixed light direction gives each facet its own value as the crystal turns,
  // so the rotation reads. Not a real light: n.l remapped to 0.45..1.
  const lightDir = normalize(vec3(0.4, 0.8, 0.45));
  const facing = saturate(dot(normalize(normalWorld), lightDir));
  const shade = add(0.45, mul(0.55, facing));
  // Per-facet sparkle: each facet breathes on its own phase.
  const sparkle = add(0.8, mul(0.2, sin(add(mul(uTime, 2.4), mul(facet, 40)))));
  // Rim pushes the silhouette toward white so the outline stays crisp on any backdrop.
  const rim = fresnelTerm(2);
  const facetRgb = mul(
    mix(mix(facetColor, cyan, mul(uImmune, 0.6)), white, mul(rim, 0.7)),
    mul(mul(shade, sparkle), mul(flicker, gain * 0.95)),
  );

  const crystalMat = own(new THREE.MeshBasicNodeMaterial());
  crystalMat.side = THREE.DoubleSide;
  crystalMat.colorNode = vec4(facetRgb, 1);
  applyCommon(crystalMat);
  const crystal = new THREE.Mesh(crystalGeo, crystalMat);
  crystal.frustumCulled = false;

  // Edge lattice: every facet edge in near-white. This is the "technical" part of
  // the look and what gives the diamond a crisp outline from far away.
  const edgeGeo = own(new THREE.WireframeGeometry(crystalGeo));
  const edgeMat = own(new THREE.LineBasicNodeMaterial());
  edgeMat.colorNode = vec4(mul(mix(white, cyan, mul(uImmune, 0.5)), mul(flicker, gain * 1.6)), 1);
  applyCommon(edgeMat);
  const edges = new THREE.LineSegments(edgeGeo, edgeMat);
  edges.frustumCulled = false;

  // Nucleus: tiny and absurdly bright. Far above the bloom threshold, so it
  // spills out through the facets as a white-hot centre.
  const nucleusGeo = own(new THREE.IcosahedronGeometry(0.2, 1));
  const nucleusMat = own(new THREE.MeshBasicNodeMaterial());
  nucleusMat.colorNode = vec4(mul(mix(white, white, 0), mul(flicker, gain * 3.5)), 1);
  applyCommon(nucleusMat);
  const nucleus = new THREE.Mesh(nucleusGeo, nucleusMat);
  nucleus.frustumCulled = false;

  // Everything that spins and bobs together lives in one group.
  const body = new THREE.Group();
  body.add(crystal, edges, nucleus);

  // Halo: a camera-facing sprite with a hot core falloff and a faint wide skirt.
  // A sprite (not a mesh) so it always faces the camera without the API needing one.
  const haloR = mul(length(sub(uv(), vec2(0.5, 0.5))), 2);
  const haloFalloff = add(
    mul(pow(oneMinus(saturate(haloR)), 3), 0.9),
    mul(pow(oneMinus(saturate(haloR)), 7), 1.4),
  );
  const haloTint = mix(mix(white, pink, 0.35), cyan, mul(uImmune, 0.6));
  const haloMat = own(new THREE.SpriteNodeMaterial());
  haloMat.colorNode = vec4(mul(haloTint, mul(haloFalloff, mul(flicker, gain * 0.55))), 1);
  applyCommon(haloMat);
  const halo = new THREE.Sprite(haloMat);
  halo.frustumCulled = false;

  // Free-Core finder: a pillar of light from the ground to the Core and a pulsing
  // ground ring, both only visible while the Core is unclaimed. From across an
  // arena the vertical beam is the first thing the eye catches.
  const beamGeo = own(new THREE.CylinderGeometry(0.28, 0.5, 1, 20, 1, true));
  beamGeo.translate(0, 0.5, 0); // base at y=0 so scale.y == height
  // Soft edges: fade where the surface turns away so the pillar has no hard outline.
  const beamViewDir = normalize(sub(cameraPosition, positionWorld));
  const beamSoft = pow(saturate(abs(dot(normalize(normalWorld), beamViewDir))), 1.6);
  const beamY = saturate(positionLocal.y);
  const beamFade = add(mul(pow(oneMinus(beamY), 1.4), 0.9), 0.1);
  const beamMat = own(new THREE.MeshBasicNodeMaterial());
  beamMat.side = THREE.DoubleSide;
  beamMat.colorNode = vec4(
    mul(mix(white, cyan, 0.5), mul(mul(beamSoft, beamFade), mul(uFree, gain * 0.7))),
    1,
  );
  applyCommon(beamMat);
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.frustumCulled = false;
  beam.visible = false;

  const groundGeo = own(new THREE.CircleGeometry(2.4, 40));
  groundGeo.rotateX(-Math.PI / 2);
  const gr = mul(length(sub(uv(), vec2(0.5, 0.5))), 2);
  const pulse = add(0.75, mul(0.25, sin(mul(uTime, 3))));
  const groundDisc = pow(oneMinus(saturate(gr)), 2.2);
  const groundRing = mul(smoothstep(0.08, 0, abs(sub(gr, 0.55))), 1.2);
  const groundMat = own(new THREE.MeshBasicNodeMaterial());
  groundMat.colorNode = vec4(
    mul(
      mix(cyan, white, groundRing),
      mul(mul(add(groundDisc, groundRing), pulse), mul(uFree, gain * 0.8)),
    ),
    1,
  );
  applyCommon(groundMat);
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.frustumCulled = false;
  ground.visible = false;

  // Burst pool ---------------------------------------------------------------
  // Each slot has its own progress uniform and materials, so any number of
  // overlapping waves animate independently. Graphs are built once per slot here.
  const ringGeo = own(new THREE.RingGeometry(0.88, 1, 72));
  ringGeo.rotateX(-Math.PI / 2);
  const shellGeo = own(new THREE.IcosahedronGeometry(1, 2));

  interface BurstSlot {
    ring: THREE.Mesh;
    shell: THREE.Mesh;
    uP: FloatUniform;
    /** Seconds since fired; Infinity when idle. */
    age: number;
  }
  const slots: BurstSlot[] = [];
  for (let i = 0; i < BURST_SLOTS; i++) {
    const uP = uniform(1) as FloatUniform;
    // White at the moment of the steal, cooling to pink then cyan as it fades.
    const waveTint = mix(mix(white, pink, smoothstep(0, 0.45, uP)), cyan, smoothstep(0.4, 1, uP));
    const fade = pow(oneMinus(clamp(uP, 0, 1)), 2);

    const ringMat = own(new THREE.MeshBasicNodeMaterial());
    ringMat.side = THREE.DoubleSide;
    ringMat.colorNode = vec4(mul(waveTint, mul(fade, gain * 2.2)), 1);
    applyCommon(ringMat);

    // Shell is a fresnel skin: bright at the silhouette, see-through face-on, so
    // it reads as an expanding bubble of energy rather than a solid ball.
    const shellMat = own(new THREE.MeshBasicNodeMaterial());
    shellMat.side = THREE.DoubleSide;
    shellMat.colorNode = vec4(
      mul(waveTint, mul(mul(add(0.08, fresnelTerm(2.5)), fade), gain * 1.3)),
      1,
    );
    applyCommon(shellMat);

    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    const shellMesh = new THREE.Mesh(shellGeo, shellMat);
    ringMesh.visible = false;
    shellMesh.visible = false;
    ringMesh.frustumCulled = false;
    shellMesh.frustumCulled = false;
    scene.add(ringMesh, shellMesh);
    slots.push({ ring: ringMesh, shell: shellMesh, uP, age: Infinity });
  }

  scene.add(body, halo, beam, ground);

  // --- per-frame state (all preallocated; update() allocates nothing) ----------
  let free = 0; // smoothed 0..1
  let immune = 0; // smoothed 0..1
  let spin = 0; // accumulated angle, so a changing spin *rate* never causes a jump
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let hasPosition = false;

  function update(state: CoreVisualState, now: number, delta: number): void {
    // Exponential smoothing: identical result at any framerate.
    const k = 1 - Math.exp(-BLEND_RATE * delta);
    free += ((state.carried ? 0 : 1) - free) * k;
    immune += ((state.immune ? 1 : 0) - immune) * k;
    uTime.value = now;
    uImmune.value = immune;
    uFree.value = free;

    cx = state.x;
    cy = state.y;
    cz = state.z;
    hasPosition = true;

    spin += (SPIN_CARRIED + (SPIN_FREE - SPIN_CARRIED) * free) * delta;
    // Bob: bigger and lazier when free, tighter when carried (it already moves with a runner).
    const bob = Math.sin(now * (3.2 - 1.4 * free)) * (0.1 + 0.12 * free);
    const s = 1 + (SCALE_FREE - 1) * free;
    // Breathing pulse, quicker while immune.
    const breathe = 1 + 0.04 * Math.sin(now * (4 + 6 * immune));

    body.position.set(cx, cy + bob, cz);
    body.rotation.set(0.12 * Math.sin(now * 0.9), spin, 0.1 * Math.cos(now * 0.7));
    body.scale.setScalar(s * breathe);
    nucleus.scale.setScalar(1 + 0.15 * Math.sin(now * 7));

    halo.position.set(cx, cy + bob, cz);
    halo.scale.setScalar((3.2 + 3.2 * free) * (1 + 0.06 * Math.sin(now * 2.1)));

    const showFree = free > 0.01;
    beam.visible = showFree;
    ground.visible = showFree;
    if (showFree) {
      const h = Math.max(0.01, cy + bob - GROUND_Y);
      beam.position.set(cx, GROUND_Y, cz);
      beam.scale.set(1, h, 1);
      ground.position.set(cx, GROUND_Y + 0.01, cz);
      ground.scale.setScalar(0.8 + 0.2 * free);
    }

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      if (slot.age === Infinity) continue;
      slot.age += delta;
      const t = slot.age / BURST_SECONDS;
      if (t >= 1) {
        slot.age = Infinity;
        slot.ring.visible = false;
        slot.shell.visible = false;
        continue;
      }
      slot.uP.value = t;
      // Ease-out: the wave leaves fast and lingers at the edge, like a shockwave.
      const e = 1 - (1 - t) * (1 - t) * (1 - t);
      slot.ring.scale.setScalar(0.4 + BURST_RING_RADIUS * e);
      slot.shell.scale.setScalar(0.4 + BURST_SHELL_RADIUS * e);
    }
  }

  function burst(): void {
    // Reuse an idle slot, otherwise recycle the oldest so a rapid chain never stalls.
    let pick = slots[0]!;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      if (slot.age === Infinity) {
        pick = slot;
        break;
      }
      if (slot.age > pick.age || pick.age === Infinity) pick = slot;
    }
    pick.age = 0;
    pick.uP.value = 0;
    // Before the first update there is no position: fire at the origin, not stale garbage.
    const x = hasPosition ? cx : 0;
    const y = hasPosition ? cy : 0;
    const z = hasPosition ? cz : 0;
    pick.ring.position.set(x, y, z);
    pick.shell.position.set(x, y, z);
    pick.ring.scale.setScalar(0.4);
    pick.shell.scale.setScalar(0.4);
    pick.ring.visible = true;
    pick.shell.visible = true;
  }

  function dispose(): void {
    scene.remove(body, halo, beam, ground);
    for (const slot of slots) scene.remove(slot.ring, slot.shell);
    for (const d of disposables) d.dispose();
    disposables.length = 0;
  }

  return { update, burst, dispose };
}
