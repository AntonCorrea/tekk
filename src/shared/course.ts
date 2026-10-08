/**
 * Course definition format
 *
 * A course is plain JSON so the exact same file can be imported by the
 * client and read from disk by the server. Nothing in this module may
 * import Three.js or touch the DOM — the server imports it too.
 *
 * Deliberately minimal: a field the engine does not implement is a promise
 * the format cannot keep. Every field here has behaviour behind it --
 * `rotation` (ramps), `pads` (boost and jump, in the shared sim) and `decor`
 * (visual only, never simulated) were each added together with the code
 * that honours them.
 */

export type Vec3 = [number, number, number];

/**
 * An object-shaped 3-vector, matching the shape Rapier and Three.js use.
 *
 * Separate from `Vec3` on purpose: course JSON is authored as arrays
 * because they read better in a data file and are trivial to validate,
 * but everything crossing into the engine wants `{x, y, z}`.
 */
export interface Vec3Tuple {
  x: number;
  y: number;
  z: number;
}

export function toVec3Tuple(v: Vec3): Vec3Tuple {
  return { x: v[0], y: v[1], z: v[2] };
}

/** Only one primitive today. The tag exists so adding more is not a breaking change. */
export type SolidKind = 'box';

export interface CourseSolid {
  id: string;
  kind: SolidKind;
  /** Centre of the box. */
  position: Vec3;
  /** Full extents along each axis, not half-extents. */
  size: Vec3;
  /** `#rrggbb`. Omit for the course default. */
  color?: string;
  /**
   * Euler rotation in DEGREES, applied X then Y then Z (Three's default
   * order), about the box centre. This is what makes ramps. Omit for an
   * axis-aligned box -- which is what almost everything should be, because
   * the ground probe used for respawns only understands unrotated boxes.
   */
  rotation?: Vec3;
  /**
   * Visual style only -- physics never reads it. `building` renders the box as
   * a lit city building (window grid, neon gradient) instead of the dark mass
   * the walkable decks use.
   */
  style?: 'building';
}

/**
 * A pad is a trigger volume with an effect, resolved inside the SHARED step
 * (shared/sim.ts) so the client predicts it exactly like the server.
 *
 *   boost -- sets horizontal velocity to `direction` at boost speed and holds
 *            a boosted top speed for a moment after leaving the pad.
 *   jump  -- launches a grounded racer straight up, much higher than a jump.
 */
export type PadKind = 'boost' | 'jump';

export interface CoursePad {
  id: string;
  kind: PadKind;
  /** Centre of the trigger volume. Sit it on a surface, a little proud of it. */
  position: Vec3;
  /** Full extents of the trigger volume. */
  size: Vec3;
  /** Boost only: horizontal direction [x, z], normalised on parse. */
  direction?: [number, number];
}

/**
 * Scenery. Rendered by the client, ignored by the server and the simulation:
 * nothing here collides. So it must never sit where a racer can walk, or
 * people will run through what looks like a wall.
 *
 *   tower -- a box building, optionally capped with a `spire` (a four-sided
 *            point, One World Trade style) or `stepped` setbacks (Chrysler
 *            style). `capHeight` is the cap's height above the box.
 *   ring  -- a flat glowing ring; `size[0]` is its diameter.
 *   block -- a plain floating box.
 *   billboard  -- a holographic sign showing `text`, facing `rotationY`.
 *   tree       -- a low-poly neon tree canopy (pair it with a solid trunk).
 *   watertower -- the classic New York rooftop tank (pair with a solid base).
 *   statue     -- a neon Statue of Liberty, `size[1]` tall.
 *   traffic    -- a stream of `count` car lights flowing along the box's long
 *                 horizontal axis, both directions.
 *   searchlight -- a sky beam that sweeps slowly, rooted at `position`.
 *   water      -- a river plane with drifting neon reflections.
 *   cable      -- a straight glowing cable from `position` to `to`.
 *   ball       -- a faceted glowing sphere (the Times Square ball).
 */
export type DecorKind =
  | 'tower' | 'ring' | 'block' | 'billboard' | 'tree' | 'watertower'
  | 'statue' | 'traffic' | 'searchlight' | 'water' | 'cable' | 'ball';
const DECOR_KINDS: readonly string[] = [
  'tower', 'ring', 'block', 'billboard', 'tree', 'watertower',
  'statue', 'traffic', 'searchlight', 'water', 'cable', 'ball',
];
export type DecorCap = 'spire' | 'stepped';

export interface CourseDecor {
  id: string;
  kind: DecorKind;
  /** Centre of the box (tower/block) or of the ring. */
  position: Vec3;
  size: Vec3;
  cap?: DecorCap;
  capHeight?: number;
  /** Rotation about the vertical axis, degrees. */
  rotationY?: number;
  /** Billboard copy. */
  text?: string;
  /** Traffic: how many cars. */
  count?: number;
  /** Cable: the far end. */
  to?: Vec3;
  /** `#rrggbb` accent; each kind has its own default. */
  color?: string;
}

export interface CourseGoal {
  id: string;
  /** Centre of the trigger volume. */
  position: Vec3;
  /** Full extents of the trigger volume. */
  size: Vec3;
}

export interface Course {
  id: string;
  name: string;
  /** Where the player starts and respawns. Y is the feet, not the centre. */
  spawn: Vec3;
  /** Falling below this Y means the player is out and respawns. */
  killY: number;
  /**
   * Finish trigger. Optional because Core Rush has no finish line; the old
   * race course still sets it.
   */
  goal?: CourseGoal;
  /**
   * Where the Core appears at match start and returns to when its carrier
   * falls out. Optional so race courses stay valid.
   */
  coreSpawn?: Vec3;
  solids: CourseSolid[];
  /** Gameplay trigger pads. Empty when absent. */
  pads: CoursePad[];
  /** Visual-only scenery. Empty when absent. */
  decor: CourseDecor[];
  /**
   * The course brings its own city, so the client hides the generic ground
   * grid and far-field platforms (see core/stage.ts `setOwnCity`).
   */
  ownCity?: boolean;
}

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/** Axis-aligned bounds of an unrotated box. */
export function boxAabb(position: Vec3, size: Vec3): Aabb {
  const half: Vec3 = [size[0] / 2, size[1] / 2, size[2] / 2];
  return {
    min: [position[0] - half[0], position[1] - half[1], position[2] - half[2]],
    max: [position[0] + half[0], position[1] + half[1], position[2] + half[2]],
  };
}

/** Do two boxes share any volume? Touching faces do not count. */
export function aabbOverlap(a: Aabb, b: Aabb): boolean {
  return (
    a.min[0] < b.max[0] && a.max[0] > b.min[0] &&
    a.min[1] < b.max[1] && a.max[1] > b.min[1] &&
    a.min[2] < b.max[2] && a.max[2] > b.min[2]
  );
}

// ---------------------------------------------------------------- validation

/**
 * Narrow an untyped value (parsed JSON) into a Course.
 *
 * Course files are hand-edited, so this fails loudly and names the exact
 * path that is wrong rather than letting a typo become a collider in the
 * wrong place with no visible cause.
 */
export function parseCourse(raw: unknown, source: string): Course {
  const root = asObject(raw, source, '(root)');

  const spawn = asVec3(root.spawn, source, 'spawn');
  const killY = asNumber(root.killY, source, 'killY');
  if (spawn[1] <= killY) {
    fail(source, 'spawn', `spawn Y (${spawn[1]}) must be above killY (${killY})`);
  }

  // Absent means "no finish line", which is valid. Present-but-malformed still
  // fails loudly: a half-written goal must not silently turn into no goal.
  let goal: CourseGoal | undefined;
  if (root.goal !== undefined) {
    const goalRaw = asObject(root.goal, source, 'goal');
    const goalSize = asVec3(goalRaw.size, source, 'goal.size');
    requirePositive(goalSize, source, 'goal.size');
    goal = {
      id: asString(goalRaw.id, source, 'goal.id'),
      position: asVec3(goalRaw.position, source, 'goal.position'),
      size: goalSize,
    };
  }

  let coreSpawn: Vec3 | undefined;
  if (root.coreSpawn !== undefined) {
    coreSpawn = asVec3(root.coreSpawn, source, 'coreSpawn');
    if (coreSpawn[1] <= killY) {
      fail(source, 'coreSpawn', `coreSpawn Y (${coreSpawn[1]}) must be above killY (${killY})`);
    }
  }

  if (!Array.isArray(root.solids) || root.solids.length === 0) {
    fail(source, 'solids', 'expected a non-empty array of solids');
  }

  const seenIds = new Set<string>();
  const solids: CourseSolid[] = root.solids.map((entry, index) => {
    const path = `solids[${index}]`;
    const so = asObject(entry, source, path);

    const id = asString(so.id, source, `${path}.id`);
    if (seenIds.has(id)) fail(source, `${path}.id`, `duplicate solid id "${id}"`);
    seenIds.add(id);

    const kind = asString(so.kind, source, `${path}.kind`);
    if (kind !== 'box') {
      fail(source, `${path}.kind`, `unsupported kind "${kind}" — only "box" exists today`);
    }

    const size = asVec3(so.size, source, `${path}.size`);
    requirePositive(size, source, `${path}.size`);

    const solid: CourseSolid = {
      id,
      kind: 'box',
      position: asVec3(so.position, source, `${path}.position`),
      size,
    };

    if (so.color !== undefined) {
      solid.color = asHexColor(so.color, source, `${path}.color`);
    }

    if (so.style !== undefined) {
      if (so.style !== 'building') fail(source, `${path}.style`, `unsupported style "${String(so.style)}"`);
      solid.style = 'building';
    }

    if (so.rotation !== undefined) {
      const rotation = asVec3(so.rotation, source, `${path}.rotation`);
      for (let i = 0; i < 3; i++) {
        if (Math.abs(rotation[i]) > 60) {
          fail(source, `${path}.rotation[${i}]`, `${rotation[i]} degrees is not a ramp; keep within +/-60`);
        }
      }
      solid.rotation = rotation;
    }

    return solid;
  });

  const pads: CoursePad[] = optionalArray(root.pads, source, 'pads').map((entry, index) => {
    const path = `pads[${index}]`;
    const po = asObject(entry, source, path);
    const id = asString(po.id, source, `${path}.id`);
    if (seenIds.has(id)) fail(source, `${path}.id`, `duplicate id "${id}"`);
    seenIds.add(id);

    const kind = asString(po.kind, source, `${path}.kind`);
    if (kind !== 'boost' && kind !== 'jump') {
      fail(source, `${path}.kind`, `unsupported pad kind "${kind}" -- "boost" or "jump"`);
    }
    const size = asVec3(po.size, source, `${path}.size`);
    requirePositive(size, source, `${path}.size`);
    const pad: CoursePad = { id, kind, position: asVec3(po.position, source, `${path}.position`), size };

    if (kind === 'boost') {
      const dir = po.direction;
      if (!Array.isArray(dir) || dir.length !== 2) {
        fail(source, `${path}.direction`, 'a boost pad needs a direction [x, z]');
      }
      const dx = asNumber(dir[0], source, `${path}.direction[0]`);
      const dz = asNumber(dir[1], source, `${path}.direction[1]`);
      const length = Math.hypot(dx, dz);
      if (length < 1e-6) fail(source, `${path}.direction`, 'direction must not be zero');
      pad.direction = [dx / length, dz / length];
    }
    return pad;
  });

  const decor: CourseDecor[] = optionalArray(root.decor, source, 'decor').map((entry, index) => {
    const path = `decor[${index}]`;
    const d = asObject(entry, source, path);
    const id = asString(d.id, source, `${path}.id`);
    if (seenIds.has(id)) fail(source, `${path}.id`, `duplicate id "${id}"`);
    seenIds.add(id);

    const kind = asString(d.kind, source, `${path}.kind`);
    if (!DECOR_KINDS.includes(kind)) {
      fail(source, `${path}.kind`, `unsupported decor kind "${kind}"`);
    }
    const size = asVec3(d.size, source, `${path}.size`);
    requirePositive(size, source, `${path}.size`);
    const item: CourseDecor = {
      id,
      kind: kind as DecorKind,
      position: asVec3(d.position, source, `${path}.position`),
      size,
    };
    if (d.rotationY !== undefined) item.rotationY = asNumber(d.rotationY, source, `${path}.rotationY`);
    if (d.text !== undefined) item.text = asString(d.text, source, `${path}.text`).slice(0, 24);
    if (d.count !== undefined) {
      item.count = asNumber(d.count, source, `${path}.count`);
      if (item.count < 1 || item.count > 200) fail(source, `${path}.count`, 'must be 1..200');
    }
    if (d.to !== undefined) item.to = asVec3(d.to, source, `${path}.to`);
    if (d.color !== undefined) item.color = asHexColor(d.color, source, `${path}.color`);
    if (kind === 'billboard' && !item.text) fail(source, `${path}.text`, 'a billboard needs text');
    if (kind === 'cable' && !item.to) fail(source, `${path}.to`, 'a cable needs an end point');

    if (d.cap !== undefined) {
      const cap = asString(d.cap, source, `${path}.cap`);
      if (cap !== 'spire' && cap !== 'stepped') fail(source, `${path}.cap`, `unsupported cap "${cap}"`);
      if (kind !== 'tower') fail(source, `${path}.cap`, 'only towers take a cap');
      item.cap = cap;
      item.capHeight = asNumber(d.capHeight, source, `${path}.capHeight`);
      if (item.capHeight <= 0) fail(source, `${path}.capHeight`, 'must be greater than zero');
    }
    return item;
  });

  const course: Course = {
    id: asString(root.id, source, 'id'),
    name: asString(root.name, source, 'name'),
    spawn,
    killY,
    solids,
    pads,
    decor,
  };
  // Assigned only when present so a race course round-trips without stray
  // `undefined` keys.
  if (root.ownCity === true) course.ownCity = true;
  if (goal) course.goal = goal;
  if (coreSpawn) course.coreSpawn = coreSpawn;
  return course;
}

function fail(source: string, path: string, message: string): never {
  throw new Error(`Invalid course "${source}" at ${path}: ${message}`);
}

function asObject(value: unknown, source: string, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(source, path, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, source: string, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(source, path, 'expected a non-empty string');
  }
  return value;
}

function asNumber(value: unknown, source: string, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(source, path, 'expected a finite number');
  }
  return value;
}

function asVec3(value: unknown, source: string, path: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) {
    fail(source, path, 'expected [number, number, number]');
  }
  for (let i = 0; i < 3; i++) asNumber(value[i], source, `${path}[${i}]`);
  return value as Vec3;
}

/** An optional array field: absent is empty, present-but-not-an-array fails. */
function optionalArray(value: unknown, source: string, path: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(source, path, 'expected an array');
  return value;
}

function requirePositive(size: Vec3, source: string, path: string): void {
  for (let i = 0; i < 3; i++) {
    if (size[i] <= 0) fail(source, `${path}[${i}]`, `must be greater than zero, got ${size[i]}`);
  }
}

function asHexColor(value: unknown, source: string, path: string): string {
  if (typeof value !== 'string' || !/^#?[0-9a-fA-F]{6}$/.test(value)) {
    fail(source, path, 'expected a hex colour like "#4f7f4a"');
  }
  return value.startsWith('#') ? value : `#${value}`;
}