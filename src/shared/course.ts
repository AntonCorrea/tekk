/**
 * Course definition format
 *
 * A course is plain JSON so the exact same file can be imported by the
 * client and read from disk by the server. Nothing in this module may
 * import Three.js or touch the DOM — the server imports it too.
 *
 * Deliberately minimal. `surface`, `conveyor` and `rotationY` were all
 * considered and left out: a field the engine does not implement is a
 * promise the format cannot keep. Add them when the behaviour exists.
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
  goal: CourseGoal;
  solids: CourseSolid[];
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

  const goalRaw = asObject(root.goal, source, 'goal');
  const goalSize = asVec3(goalRaw.size, source, 'goal.size');
  requirePositive(goalSize, source, 'goal.size');
  const goal: CourseGoal = {
    id: asString(goalRaw.id, source, 'goal.id'),
    position: asVec3(goalRaw.position, source, 'goal.position'),
    size: goalSize,
  };

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

    return solid;
  });

  return {
    id: asString(root.id, source, 'id'),
    name: asString(root.name, source, 'name'),
    spawn,
    killY,
    goal,
    solids,
  };
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