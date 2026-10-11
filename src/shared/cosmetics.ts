/**
 * Cosmetic catalog
 *
 * The one list of wearables a racer may acquire and equip. It is the contract
 * between three places that must agree:
 *
 *   - the SERVER, which validates an `equip` against this list before it is
 *     allowed onto the wire (`server/room.ts`);
 *   - the RENDERER, which resolves an id to a look (`render/character.ts`);
 *   - the PICKER, which draws the acquired ones (`ui/hud.ts`).
 *
 * Pure data on purpose: no three.js, no DOM, no I/O. That is what lets the
 * Node server import it without dragging a renderer in. Cosmetics are
 * presentational, so — like `render/palette.ts` — nothing on the determinism
 * path may import this; `shared/sim.ts` must never read it, or a cosmetic
 * would quietly become gameplay.
 *
 * The catalog is code, not a table: ids are the stable contract, and the look
 * behind an id is free to change without a migration.
 */

/** How one trail is drawn. Resolved from an id; never stored on the wire. */
export interface TrailDef {
  /** Display name for the picker. */
  readonly name: string;
  /** Ribbon colour, or `null` to inherit the racer's identity colour. */
  readonly color: number | null;
  /** Width multiplier on the stock foot/hand ribbon. */
  readonly width: number;
  /** Emissive gain multiplier (bloom pickup), on top of the scheme's gain. */
  readonly gain: number;
}

/**
 * The trails.
 *
 * `trail-stock` is deliberately the identity-coloured default, so "no
 * cosmetic" is a real entry in the catalog rather than a `null` the renderer
 * has to special-case. Every other entry sets its own colour, which is the
 * whole visible difference between one trail and another.
 */
export const TRAILS: Record<string, TrailDef> = {
  'trail-stock': { name: 'Stock', color: null, width: 1, gain: 1 },
  'trail-plasma': { name: 'Plasma', color: 0xb35bf7, width: 1.35, gain: 1.7 },
  'trail-comet': { name: 'Comet', color: 0xff8a1f, width: 1.6, gain: 1.5 },
  'trail-void': { name: 'Void', color: 0x4eabe8, width: 0.85, gain: 2.0 },
  'trail-toxic': { name: 'Toxic', color: 0xb8ff2e, width: 1.2, gain: 1.8 },
};

/** The fallback for an unknown or absent id. */
export const DEFAULT_TRAIL = 'trail-stock';

/** How one body colour is drawn. Resolved from an id; never stored on the wire. */
export interface BodyColorDef {
  /** Display name for the picker. */
  readonly name: string;
  /**
   * The body tint, or `null` to keep the racer's seat colour — the palette's
   * RACER hue the tint would otherwise return to. That is why "Stock" is a
   * real entry: no cosmetic is a look, not an absence of one.
   */
  readonly color: number | null;
}

/**
 * The body colours.
 *
 * `body-stock` is a fixed neutral grey — the colour every racer defaults to.
 * `null` still means "keep the seat colour", but no catalog entry uses it
 * today; the tint path just stays defensive. Every other entry overrides the
 * identity tint the racer's body (and the stock trail, and the dash ghosts)
 * lerp toward. Saturates like the seat hues, so an equipped colour still
 * reads as the most saturated thing in its patch of screen, but sits outside
 * the seat set — putting on a colour is a deliberate departure from the
 * palette seat you were given.
 */
export const BODY_COLORS: Record<string, BodyColorDef> = {
  'body-stock': { name: 'Stock', color: 0x888888 },
  'body-gold': { name: 'Gold', color: 0xffd23f },
  'body-ember': { name: 'Ember', color: 0xff5a36 },
  'body-rose': { name: 'Rose', color: 0xff4da6 },
  'body-violet': { name: 'Violet', color: 0x8f5bff },
  'body-ice': { name: 'Ice', color: 0x5fd4ff },
  'body-mint': { name: 'Mint', color: 0x37e6a0 },
};

/** The fallback for an unknown or absent id. */
export const DEFAULT_BODY_COLOR = 'body-stock';

/** How one hat is drawn. Resolved from an id; never stored on the wire. */
export interface HatDef {
  /** Display name for the picker. */
  readonly name: string;
  /**
   * The hat's main static colour. Hats never take the racer's tint — a hat is
   * its own object, not a body part — so its colours are fixed here; `null`
   * is Stock, which draws nothing on the head.
   */
  readonly color: number | null;
  /**
   * The accent trim colour — the bill, band or pompom that breaks the hat's
   * silhouette out of one flat colour.
   */
  readonly accent: number | null;
}

/**
 * The hats.
 *
 * `hat-stock` is the empty entry, so "no hat" is a real catalog id rather
 * than an absent one. Every other entry is a small set of voxel blocks the
 * renderer stacks on the head (`render/character.ts`), filled in the hat's own
 * static colours — main plus accent trim — so it reads as an object the racer
 * is wearing, not a piece of the racer.
 */
export const HATS: Record<string, HatDef> = {
  'hat-stock': { name: 'Stock', color: null, accent: null },
  'hat-cap': { name: 'Cap', color: 0x1f4fd8, accent: 0xffffff },
  'hat-beanie': { name: 'Beanie', color: 0x9b4dff, accent: 0xffb84d },
  'hat-top': { name: 'Top Hat', color: 0x1a1c26, accent: 0xc8d0e0 },
  'hat-cone': { name: 'Party Cone', color: 0xff4d6d, accent: 0x37e6a0 },
  'hat-crown': { name: 'Crown', color: 0xd4a017, accent: 0xffe066 },
};

/** The fallback for an unknown or absent id. */
export const DEFAULT_HAT = 'hat-stock';

/** How one gear piece is drawn. Resolved from an id; never stored on the wire. */
export interface GearDef {
  /** Display name for the picker. */
  readonly name: string;
  /**
   * The gear's main static colour. Like hats, gear is its own object, not a
   * body part — it never takes the racer's tint, so its colours are fixed
   * here; `null` is Stock, which draws nothing on the body.
   */
  readonly color: number | null;
  /**
   * The accent trim colour — the chest stripe, pauldron piping or belt that
   * breaks the piece out of one flat colour.
   */
  readonly accent: number | null;
}

/**
 * The body gear.
 *
 * One catalog wearing three silhouettes on purpose: the ids are a subtle
 * chest wrap (shirt), a vest shell, or a full armour kit — the same
 * three-material uniform graph renders every entry, so the silhouette is just
 * a set of boxes in `render/character.ts`. `gear-stock` is the empty entry,
 * so "no gear" is a real catalog id rather than an absent one. Every other
 * entry's colours are fixed (main + accent trim) and never follow the racer's
 * tint, exactly like hats.
 */
export const GEARS: Record<string, GearDef> = {
  'gear-stock': { name: 'Stock', color: null, accent: null },
  // shirt: a thin chest + belly wrap with sleeve cuffs, the subtlest silhouette.
  'gear-carbon': { name: 'Carbon Shirt', color: 0x23262d, accent: 0xffd23f },
  // vest: a chest shell with trim, no shoulder caps.
  'gear-royal': { name: 'Royal Vest', color: 0x1f4fd8, accent: 0xffffff },
  // vest + shoulders: chest shell with shoulder caps.
  'gear-crimson': { name: 'Crimson Shell', color: 0xff4d6d, accent: 0xffe066 },
  // armour-lite: chest, shoulders and an accent belt.
  'gear-mint': { name: 'Mint Guard', color: 0x37e6a0, accent: 0x1a1c26 },
  // armour-full: chest, pauldrons, thigh guards and a belt — the heaviest kit.
  'gear-plasma': { name: 'Plasma Armour', color: 0xb35bf7, accent: 0xb8ff2e },
};

/** The fallback for an unknown or absent id. */
export const DEFAULT_GEAR = 'gear-stock';

/**
 * What a brand-new off-chain account "acquires" for free.
 *
 * Deliberately lean: just the stock default of each slot, nothing more. A
 * fresh account can equip and the picker has something to show — but the rest
 * of the catalog is only earned by collecting world pickups, which is what
 * makes the collection loop meaningful. A real build would seed this from the
 * account's DB/chain record instead.
 */
export const STARTER_TRAILS: readonly string[] = [DEFAULT_TRAIL];

/** What a brand-new off-chain account "acquires" for free. Same stand-in as
 * `STARTER_TRAILS`; see that comment for the real-build replacement. */
export const STARTER_BODY_COLORS: readonly string[] = [DEFAULT_BODY_COLOR];

/** What a brand-new off-chain account "acquires" for free. Same stand-in as
 * `STARTER_TRAILS`; see that comment for the real-build replacement. */
export const STARTER_HATS: readonly string[] = [DEFAULT_HAT];

/** What a brand-new off-chain account "acquires" for free. Same stand-in as
 * `STARTER_TRAILS`; see that comment for the real-build replacement. */
export const STARTER_GEARS: readonly string[] = [DEFAULT_GEAR];

/** The identity a client presents to the server (off-chain prototype). */
export interface CosmeticIdentity {
  /** Local account id. Stands in for the real `privyUserId`. */
  readonly id: string;
  /** Trail ids the account has acquired. */
  readonly ownedTrails: readonly string[];
  /** The trail currently worn. Always one of `ownedTrails`. */
  readonly equippedTrail: string;
  /** Body-colour ids the account has acquired. */
  readonly ownedBodyColors: readonly string[];
  /** The body colour currently worn. Always one of `ownedBodyColors`. */
  readonly equippedBodyColor: string;
  /** Hat ids the account has acquired. */
  readonly ownedHats: readonly string[];
  /** The hat currently worn. Always one of `ownedHats`. */
  readonly equippedHat: string;
  /** Gear ids the account has acquired. */
  readonly ownedGears: readonly string[];
  /** The gear currently worn. Always one of `ownedGears`. */
  readonly equippedGear: string;
}

/** Whether `id` names a real trail. The guard every untrusted id passes. */
export function isTrail(id: unknown): id is string {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(TRAILS, id);
}

/** Resolve an id to its look, falling back to the stock trail. */
export function getTrail(id: string): TrailDef {
  return (isTrail(id) ? TRAILS[id] : undefined) ?? TRAILS[DEFAULT_TRAIL]!;
}

/** Whether `id` names a real body colour. The guard every untrusted id passes. */
export function isBodyColor(id: unknown): id is string {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BODY_COLORS, id);
}

/** Resolve an id to its look, falling back to Stock (inherit the seat colour). */
export function getBodyColor(id: string): BodyColorDef {
  return (isBodyColor(id) ? BODY_COLORS[id] : undefined) ?? BODY_COLORS[DEFAULT_BODY_COLOR]!;
}

/** Whether `id` names a real hat. The guard every untrusted id passes. */
export function isHat(id: unknown): id is string {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(HATS, id);
}

/** Resolve an id to its look, falling back to Stock (no hat). */
export function getHat(id: string): HatDef {
  return (isHat(id) ? HATS[id] : undefined) ?? HATS[DEFAULT_HAT]!;
}

/** Whether `id` names a real gear piece. The guard every untrusted id passes. */
export function isGear(id: unknown): id is string {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(GEARS, id);
}

/** Resolve an id to its look, falling back to Stock (no gear). */
export function getGear(id: string): GearDef {
  return (isGear(id) ? GEARS[id] : undefined) ?? GEARS[DEFAULT_GEAR]!;
}

// ------------------------------------------------------------ world pickups

/**
 * Whether `id` is an item a world pickup may grant: a real catalog id that is
 * NOT the stock default of its kind. The stock entries are what every racer
 * starts owning — granting one would make a pickup a no-op.
 */
export function isAcquirableItem(id: unknown): id is string {
  return (
    (isTrail(id) && id !== DEFAULT_TRAIL) ||
    (isBodyColor(id) && id !== DEFAULT_BODY_COLOR) ||
    (isHat(id) && id !== DEFAULT_HAT) ||
    (isGear(id) && id !== DEFAULT_GEAR)
  );
}

/** Every pickup-grantable id, in catalog order. Parser and editor share it. */
export const ACQUIRABLE_ITEMS: readonly string[] = [
  ...Object.keys(TRAILS).filter((id) => id !== DEFAULT_TRAIL),
  ...Object.keys(BODY_COLORS).filter((id) => id !== DEFAULT_BODY_COLOR),
  ...Object.keys(HATS).filter((id) => id !== DEFAULT_HAT),
  ...Object.keys(GEARS).filter((id) => id !== DEFAULT_GEAR),
];

/** Which owned set a pickup grant lands in, or 'none' for an un-grantable id. */
export function itemKind(id: string): 'trail' | 'color' | 'hat' | 'gear' | 'none' {
  if (isTrail(id)) return id === DEFAULT_TRAIL ? 'none' : 'trail';
  if (isBodyColor(id)) return id === DEFAULT_BODY_COLOR ? 'none' : 'color';
  if (isHat(id)) return id === DEFAULT_HAT ? 'none' : 'hat';
  if (isGear(id)) return id === DEFAULT_GEAR ? 'none' : 'gear';
  return 'none';
}

/** Display name for an id — pickup label and unlock toast. Falls back to the id. */
export function itemName(id: string): string {
  if (isTrail(id)) return getTrail(id).name;
  if (isBodyColor(id)) return getBodyColor(id).name;
  if (isHat(id)) return getHat(id).name;
  if (isGear(id)) return getGear(id).name;
  return id;
}

/** The one colour a pickup ball renders in: the item's own main look. */
export function itemColor(id: string): number {
  if (isTrail(id)) return getTrail(id).color ?? 0xffffff;
  if (isBodyColor(id)) return getBodyColor(id).color ?? 0xffffff;
  if (isHat(id)) return getHat(id).color ?? 0xffffff;
  if (isGear(id)) return getGear(id).color ?? 0xffffff;
  return 0xffffff;
}
