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
 * still reads `equippedTrailId`/`equippedBodyColorId`/`equippedHatId`.
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
    return {
      id: typeof stored.id === 'string' && stored.id.length > 0 ? stored.id : randomAccountId(),
      name:
        typeof stored.name === 'string' && stored.name.trim().length > 0
          ? stored.name
          : randomRacerName(),
      loginMethod: isLoginMethod(stored.loginMethod) ? stored.loginMethod : 'guest',
      ownedTrails: owned,
      equippedTrail: equipped,
      ownedBodyColors: ownedColors,
      equippedBodyColor: equippedColor,
      ownedHats,
      equippedHat,
    };
  }

  const fresh: Account = {
    id: randomAccountId(),
    name: randomRacerName(),
    loginMethod: 'guest',
    ownedTrails: [...STARTER_TRAILS],
    equippedTrail: DEFAULT_EQUIPPED,
    ownedBodyColors: [...STARTER_BODY_COLORS],
    equippedBodyColor: DEFAULT_EQUIPPED_COLOR,
    ownedHats: [...STARTER_HATS],
    equippedHat: DEFAULT_EQUIPPED_HAT,
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
