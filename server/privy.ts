/**
 * Privy identity + wallet proof verification (Stage 3, server side)
 *
 * Two independent things have to be true before a racer's real address goes
 * on-chain, and this module is the only place either is decided:
 *
 *   1. The racer signed the join statement with the key for the address it
 *      claims. Proved locally by viem's `verifyMessage` -- no network, no third
 *      party, nothing to configure.
 *   2. When PRIVY_APP_ID + PRIVY_APP_SECRET are set, the join also carries a
 *      Privy access token for that user and the token verifies. That is what
 *      ties a seat to a real, authenticated Privy account instead of to any
 *      wallet that can produce a signature.
 *
 * Both are fail-open, in the same spirit as the on-chain hook: an unverifiable
 * join is a GUEST, not an error. The racer still plays, and its record simply
 * goes out with the zero address. Nothing here can block a match, and with no
 * Privy credentials configured the entire module is inert.
 *
 * The access token is verified against the app's JWKS, which the SDK fetches
 * from Privy and caches -- so there is no per-join round trip after the first.
 *
 * The wallet address is NOT cross-checked against the user's linked accounts.
 * It does not need to be: the signature already proves the joiner holds that
 * key, and the token already proves who is asking. A second API call per join
 * would add a network failure mode and buy nothing the two checks do not.
 */
import { loadEnvFile } from 'node:process';
import { PrivyClient } from '@privy-io/node';
import { getAddress, verifyMessage } from 'viem';
import type { Hex } from 'viem';
import { BINDING_TTL_MS, bindingMessage, isWalletProof } from '../src/shared/identity.ts';

// Same reason, and the same pattern, as server/matchRecord.ts: tekk2/.env is
// the one place server secrets live, and Node's own loader avoids a dotenv
// dependency. Module-level because both the load and the read must happen
// before the first join; a miss just means "configured from the shell".
try {
  loadEnvFile();
} catch {
  // no .env present; rely on the shell environment
}

const appId = process.env.PRIVY_APP_ID;
const appSecret = process.env.PRIVY_APP_SECRET;

/**
 * True when a join must carry a verifiable Privy access token.
 *
 * Both halves are required: the id alone cannot verify a token, and the secret
 * alone names no app. A half-configured pair is therefore OFF rather than
 * half-on, which keeps the inert path the safe one to land in.
 */
export const privyAuthEnabled = Boolean(appId && appSecret);

const privy =
  privyAuthEnabled && appId && appSecret ? new PrivyClient({ appId, appSecret }) : null;

/** A verified joiner: the wallet that signed, and the Privy user behind it. */
export interface VerifiedRacer {
  /** The checksummed address recovered from the signature. */
  wallet: Hex;
  /** The Privy user id, or '' when Privy is not configured. */
  userId: string;
}

/**
 * Nonces already accepted, mapped to the moment they stop mattering.
 *
 * Self-limiting rather than a real replay store: an entry is dropped once its
 * own proof could no longer be replayed anyway, so the map cannot grow without
 * bound on a server that has been up for weeks. A restart forgets everything,
 * and the freshness window is what keeps that safe.
 */
const seenNonces = new Map<string, number>();

function pruneNonces(now: number): void {
  for (const [nonce, expiresAt] of seenNonces) {
    if (expiresAt <= now) seenNonces.delete(nonce);
  }
}

/**
 * Verify a join's wallet proof.
 *
 * Returns null for anything that does not check out -- malformed, stale,
 * replayed, unsigned, or token-less while Privy is configured. Never throws: a
 * questionable proof is a guest seat, not a failed join.
 *
 * The proof is accepted at most once. A racer that reconnects with the same
 * signed statement is therefore a guest; the client signs a fresh statement
 * every time it joins, which is why that is the right trade.
 */
export async function verifyRacer(proof: unknown): Promise<VerifiedRacer | null> {
  if (!isWalletProof(proof)) return null;

  const now = Date.now();
  // Fresh enough to be this join, and not stamped in the future. Half a minute
  // of clock skew is tolerated; a claim of the year 3000 is not.
  const age = now - proof.issuedAt;
  if (age > BINDING_TTL_MS || age < -30_000) return null;

  pruneNonces(now);
  if (seenNonces.has(proof.nonce)) return null;

  let wallet: Hex;
  try {
    wallet = getAddress(proof.address);
  } catch {
    return null; // not an address at all
  }

  // The message is rebuilt from the proof's own fields, not taken from the
  // wire: the client sends the parts, never the string it claims to have
  // signed, so a mismatch between the two is not expressible.
  let signed = false;
  try {
    signed = await verifyMessage({
      address: wallet,
      message: bindingMessage(proof),
      signature: proof.signature as Hex,
    });
  } catch {
    signed = false; // malformed signature bytes
  }
  if (!signed) return null;

  let userId = '';
  if (privy) {
    if (!proof.accessToken) return null;
    try {
      const claims = await privy.utils().auth().verifyAccessToken(proof.accessToken);
      userId = claims.user_id;
    } catch (error) {
      console.warn('[privy] access token rejected:', error);
      return null;
    }
  }

  // Only a fully-verified proof burns its nonce. A rejected one leaves the
  // nonce free, so a client that failed on a transient error can retry with
  // the same statement instead of being locked out of its own seat.
  seenNonces.set(proof.nonce, now + BINDING_TTL_MS);
  return { wallet, userId };
}
