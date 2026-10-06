/**
 * Far-field architecture
 *
 * Two layers of set dressing behind the lane:
 *
 *   - `SKYLINE`   — monumental towers on the horizon, one draw call
 *   - `PLATFORMS` — cut shapes stacked beside the lane, one draw call per shape
 *
 * Client-only and entirely non-interactive. Nothing here is in the physics
 * world, nothing is collidable, and nothing feeds back into the simulation.
 *
 * Both layers are instanced over unit primitives, so the whole environment is six
 * draw calls regardless of how many objects are in it. All six share a single
 * material, which means one shader program rather than six — the per-instance
 * variation rides in on instanced attributes instead.
 *
 * **The platforms are the risk in this file.** They have no collider, so anything
 * the player can physically reach they will fall straight through. Their
 * placement is therefore derived from the player's jump arc, not chosen by eye —
 * see the arithmetic on `PLATFORMS.nearX`. Do not move them inward without
 * redoing that.
 *
 * All the tunable numbers live in `palette.ts` alongside the rest of the art
 * direction. This file is mechanism only.
 */

import * as THREE from 'three/webgpu';
import {
  attribute,
  clamp,
  mix,
  mul,
  oneMinus,
  positionWorld,
  smoothstep,
  vertexColor,
} from 'three/tsl';

import { GRADIENT, PLATFORMS, SHAPES, SHAPE_CYCLE, SKYLINE, type ShapeName } from './palette.ts';

export interface FarField {
  /** Towers and platforms together. Add this one thing to the scene. */
  readonly group: THREE.Group;
  dispose(): void;
}

/**
 * Tower body colour.
 *
 * Darker than the course's mass and with no tint of its own, so the towers sit
 * behind the lane rather than competing with it. Lit only by the scene's rim
 * lights, which graze their vertical faces, and that is the entire reason they
 * read as architecture instead of as black cut-outs.
 *
 * A local constant rather than a palette entry because it is not a brand colour
 * — it is the absence of one, and nothing on the HUD ever refers to it.
 */
const TOWER_BODY = 0x08090f;

/**
 * Where a tower's lit crown sits, as fractions of its own height.
 *
 * Normalised per tower rather than against a global max, because the heights
 * span 54–190m: against a global max, the short towers would fall entirely below
 * the lit band and never light at all.
 *
 * The band is the upper third. Lit crown over dark mass is what makes a skyline
 * read as a city at night; lighting a whole tower just makes a glowing slab.
 */
const CROWN_LOW = 0.66;
const CROWN_HIGH = 0.97;

/** One placed instance, before it is written into an instanced buffer. */
interface Placed {
  x: number;
  y: number;
  z: number;
  /** Scale applied to the unit primitive. */
  sx: number;
  sy: number;
  sz: number;
  /** Rotation about Y, radians. */
  yaw: number;
  /** Pastel this instance's gradient tops out at. */
  pastel: number;
}

/**
 * Build the whole far field.
 *
 * Returns a group rather than a mesh so callers have one thing to add and one
 * thing to dispose of, and so adding a seventh shape later does not change the
 * signature.
 */
export function buildFarField(): FarField {
  const group = new THREE.Group();
  group.name = 'far-field';

  const towers = buildTowers();
  const platforms = buildPlatforms();

  group.add(towers.mesh);
  for (const p of platforms) group.add(p.mesh);

  return {
    group,
    dispose() {
      towers.dispose();
      for (const p of platforms) p.dispose();
    },
  };
}

/**
 * Monumental towers on the horizon.
 *
 * Heights come from `SKYLINE.heights` and are indexed by instance number, so the
 * rhythm repeats down the band rather than varying randomly. Every placement is
 * a pure function of the index — no RNG anywhere, because two players in the
 * same race have to be looking at the same city.
 */
function buildTowers(): { mesh: THREE.InstancedMesh; dispose(): void } {
  const geometry = new THREE.BoxGeometry(1, 1, 1);

  // Per-instance crown colour (rgb) and lit mask (a).
  //
  // Deliberately *not* `mesh.instanceColor`: that path multiplies the diffuse
  // surface, which would tint the tower body, and the body is supposed to stay a
  // silhouette. This one only ever drives emissive.
  const tint = new THREE.InstancedBufferAttribute(
    new Float32Array(SKYLINE.count * 4),
    4,
  );

  // Per-instance total height, so the crown band can be a proportion of each
  // tower rather than an absolute world-space slice.
  const topY = new THREE.InstancedBufferAttribute(
    new Float32Array(SKYLINE.count),
    1,
  );

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(TOWER_BODY),
    roughness: 0.95,
    metalness: 0,
  });

  const tintAttr = attribute('instanceTint', 'vec4');
  const topAttr = attribute('instanceTopY', 'float');

  // Emissive = per-tower tint, gated by (is this tower lit) x (are we inside its
  // crown band).
  //
  // `mix` up from black rather than multiplying the tint by the mask: TSL's `mul`
  // has no overload accepting a `Node<"color">`, and the mix states the intent
  // more directly — a lit crown is a lerp from unlit black up to the crown
  // colour, not a tint applied to a surface.
  const lit = clamp(tintAttr.w, 0, 1);
  const band = oneMinus(
    smoothstep(topAttr.mul(CROWN_LOW), topAttr.mul(CROWN_HIGH), positionWorld.y),
  );
  material.emissiveNode = mul(mix(0.0, tintAttr.rgb, mul(lit, band)), SKYLINE.crownGain);

  const mesh = new THREE.InstancedMesh(geometry, material, SKYLINE.count);
  mesh.frustumCulled = false;

  const dummy = new THREE.Object3D();
  const scratch = new THREE.Color();

  for (let i = 0; i < SKYLINE.count; i++) {
    const side = i % 2 === 0 ? -1 : 1;

    // March the band down the lane's axis so the towers recede with it, then
    // push them out sideways. Depth is stepped by a stride coprime with the band
    // width rather than sampled continuously, which spreads towers evenly across
    // the distance range instead of clumping them at both edges.
    const along = (i / SKYLINE.count - 0.5) * SKYLINE.span;
    const depth = SKYLINE.near + ((i * 37) % (SKYLINE.far - SKYLINE.near));
    const height = SKYLINE.heights[i % SKYLINE.heights.length]!;

    dummy.position.set(side * depth, height / 2, along);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(SKYLINE.width, height, SKYLINE.depth);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);

    const litCrown = i % Math.round(1 / SKYLINE.litRatio) === 0 ? 1 : 0;

    scratch.setHex(SKYLINE.crownTints[i % SKYLINE.crownTints.length]!);
    tint.setXYZW(i, scratch.r, scratch.g, scratch.b, litCrown);
    topY.setX(i, height);
  }

  mesh.instanceMatrix.needsUpdate = true;
  tint.needsUpdate = true;
  topY.needsUpdate = true;

  // Attaching under these exact names is what `attribute()` above resolves
  // against. If either name is wrong the shader reads zero — invisible rather
  // than fatal, which is the worst kind of failure to notice by reading code.
  geometry.setAttribute('instanceTint', tint);
  geometry.setAttribute('instanceTopY', topY);

  return {
    mesh,
    dispose() {
      geometry.deleteAttribute('instanceTint');
      geometry.deleteAttribute('instanceTopY');
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}

/**
 * Sample the gradient ramp, writing **linear** RGB into `out`.
 *
 * Runs on the CPU, once per vertex, at build time. `THREE.Color` converts
 * sRGB -> linear on construction when colour management is on, so reading
 * `.r/.g/.b` straight afterwards gives the linear triple — which is what a
 * `color` vertex attribute is expected to hold, and what the shader's
 * emissive term wants.
 *
 * Interpolation is on the linear values, not on sRGB. Interpolating in sRGB
 * between two pastels bows the midpoint lighter and washes the hue out.
 */
function sampleRamp(t: number, out: THREE.Color): THREE.Color {
  const stops = GRADIENT.stops as readonly { at: number; color: number }[];
  const k = Math.min(Math.max(t, 0), 1);

  let lo = stops[0]!;
  let hi = stops[stops.length - 1]!;
  for (let i = 1; i < stops.length; i++) {
    if (k <= stops[i]!.at) {
      lo = stops[i - 1]!;
      hi = stops[i]!;
      break;
    }
  }

  const span = hi.at - lo.at;
  const f = span > 0 ? Math.min(Math.max((k - lo.at) / span, 0), 1) : 0;

  const a = _rampA.setHex(lo.color);
  const b = _rampB.setHex(hi.color);
  return out.setRGB(
    a.r + (b.r - a.r) * f,
    a.g + (b.g - a.g) * f,
    a.b + (b.b - a.b) * f,
  );
}

/** Scratch colours for `sampleRamp`. Not reentrant; build time only. */
const _rampA = new THREE.Color();
const _rampB = new THREE.Color();

/**
 * Bake the gradient into a geometry's `color` attribute.
 *
 * The ramp is baked against the **unit primitive's own** bounding box, so it is
 * one set of colours per silhouette and every instance of that silhouette shares
 * it. That is deliberate: it means the gradient is a property of the shape rather
 * than of the instance, so a 1.2m plate and a 24m column show the same ramp in
 * proportion without either one needing its own geometry.
 *
 * Per-fragment it interpolates smoothly across each face. Per-vertex it means a
 * box only gets a gradient at its four corners per face — flat-shaded sides and
 * a hard band across the top face. On the thin shapes that reads as a crisp
 * two-tone, which suits the art direction; on the tall columns it is smooth
 * enough because there are enough segments vertically to carry it.
 */
function paintGradient(geometry: THREE.BufferGeometry): void {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const position = geometry.getAttribute('position');
  if (!box) return;

  // Normalise against the primitive's own extent. Box and cylinder are 1 unit tall
  // and centred, so their Y runs -0.5..0.5; the octahedron is radius 1, so -1..1.
  // Using the bounding box rather than assuming either is what lets all three
  // silhouettes share this function.
  const yLo = box.min.y;
  const span = Math.max(box.max.y - yLo, 1e-6);

  const colors = new Float32Array(position.count * 3);
  const scratch = new THREE.Color();

  for (let i = 0; i < position.count; i++) {
    sampleRamp((position.getY(i) - yLo) / span, scratch);
    colors[i * 3] = scratch.r;
    colors[i * 3 + 1] = scratch.g;
    colors[i * 3 + 2] = scratch.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/**
 * One material shared by every platform shape.
 *
 * Five meshes on one material means one shader program rather than five.
 *
 * **The whole surface treatment is two standard three.js mechanisms and one
 * trivial TSL node:**
 *
 *     emissive  <- vertexColor() x GRADIENT.emissiveGain   (one node)
 *     diffuse   <- instanceColor, the platform's own pastel
 *
 * `instanceColor` is multiplied into the diffuse term by three itself
 * (`NodeMaterial.setupDiffuseColor`), and `vertexColor()` is three's own accessor
 * for a `color` attribute. Neither is doing anything unusual, which is the point:
 * the previous version of this material computed its gradient per fragment from
 * world-space position and two custom instanced attributes, and rendered black.
 *
 * `material.vertexColors` stays **false** even though the geometry carries a
 * `color` attribute — that flag would multiply the ramp into the diffuse as well,
 * and multiplying the ramp by the instance pastel compounds two mid-tones into
 * something much darker. The ramp is meant for the emissive term only; the
 * diffuse carries flat per-instance colour.
 */
function platformMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.74,
    metalness: 0.06,
  });

  material.emissiveNode = mul(vertexColor(), GRADIENT.emissiveGain);

  return material;
}

/**
 * The platform shapes, grouped by silhouette.
 *
 * One `InstancedMesh` per shape because an `InstancedMesh` is bound to a single
 * geometry — there is no per-instance geometry swap. Five shapes is therefore
 * five draw calls, which is the real cost of the variety and is worth it: five
 * silhouettes in six draw calls is cheaper than the alternative, which is 24
 * individual meshes and 24 draw calls.
 */
function buildPlatforms(): { mesh: THREE.InstancedMesh; dispose(): void }[] {
  const material = platformMaterial();
  const placements = placePlatforms();

  const buckets = new Map<ShapeName, Placed[]>();
  for (const name of SHAPE_CYCLE) buckets.set(name, []);
  for (const p of placements) buckets.get(p.shape)!.push(p);

  const out: { mesh: THREE.InstancedMesh; dispose(): void }[] = [];
  const dummy = new THREE.Object3D();
  const scratch = new THREE.Color();

  for (const [name, items] of buckets) {
    if (items.length === 0) continue;

    const spec = SHAPES[name];
    const geometry = makeGeometry(name, spec);

    // Bake the pastel gradient into the geometry as a standard `color`
    // attribute. Once per silhouette, not once per instance — the ramp belongs to
    // the shape, so every platform of this shape shares these vertex colours.
    paintGradient(geometry);

    const mesh = new THREE.InstancedMesh(geometry, material, items.length);
    mesh.frustumCulled = false;

    for (let i = 0; i < items.length; i++) {
      const p = items[i]!;

      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, p.yaw, 0);
      dummy.scale.set(p.sx, p.sy, p.sz);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      // The platform's own pastel, into the diffuse term, on three's own
      // instanced-colour path. `setColorAt` allocates `instanceColor` on first
      // call and converts sRGB -> linear for us, since `scratch` is a Color.
      scratch.setHex(p.pastel);
      mesh.setColorAt(i, scratch);
    }

    mesh.instanceMatrix.needsUpdate = true;
    // `setColorAt` allocates the buffer lazily, so this cannot be assumed set.
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    out.push({
      mesh,
      dispose() {
        geometry.deleteAttribute('color');
        geometry.dispose();
        mesh.dispose();
      },
    });
  }

  return out;
}

/**
 * The geometry primitive a shape is cut from.
 *
 * Read off `SHAPES` rather than re-declared, so adding a `kind` there without
 * handling it in `makeGeometry` is a type error rather than a shape that silently
 * fails to appear.
 */
type ShapeKind = (typeof SHAPES)[ShapeName]['kind'];

/**
 * Build the unit primitive for a shape.
 *
 * All three are centred on the origin, which `placePlatforms` relies on when it
 * writes world-space bounds from the instance scale. If any of them is ever
 * authored off-origin the gradient will slide, and the fix belongs here rather
 * than in the placement math.
 */
function makeGeometry(name: ShapeName, spec: (typeof SHAPES)[ShapeName]): THREE.BufferGeometry {
  // Copied to a local before switching. Narrowing `spec` directly makes the
  // default branch `never` as a *whole object*, and then reading `spec.kind`
  // inside it is an error — the discriminant has to be narrowed on its own.
  const kind: ShapeKind = spec.kind;

  switch (kind) {
    case 'box':
      return new THREE.BoxGeometry(1, 1, 1);
    case 'cyl':
      // `in` narrows the union without a cast, and keeps `segments` an error
      // rather than an `undefined` if a future cyl shape forgets to set it.
      return new THREE.CylinderGeometry(
        1,
        1,
        1,
        'segments' in spec ? spec.segments : 16,
        1,
      );
    case 'octa':
      return new THREE.OctahedronGeometry(1, 0);
    default: {
      // Exhaustiveness guard: adding a `kind` to SHAPES without handling it here
      // stops compiling.
      const exhaustive: never = kind;
      throw new Error(`unhandled shape kind for "${name}": ${String(exhaustive)}`);
    }
  }
}

/** A placement, tagged with which silhouette it uses. */
type PlacedShape = Placed & { shape: ShapeName };

/**
 * Where every platform goes.
 *
 * Pure function of the index — no RNG, for the same reason the towers have none:
 * two players in the same race must be looking at the same city.
 *
 * Placement is a stepped pyramid rather than a scatter. Each tier sits further
 * out laterally than the one below it, so the stack reads as built architecture
 * stepping away from the track. Random lateral placement gives the same object
 * count and none of the structure.
 *
 * Tiers are staggered by half a slot along Z so the three heights do not line up
 * into columns — aligned tiers read as a grid, staggered ones read as depth.
 */
function placePlatforms(): PlacedShape[] {
  const tiers = PLATFORMS.tiers;
  const lateralSpread = PLATFORMS.farX - PLATFORMS.nearX;

  const out: PlacedShape[] = [];

  for (let t = 0; t < tiers.length; t++) {
    const tier = tiers[t]!;

    for (let s = 0; s < PLATFORMS.perTier; s++) {
      const i = t * PLATFORMS.perTier + s;
      const shape = SHAPE_CYCLE[i % SHAPE_CYCLE.length]!;
      const spec = SHAPES[shape];
      const side = i % 2 === 0 ? -1 : 1;

      // Half-slot stagger per tier. Without it the three heights line up into
      // columns and the stack reads as a grid.
      const slot = (s + t * 0.5) / PLATFORMS.perTier - 0.5;
      const z = slot * PLATFORMS.span;

      // Each tier steps further out than the one below, plus a small per-slot
      // jitter so the faces are not all coplanar.
      const lateral =
        PLATFORMS.nearX + (t * lateralSpread) / tiers.length + ((i * 29) % 11);

      // Jittered scale. Deterministic, and derived from the index so it does not
      // need an RNG or a seed to reproduce.
      const j = PLATFORMS.jitter;
      const jy = 1 + ((((i * 17) % 100) / 100) * 2 - 1) * j;
      const sx = spec.size[0] * (1 + ((((i * 23) % 100) / 100) * 2 - 1) * j);
      const sy = spec.size[1] * jy;
      const sz = spec.size[2] * (1 + ((((i * 31) % 100) / 100) * 2 - 1) * j);

      // Centre the instance so its *base* sits at the tier height. Without this
      // the taller shapes would sink by half their height and the tiers would
      // read as intersecting rather than stacked.
      const y = tier.y + sy / 2;

      // Only the flat and round silhouettes get rotated. A rotated cube reads as
      // a mistake, and a rotated octahedron gains nothing — its facets are
      // already asymmetric enough.
      const yaw =
        shape === 'slab' || shape === 'puck'
          ? (((i * 41) % 100) / 100) * 2 * PLATFORMS.yaw - PLATFORMS.yaw
          : 0;

      out.push({ shape, x: side * lateral, y, z, sx, sy, sz, yaw, pastel: tier.color });
    }
  }

  return out;
}
