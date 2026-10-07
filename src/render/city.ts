/**
 * The city
 *
 * Everything that makes a course read as a place rather than as boxes over a
 * void: lit buildings, signs, trees, water towers, traffic, searchlights, the
 * river, bridge cables, a statue. All of it is the `decor` list of a course
 * (shared/course.ts) plus the `building` style for solids, and all of it is
 * visual only -- nothing here is in the physics world.
 *
 * Night-city rules this file follows:
 *
 *   - Light comes from the city, not onto it. Buildings are near-black with a
 *     procedural window grid (a random fraction of windows lit, in the neon
 *     palette) and a vertical gradient, so the skyline is made of light.
 *   - Motion is slow or flowing, never flashing. Traffic streams, searchlights
 *     sweep, signs scroll a scanline; no element blinks faster than ~1 Hz, well
 *     under the 3 Hz photosensitive limit (render/fx.ts).
 *   - Animated things share a handful of materials and draw calls: traffic is
 *     one InstancedMesh per stream, cables are one LineSegments.
 */

import * as THREE from 'three/webgpu';
import {
  abs,
  add,
  floor,
  fract,
  hash,
  mix,
  mul,
  normalWorld,
  positionWorld,
  pow,
  sin,
  smoothstep,
  step,
  sub,
  texture,
  time,
  uv,
  vec3,
} from 'three/tsl';

import type { Course, CourseDecor } from '../shared/course.ts';
import { fxBeat } from './fx.ts';
import { NEON, POST, RACER, RAMP } from './palette.ts';

export interface CityHandle {
  /** Advance traffic, searchlights and spinning props. Real frame delta, seconds. */
  update(dt: number): void;
  dispose(): void;
}

type V3 = THREE.Node<'vec3'>;
const rgb = (hex: number, k = 1): V3 => {
  const c = new THREE.Color(hex);
  return vec3(c.r * k, c.g * k, c.b * k);
};

// ------------------------------------------------------------ building look

/**
 * The lit-building material, shared by every `building` solid and every decor
 * tower.
 *
 * Windows are computed from world position, so any box of any size gets a
 * correctly scaled grid with no UVs or textures: the face's horizontal axis is
 * world X or Z depending on which way it faces, rows are world Y. Each window
 * cell hashes to lit-or-dark and to a colour, which is stable (no flicker) and
 * different on every building. Roofs get no windows.
 */
export function createBuildingMaterial(): THREE.MeshStandardNodeMaterial {
  const facesX = step(0.5, abs(normalWorld.x));
  const roof = step(0.5, abs(normalWorld.y));
  const across = mix(positionWorld.x, positionWorld.z, facesX);
  const up = positionWorld.y;

  // ~0.55 x 0.85 world units per window cell: dense enough that a tower
  // beside the camera still reads as a skyscraper facade, not as blocks.
  const cu = mul(across, 1.8);
  const cv = mul(up, 1.2);
  const fu = fract(cu);
  const fv = fract(cv);
  const pane = mul(mul(step(0.2, fu), step(fu, 0.8)), mul(step(0.25, fv), step(fv, 0.7)));
  const cell = add(add(mul(floor(cu), 17.13), mul(floor(cv), 131.7)), mul(facesX, 7.31));
  const lit = step(0.6, hash(cell));
  const hue = hash(add(cell, 41.7));
  // Mostly cool cyan and pink, a few warm-white windows for life.
  const windowColor = mix(
    mix(rgb(NEON.cyan), rgb(RACER.hotPink, 0.8), step(0.5, hue)),
    rgb(RAMP.cream),
    step(0.88, hue),
  );
  const windows = mul(mul(pane, lit), sub(1, roof));

  const height = smoothstep(-30, 60, positionWorld.y);
  const gradient = mix(rgb(RAMP.deepViolet), mix(rgb(RAMP.purple), rgb(RAMP.pink), smoothstep(0.5, 1, height)), smoothstep(0, 0.5, height));

  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0.35 });
  material.colorNode = mul(gradient, 0.22);
  material.emissiveNode = add(
    mul(gradient, 0.16 * POST.emissiveGain),
    mul(windowColor, mul(windows, 0.85 * POST.emissiveGain)),
  );
  return material;
}

// --------------------------------------------------------------------- city

export function buildCity(
  group: THREE.Group,
  course: Course,
  cube: THREE.BoxGeometry,
  edgeGeometry: THREE.EdgesGeometry,
): CityHandle {
  const own: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(thing: T): T => {
    own.push(thing);
    return thing;
  };
  const updaters: Array<(dt: number) => void> = [];

  const building = keep(createBuildingMaterial());
  const edgeColor = new THREE.Color(RAMP.lightPink).multiplyScalar(POST.edgeGain * 0.7);
  const edgeMat = keep(new THREE.LineBasicNodeMaterial({ toneMapped: false }));
  edgeMat.colorNode = mul(vec3(edgeColor.r, edgeColor.g, edgeColor.b), add(0.75, mul(fxBeat, 0.45)));

  const additive = (colorNode: V3, side: THREE.Side = THREE.FrontSide): THREE.MeshBasicNodeMaterial => {
    const m = keep(new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      side,
    }));
    m.colorNode = colorNode;
    return m;
  };

  const addBox = (x: number, y: number, z: number, w: number, h: number, d: number, yaw = 0): void => {
    const mesh = new THREE.Mesh(cube, building);
    mesh.position.set(x, y, z);
    mesh.scale.set(w, h, d);
    mesh.rotation.y = yaw;
    group.add(mesh);
    const edge = new THREE.LineSegments(edgeGeometry, edgeMat);
    edge.position.copy(mesh.position);
    edge.scale.copy(mesh.scale);
    edge.rotation.copy(mesh.rotation);
    group.add(edge);
  };

  // --- shared geometry ------------------------------------------------------
  const spire = keep(new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1));
  spire.rotateY(Math.PI / 4);
  const spireEdges = keep(new THREE.EdgesGeometry(spire));
  const addSpire = (x: number, baseY: number, z: number, w: number, d: number, h: number): void => {
    const mesh = new THREE.Mesh(spire, building);
    mesh.position.set(x, baseY + h / 2, z);
    mesh.scale.set(w, h, d);
    group.add(mesh);
    const edge = new THREE.LineSegments(spireEdges, edgeMat);
    edge.position.copy(mesh.position);
    edge.scale.copy(mesh.scale);
    group.add(edge);
    // A red aircraft light on every spire tip: the detail that sells a
    // skyline at night. Steady, not blinking.
    const tip = new THREE.Mesh(beaconGeo, beaconMat);
    tip.position.set(x, baseY + h + 0.15, z);
    group.add(tip);
  };
  const beaconGeo = keep(new THREE.SphereGeometry(0.18, 8, 6));
  const beaconMat = additive(rgb(0xff3355, POST.edgeGain * 1.4));

  const ringGeo = keep(new THREE.TorusGeometry(0.5, 0.012, 8, 96));
  ringGeo.rotateX(Math.PI / 2);
  const ringMat = additive(mul(rgb(NEON.cyan, POST.edgeGain), add(0.9, mul(fxBeat, 0.8))));

  const cablePoints: number[] = [];

  for (const item of course.decor) {
    const [x, y, z] = item.position;
    const [w, h, d] = item.size;
    const yaw = THREE.MathUtils.degToRad(item.rotationY ?? 0);

    switch (item.kind) {
      case 'tower':
      case 'block': {
        addBox(x, y, z, w, h, d, yaw);
        if (item.kind === 'tower' && item.cap && item.capHeight) {
          const top = y + h / 2;
          const capH = item.capHeight;
          if (item.cap === 'spire') {
            addSpire(x, top, z, w * 0.9, d * 0.9, capH);
          } else {
            const tiers = [0.78, 0.56, 0.36];
            const tierH = (capH * 0.62) / tiers.length;
            tiers.forEach((k, i) => addBox(x, top + tierH * (i + 0.5), z, w * k, tierH, d * k));
            addSpire(x, top + tierH * tiers.length, z, w * 0.3, d * 0.3, capH * 0.38);
          }
        }
        break;
      }
      case 'ring': {
        for (const k of [1, 1.18]) {
          const mesh = new THREE.Mesh(ringGeo, ringMat);
          mesh.position.set(x, y, z);
          mesh.scale.set(w * k, 1, d * k);
          group.add(mesh);
        }
        break;
      }
      case 'billboard':
        buildBillboard(group, item, keep, additive);
        break;
      case 'tree':
        buildTree(group, item, keep);
        break;
      case 'watertower':
        buildWaterTower(group, item, keep, additive);
        break;
      case 'statue':
        buildStatue(group, item, keep, additive);
        break;
      case 'traffic':
        updaters.push(buildTraffic(group, item, keep, additive));
        break;
      case 'searchlight':
        updaters.push(buildSearchlight(group, item, keep, additive));
        break;
      case 'water':
        buildWater(group, item, keep);
        break;
      case 'ball':
        updaters.push(buildBall(group, item, keep, additive));
        break;
      case 'cable': {
        const [tx, ty, tz] = item.to!;
        cablePoints.push(x, y, z, tx, ty, tz);
        break;
      }
    }
  }

  if (cablePoints.length > 0) {
    const geometry = keep(new THREE.BufferGeometry());
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(cablePoints, 3));
    const material = keep(new THREE.LineBasicNodeMaterial({ toneMapped: false }));
    material.colorNode = rgb(RAMP.lightBlue, POST.edgeGain * 0.9);
    group.add(new THREE.LineSegments(geometry, material));
  }

  return {
    update(dt) {
      for (const tick of updaters) tick(dt);
    },
    dispose() {
      for (const thing of own) thing.dispose();
    },
  };
}

type Keep = <T extends { dispose(): void }>(thing: T) => T;
type Additive = (colorNode: V3, side?: THREE.Side) => THREE.MeshBasicNodeMaterial;

// ---------------------------------------------------------------- billboard

/** A sign's copy drawn once into a canvas: neon text, a frame, scanlines. */
function signTexture(text: string, hex: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#05030a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Scanlines: the holographic texture.
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (let yy = 0; yy < canvas.height; yy += 6) ctx.fillRect(0, yy, canvas.width, 2);
    ctx.strokeStyle = hex;
    ctx.lineWidth = 6;
    ctx.strokeRect(14, 14, canvas.width - 28, canvas.height - 28);
    ctx.font = '800 150px "Barlow Condensed", ui-sans-serif, "Helvetica Neue", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = hex;
    ctx.shadowBlur = 40;
    ctx.fillStyle = hex;
    ctx.fillText(text.toUpperCase(), canvas.width / 2, canvas.height / 2 + 8);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.55;
    ctx.fillText(text.toUpperCase(), canvas.width / 2, canvas.height / 2 + 8);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildBillboard(group: THREE.Group, item: CourseDecor, keep: Keep, additive: Additive): void {
  const [x, y, z] = item.position;
  const [w, h] = item.size;
  const hex = item.color ?? '#ff2fb9';
  const tex = keep(signTexture(item.text ?? '', hex));
  const plane = keep(new THREE.PlaneGeometry(1, 1));
  // A bright scanline that rolls down the sign once every ~3 seconds, plus a
  // gentle breathing on the beat. Nothing here strobes.
  const roll = pow(sub(1, abs(sub(fract(sub(uv().y, mul(time, 0.33))), 0.5)).mul(2)), 18);
  const sample = texture(tex, uv()).rgb;
  const material = additive(
    mul(add(sample, mul(sample, mul(roll, 1.2))), add(0.85, mul(fxBeat, 0.25))).mul(1.3) as unknown as V3,
    THREE.FrontSide,
  );
  // Two faces back to back rather than one double-sided plane: a
  // double-sided plane shows its text mirrored from behind, and signs here are
  // seen from every side.
  const yaw = THREE.MathUtils.degToRad(item.rotationY ?? 0);
  for (const flip of [0, Math.PI]) {
    const mesh = new THREE.Mesh(plane, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(w, h, 1);
    mesh.rotation.y = yaw + flip;
    group.add(mesh);
  }
}

// --------------------------------------------------------------------- tree

function buildTree(group: THREE.Group, item: CourseDecor, keep: Keep): void {
  const [x, y, z] = item.position;
  const [w, h, d] = item.size;
  const geo = keep(new THREE.IcosahedronGeometry(0.5, 0));
  const edges = keep(new THREE.EdgesGeometry(geo));
  const leafHex = item.color ? new THREE.Color(item.color).getHex() : 0x2effa8;
  const material = keep(new THREE.MeshStandardNodeMaterial({ roughness: 0.6, flatShading: true }));
  material.colorNode = rgb(leafHex, 0.12);
  material.emissiveNode = mul(rgb(leafHex, 0.22 * POST.emissiveGain), add(0.8, mul(fxBeat, 0.3)));
  const line = keep(new THREE.LineBasicNodeMaterial({ toneMapped: false }));
  line.colorNode = rgb(leafHex, POST.edgeGain * 0.9);
  // Two stacked crowns: low-poly, but a tree, not a gem.
  for (const [k, dy] of [[1, 0], [0.7, h * 0.42]] as const) {
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y + dy, z);
    mesh.scale.set(w * k, h * 0.7 * k, d * k);
    mesh.rotation.y = (x * 13.7 + z * 7.1) % Math.PI;
    group.add(mesh);
    const edge = new THREE.LineSegments(edges, line);
    edge.position.copy(mesh.position);
    edge.scale.copy(mesh.scale);
    edge.rotation.copy(mesh.rotation);
    group.add(edge);
  }
}

// ---------------------------------------------------------------- water tower

function buildWaterTower(group: THREE.Group, item: CourseDecor, keep: Keep, additive: Additive): void {
  const [x, y, z] = item.position;
  const [w, h] = item.size;
  const r = w / 2;
  const tankH = h * 0.55;
  const legH = h * 0.25;
  const dark = keep(new THREE.MeshStandardNodeMaterial({ roughness: 0.8 }));
  dark.colorNode = rgb(RAMP.charcoal);
  dark.emissiveNode = rgb(RAMP.deepViolet, 0.25);
  const base = y - h / 2;

  const tank = keep(new THREE.CylinderGeometry(r, r, tankH, 16));
  const tankMesh = new THREE.Mesh(tank, dark);
  tankMesh.position.set(x, base + legH + tankH / 2, z);
  group.add(tankMesh);
  const roof = keep(new THREE.ConeGeometry(r * 1.05, h - tankH - legH, 16));
  const roofMesh = new THREE.Mesh(roof, dark);
  roofMesh.position.set(x, base + legH + tankH + (h - tankH - legH) / 2, z);
  group.add(roofMesh);
  // Neon hoops around the tank: the silhouette at night.
  const hoop = keep(new THREE.TorusGeometry(r * 1.02, 0.04, 6, 32));
  hoop.rotateX(Math.PI / 2);
  const hoopMat = additive(rgb(NEON.cyan, POST.edgeGain));
  for (const k of [0.15, 0.5, 0.85]) {
    const ring = new THREE.Mesh(hoop, hoopMat);
    ring.position.set(x, base + legH + tankH * k, z);
    group.add(ring);
  }
  const leg = keep(new THREE.BoxGeometry(0.15, legH, 0.15));
  for (const [lx, lz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const m = new THREE.Mesh(leg, dark);
    m.position.set(x + lx! * r * 0.7, base + legH / 2, z + lz! * r * 0.7);
    group.add(m);
  }
}

// ------------------------------------------------------------------ statue

/**
 * Liberty, in neon: a pedestal, a draped body, head and crown, the raised arm
 * and the torch. Stylised from a handful of primitives and outlined, because
 * from across the harbour a silhouette is all anyone reads.
 */
function buildStatue(group: THREE.Group, item: CourseDecor, keep: Keep, additive: Additive): void {
  const [x, y, z] = item.position;
  const H = item.size[1];
  const base = y - H / 2;
  const mint = 0x5dffd2;
  const body = keep(new THREE.MeshStandardNodeMaterial({ roughness: 0.6, flatShading: true }));
  body.colorNode = rgb(mint, 0.08);
  body.emissiveNode = rgb(mint, 0.18 * POST.emissiveGain);
  const line = keep(new THREE.LineBasicNodeMaterial({ toneMapped: false }));
  line.colorNode = rgb(mint, POST.edgeGain);

  const part = (geo: THREE.BufferGeometry, px: number, py: number, pz: number, rz = 0): void => {
    keep(geo);
    const mesh = new THREE.Mesh(geo, body);
    mesh.position.set(x + px, base + py, z + pz);
    mesh.rotation.z = rz;
    mesh.rotation.y = THREE.MathUtils.degToRad(item.rotationY ?? 0);
    group.add(mesh);
    const e = keep(new THREE.EdgesGeometry(geo, 20));
    const edge = new THREE.LineSegments(e, line);
    edge.position.copy(mesh.position);
    edge.rotation.copy(mesh.rotation);
    group.add(edge);
  };
  const ped = H * 0.38;
  part(new THREE.BoxGeometry(H * 0.32, ped, H * 0.32), 0, ped / 2, 0);
  part(new THREE.CylinderGeometry(H * 0.07, H * 0.12, H * 0.38, 7), 0, ped + H * 0.19, 0);
  part(new THREE.SphereGeometry(H * 0.045, 8, 6), 0, ped + H * 0.43, 0);
  // Crown spikes.
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI - Math.PI / 2;
    part(new THREE.ConeGeometry(H * 0.008, H * 0.05, 4), Math.sin(a) * H * 0.045, ped + H * 0.47, 0, -a * 0.9);
  }
  // Raised right arm and torch.
  part(new THREE.CylinderGeometry(H * 0.018, H * 0.022, H * 0.2, 6), H * 0.07, ped + H * 0.47, 0, -0.25);
  part(new THREE.ConeGeometry(H * 0.03, H * 0.05, 6), H * 0.095, ped + H * 0.58, 0, Math.PI);
  const flame = new THREE.Mesh(keep(new THREE.SphereGeometry(H * 0.03, 10, 8)), additive(rgb(0xffb347, POST.edgeGain * 1.6)));
  flame.position.set(x + H * 0.095, base + ped + H * 0.62, z);
  group.add(flame);
}

// ----------------------------------------------------------------- traffic

/**
 * Two lanes of car lights flowing in opposite directions along the box's long
 * horizontal axis: white headlights one way, red tail lights the other. Seen
 * through the gaps between the skyways, this is the city still running below.
 */
function buildTraffic(group: THREE.Group, item: CourseDecor, keep: Keep, additive: Additive): (dt: number) => void {
  const [x, y, z] = item.position;
  const [w, , d] = item.size;
  const alongX = w >= d;
  const length = alongX ? w : d;
  const width = alongX ? d : w;
  const count = Math.round(item.count ?? 24);

  const car = keep(new THREE.BoxGeometry(alongX ? 1.1 : 0.35, 0.18, alongX ? 0.35 : 1.1));
  const lanes = [
    { mat: additive(rgb(RAMP.white, POST.edgeGain * 1.2)), dir: 1, offset: -width * 0.22 },
    { mat: additive(rgb(0xff2a4a, POST.edgeGain * 1.2)), dir: -1, offset: width * 0.22 },
  ];
  const meshes = lanes.map((lane) => {
    const mesh = new THREE.InstancedMesh(car, lane.mat, Math.ceil(count / 2));
    mesh.frustumCulled = false;
    group.add(mesh);
    return { mesh, lane };
  });
  // Deterministic per-car phase and speed, so every client sees the same flow.
  const phases = Array.from({ length: count }, (_, i) => ((i * 0.6180339) % 1) * length);
  const speeds = Array.from({ length: count }, (_, i) => 9 + ((i * 7) % 5) * 1.5);
  const m = new THREE.Matrix4();
  let t = 0;

  return (dt) => {
    t += dt;
    meshes.forEach(({ mesh, lane }, li) => {
      for (let i = 0; i < mesh.count; i++) {
        const k = i * 2 + li;
        const s = ((phases[k]! + t * speeds[k]! * lane.dir) % length + length) % length - length / 2;
        if (alongX) m.makeTranslation(x + s, y, z + lane.offset);
        else m.makeTranslation(x + lane.offset, y, z + s);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    });
  };
}

// ------------------------------------------------------------- searchlight

function buildSearchlight(group: THREE.Group, item: CourseDecor, keep: Keep, additive: Additive): (dt: number) => void {
  const [x, y, z] = item.position;
  const reach = item.size[1];
  const geo = keep(new THREE.CylinderGeometry(item.size[0], 0.25, reach, 20, 1, true));
  geo.translate(0, reach / 2, 0);
  const hex = item.color ? new THREE.Color(item.color).getHex() : RAMP.lightBlue;
  // Bright at the root, gone at the far end.
  const fade = pow(sub(1, uv().y), 1.6);
  // Faint on purpose: a searchlight is air catching light, not a solid. Any
  // brighter and the beams read as glowing planks across the sky.
  const material = additive(mul(rgb(hex, 0.06 * POST.edgeGain), pow(fade, 1.5)), THREE.DoubleSide);
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);
  const beam = new THREE.Mesh(geo, material);
  beam.rotation.z = 0.42; // lean out from vertical
  pivot.add(beam);
  pivot.rotation.y = (x * 0.37 + z * 0.11) % (Math.PI * 2);
  group.add(pivot);
  const speed = 0.22 + ((Math.abs(x + z) * 0.013) % 0.15);
  return (dt) => {
    pivot.rotation.y += speed * dt;
  };
}

// ------------------------------------------------------------------- water

function buildWater(group: THREE.Group, item: CourseDecor, keep: Keep): void {
  const [x, y, z] = item.position;
  const [w, , d] = item.size;
  const plane = keep(new THREE.PlaneGeometry(1, 1, 1, 1));
  plane.rotateX(-Math.PI / 2);
  // Long, slow neon reflections drifting across black water, plus a faint
  // grid so it reads as a surface at all.
  const px = positionWorld.x;
  const pz = positionWorld.z;
  const wave = sin(add(add(mul(px, 0.08), mul(time, 0.35)), mul(sin(add(mul(pz, 0.05), mul(time, 0.2))), 2.5)));
  const streak = pow(add(mul(wave, 0.5), 0.5), 14);
  const tone = mix(rgb(NEON.cyan), rgb(RACER.hotPink, 0.8), add(mul(sin(add(mul(pz, 0.03), 1.7)), 0.5), 0.5));
  const grid = mul(
    add(step(0.97, fract(mul(px, 0.1))), step(0.97, fract(mul(pz, 0.1)))),
    0.06,
  );
  const material = keep(new THREE.MeshBasicNodeMaterial({ toneMapped: false }));
  material.colorNode = add(rgb(0x02030a), mul(tone, add(mul(streak, 0.55 * POST.emissiveGain), grid)));
  const mesh = new THREE.Mesh(plane, material);
  mesh.position.set(x, y, z);
  mesh.scale.set(w, 1, d);
  group.add(mesh);
}

// -------------------------------------------------------------------- ball

function buildBall(group: THREE.Group, item: CourseDecor, keep: Keep, additive: Additive): (dt: number) => void {
  const [x, y, z] = item.position;
  const r = item.size[0] / 2;
  const geo = keep(new THREE.IcosahedronGeometry(r, 1));
  const material = keep(new THREE.MeshStandardNodeMaterial({ roughness: 0.2, metalness: 0.6, flatShading: true }));
  material.colorNode = rgb(RAMP.white, 0.3);
  // Facets glint in turn as it spins: crystal, not a lamp.
  const glint = pow(fract(add(mul(positionWorld.y, 1.3), mul(time, 0.4))), 6);
  material.emissiveNode = mul(mix(rgb(RAMP.lightPink), rgb(RAMP.lightBlue), glint), add(0.35, mul(glint, 0.9)));
  const ball = new THREE.Mesh(geo, material);
  ball.position.set(x, y, z);
  group.add(ball);
  const edges = new THREE.LineSegments(keep(new THREE.EdgesGeometry(geo)), keep(new THREE.LineBasicNodeMaterial({ toneMapped: false })));
  (edges.material as THREE.LineBasicNodeMaterial).colorNode = rgb(RAMP.white, POST.edgeGain);
  ball.add(edges);
  const halo = new THREE.Mesh(keep(new THREE.SphereGeometry(r * 1.6, 16, 12)), additive(rgb(RACER.hotPink, 0.05 * POST.edgeGain), THREE.BackSide));
  halo.position.copy(ball.position);
  group.add(halo);
  return (dt) => {
    ball.rotation.y += 0.35 * dt;
  };
}
