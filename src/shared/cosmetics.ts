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
 * `body-stock` inherits the seat colour; every other entry overrides the
 * identity tint the racer's body (and the stock trail, and the dash ghosts)
 * lerp toward. Saturates like the seat hues, so an equipped colour still
 * reads as the most saturated thing in its patch of screen, but sits outside
 * the seat set — putting on a colour is a deliberate departure from the
 * palette seat you were given.
 */
export const BODY_COLORS: Record<string, BodyColorDef> = {
  'body-stock': { name: 'Stock', color: null },
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

/**
 * What a brand-new off-chain account "acquires" for free.
 *
 * The prototype's stand-in for a purchase: everyone starts owning the set, so
 * the picker has something to show and the equip flow is exercisable end to
 * end. A real build would seed this from the account's DB/chain record.
 */
export const STARTER_TRAILS: readonly string[] = Object.keys(TRAILS);

/** What a brand-new off-chain account "acquires" for free. Same stand-in as
 * `STARTER_TRAILS`; see that comment for the real-build replacement. */
export const STARTER_BODY_COLORS: readonly string[] = Object.keys(BODY_COLORS);

/** What a brand-new off-chain account "acquires" for free. Same stand-in as
 * `STARTER_TRAILS`; see that comment for the real-build replacement. */
export const STARTER_HATS: readonly string[] = Object.keys(HATS);

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
