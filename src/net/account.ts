/**
 * The off-chain account (prototype)
 *
 * Stands in for the Privy-backed identity the real build will use. On first
 * boot an account is minted and kept in `localStorage`; later boots reload it,
 * so you come back as the same person with the same name and the same cosmetics.
 *
 * This is the "login" the prototype ships: no Privy, no server-side session,
 * no database, no chain — deliberately, so the SHAPE of the flow is provable
 * before any of those are wired. Porting to Privy replaces this one file (the
 * account becomes the verified user object) and leaves the cosmetic plumbing
 * untouched: the server still receives a `CosmeticIdentity` and the renderer
 * still reads the equipped cosmetic ids (`equippedTrailId` and friends).
 *
 * Nothing here is authoritative. It lives on the client because the whole
 * point of the prototype is that there is no database yet; in the real build
 * the owned list is the account's record on the server and the client's claim
 * is verified, not trusted. See the note in `server/room.ts`.
 */

import {
  isTrail,
  STARTER_TRAILS,
  DEFAULT_TRAIL,
  isBodyColor,
  STARTER_BODY_COLORS,
  DEFAULT_BODY_COLOR,
  isHat,
  STARTER_HATS,
  DEFAULT_HAT,
  isGear,
  STARTER_GEARS,
  DEFAULT_GEAR,
  type CosmeticIdentity,
} from '../shared/cosmetics.ts';
import { randomRacerName } from '../shared/input.ts';

const STORAGE_KEY = 'tekk2:account';

/**
 * How the account "signed in".
 *
 * The placeholder mints local accounts, so every method below is fictional
 * until Privy is wired — but the shape is the real one: the provider (or a
 * passkey or an embedded wallet) that issued this identity is part of the
 * account record, exactly as a Privy user object carries one.
 */
export type LoginMethod = 'guest' | 'google' | 'apple' | 'twitter' | 'email' | 'passkey' | 'wallet';

/** Guard, so a hand-edited store can never mint an invented method. */
export function isLoginMethod(value: unknown): value is LoginMethod {
  return (
    value === 'guest' ||
    value === 'google' ||
    value === 'apple' ||
    value === 'twitter' ||
    value === 'email' ||
    value === 'passkey' ||
    value === 'wallet'
  );
}

/** A local account: the off-chain stand-in for a Privy user. */
export interface Account extends CosmeticIdentity {
  /** Display name, carried as the racer's name on join. Mutable: a lobby
   * rename updates it and persists it, so a reload comes back as the same
   * name the server last accepted. */
  name: string;

  /**
   * Whether that name is the racer's own choice.
   *
   * False while the name is still whatever was minted for them; a login only
   * fills in the handle it mints while this is false, so signing in again can
   * never overwrite a name the racer picked. Every way the name becomes theirs
   * -- renaming in the lobby, and the login that filled it in -- sets it. A
   * store written before this field existed is read as true, so a name that is
   * already on a device is never replaced.
   */
  namedSelf: boolean;

  /** The sign-in method that minted this account. `'guest'` until a provider is picked. */
  loginMethod: LoginMethod;

  /**
   * The trail currently worn. Mutable: equipping updates this and persists it,
   * so the picker and a reload agree even before the server echoes the change.
   */
  equippedTrail: string;

  /**
   * The body colour currently worn. Mutable for the same reason as
   * `equippedTrail`: equipping updates and persists it, and the reload agrees.
   */
  equippedBodyColor: string;

  /**
   * The hat currently worn. Mutable for the same reason as `equippedTrail`.
   */
  equippedHat: string;

  /**
   * The gear piece currently worn. Mutable for the same reason as
   * `equippedTrail`: equipping updates and persists it, and the reload agrees.
   */
  equippedGear: string;

  /**
   * The owned sets. Mutable for the same reason as the equipped fields: a
   * pickup grant (`grantOwned`) appends to them and persists, so the picker
   * and a reload agree. `CosmeticIdentity` marks them readonly because the
   * identity presented to the server must not be treated as live state there;
   * the account side owns them.
   */
  ownedTrails: string[];
  ownedBodyColors: string[];
  ownedHats: string[];
  ownedGears: string[];

  /**
   * The account's best finish time, in ms, per course id — the "top racing
   * time" for the `reach`/`hunt` modes. Only the fastest time is kept, and only
   * for the local account: there is no server board (and no database) in the
   * prototype, so this is the same off-chain stand-in as the wardrobe.
   */
  personalBests: Record<string, number>;
}

/** A stable local handle. Not a secret and not security — just a recognisable id. */
function randomAccountId(): string {
  return `guest_${Math.random().toString(36).slice(2, 10)}`;
}

/** The trail a new account starts wearing. */
const DEFAULT_EQUIPPED = DEFAULT_TRAIL;

/** The body colour a new account starts wearing. */
const DEFAULT_EQUIPPED_COLOR = DEFAULT_BODY_COLOR;

/** The hat a new account starts wearing. */
const DEFAULT_EQUIPPED_HAT = DEFAULT_HAT;

/** The gear a new account starts wearing. */
const DEFAULT_EQUIPPED_GEAR = DEFAULT_GEAR;

/**
 * Load the account, minting one on first run.
 *
 * Tolerant of a store that is absent (private mode), inaccessible, or has
 * been hand-edited into nonsense: anything unusable falls back to a fresh
 * account rather than throwing during boot. The owned set is always
 * normalised against the catalog, so a stale id from an older build can never
 * survive into the picker or the wire.
 */
export function loadAccount(): Account {
  const stored = readStore();
  if (stored) {
    const owned = normaliseOwned(stored.ownedTrails);
    const equipped =
      isTrail(stored.equippedTrail) && owned.includes(stored.equippedTrail)
        ? stored.equippedTrail
        : owned[0]!;
    const ownedColors = normaliseOwnedColors(stored.ownedBodyColors);
    const equippedColor =
      isBodyColor(stored.equippedBodyColor) && ownedColors.includes(stored.equippedBodyColor)
        ? stored.equippedBodyColor
        : ownedColors[0]!;
    const ownedHats = normaliseOwnedHats(stored.ownedHats);
    const equippedHat =
      isHat(stored.equippedHat) && ownedHats.includes(stored.equippedHat)
        ? stored.equippedHat
        : ownedHats[0]!;
    const ownedGears = normaliseOwnedGears(stored.ownedGears);
    const equippedGear =
      isGear(stored.equippedGear) && ownedGears.includes(stored.equippedGear)
        ? stored.equippedGear
        : ownedGears[0]!;
    return {
      id: typeof stored.id === 'string' && stored.id.length > 0 ? stored.id : randomAccountId(),
      name:
        typeof stored.name === 'string' && stored.name.trim().length > 0
          ? stored.name
          : randomRacerName(),
      // Absent means this store predates the field, and the honest reading of an
      // unknown name is "the racer's": guessing the other way would overwrite a
      // name someone chose.
      namedSelf: stored.namedSelf ?? true,
      loginMethod: isLoginMethod(stored.loginMethod) ? stored.loginMethod : 'guest',
      ownedTrails: owned,
      equippedTrail: equipped,
      ownedBodyColors: ownedColors,
      equippedBodyColor: equippedColor,
      ownedHats,
      equippedHat,
      ownedGears,
      equippedGear,
      personalBests: normaliseBests(stored.personalBests),
    };
  }

  const fresh: Account = {
    id: randomAccountId(),
    name: randomRacerName(),
    // Minted, not chosen: the first login may name this racer after itself.
    namedSelf: false,
    loginMethod: 'guest',
    ownedTrails: [...STARTER_TRAILS],
    equippedTrail: DEFAULT_EQUIPPED,
    ownedBodyColors: [...STARTER_BODY_COLORS],
    equippedBodyColor: DEFAULT_EQUIPPED_COLOR,
    ownedHats: [...STARTER_HATS],
    equippedHat: DEFAULT_EQUIPPED_HAT,
    ownedGears: [...STARTER_GEARS],
    equippedGear: DEFAULT_EQUIPPED_GEAR,
    personalBests: {},
  };
  saveAccount(fresh);
  return fresh;
}

/** Persist the account. Best-effort: a write failure must never break boot. */
export function saveAccount(account: Account): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(account));
  } catch {
    // Private mode, quota, or no DOM. The session still carries the account;
    // it just will not survive a reload.
  }
}

/**
 * Credit a collected pickup item into the account's wardrobe and persist it.
 *
 * Returns true only when the item is NEW to the account — the signal the
 * caller (main.ts) uses to toast "unlocked" and auto-equip. Re-collecting an
 * item on a later map is an idempotent no-op that returns false, matching the
 * server's own idempotent grant.
 */
export function grantOwned(account: Account, itemId: string): boolean {
  if (isTrail(itemId) && !account.ownedTrails.includes(itemId)) {
    account.ownedTrails = [...account.ownedTrails, itemId];
    saveAccount(account);
    return true;
  }
  if (isBodyColor(itemId) && !account.ownedBodyColors.includes(itemId)) {
    account.ownedBodyColors = [...account.ownedBodyColors, itemId];
    saveAccount(account);
    return true;
  }
  if (isHat(itemId) && !account.ownedHats.includes(itemId)) {
    account.ownedHats = [...account.ownedHats, itemId];
    saveAccount(account);
    return true;
  }
  if (isGear(itemId) && !account.ownedGears.includes(itemId)) {
    account.ownedGears = [...account.ownedGears, itemId];
    saveAccount(account);
    return true;
  }
  // A stock default or an unknown id never reaches here (the course parser and
  // the server both reject them), so falling through means "already owned".
  return false;
}

/**
 * Record a finish time for a course if it beats the account's best and persist
 * it. Returns true only when it is a NEW best — the signal the caller uses to
 * toast "new best". A time that ties the best is not an improvement, matching
 * how the server ranks equal times by sessionId rather than reordering.
 */
export function recordPersonalBest(account: Account, courseId: string, ms: number): boolean {
  if (!Number.isFinite(ms) || ms < 0) return false;
  const previous = account.personalBests[courseId];
  if (previous !== undefined && ms >= previous) return false;
  account.personalBests = { ...account.personalBests, [courseId]: ms };
  saveAccount(account);
  return true;
}

/** Keep only finite, non-negative times keyed by a non-empty course id. */
function normaliseBests(raw: unknown): Record<string, number> {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (id.length === 0) continue;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[id] = value;
  }
  return out;
}

function readStore(): Partial<Account> | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Partial<Account>) : null;
  } catch {
    return null;
  }
}

/** Keep only ids the current catalog still ships; seed a fresh set if empty. */
function normaliseOwned(raw: unknown): string[] {
  const owned = Array.isArray(raw) ? raw.filter(isTrail) : [];
  if (owned.length === 0) owned.push(...STARTER_TRAILS);
  return [...new Set(owned)];
}

/** Keep only ids the current catalog still ships; seed a fresh set if empty. */
function normaliseOwnedColors(raw: unknown): string[] {
  const owned = Array.isArray(raw) ? raw.filter(isBodyColor) : [];
  if (owned.length === 0) owned.push(...STARTER_BODY_COLORS);
  return [...new Set(owned)];
}

/** Keep only ids the current catalog still ships; seed a fresh set if empty. */
function normaliseOwnedHats(raw: unknown): string[] {
  const owned = Array.isArray(raw) ? raw.filter(isHat) : [];
  if (owned.length === 0) owned.push(...STARTER_HATS);
  return [...new Set(owned)];
}

/** Keep only ids the current catalog still ships; seed a fresh set if empty. */
function normaliseOwnedGears(raw: unknown): string[] {
  const owned = Array.isArray(raw) ? raw.filter(isGear) : [];
  if (owned.length === 0) owned.push(...STARTER_GEARS);
  return [...new Set(owned)];
}
