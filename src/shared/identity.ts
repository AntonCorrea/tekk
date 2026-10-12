/**
 * Wallet identity, shared by both ends of the wire (Stage 3)
 *
 * A racer signs ONE statement when it joins, and the server verifies that
 * statement before it will put a real address on-chain for that racer. Both
 * sides have to agree on the exact bytes, so the message is built here, once,
 * and imported by the client (to sign) and by the server (to recover the
 * signer). Rebuilding it in two places -- even "byte for byte" -- is how
 * signature verification starts failing for no visible reason.
 *
 * What the signature buys: proof that the joiner holds the key for the address
 * it claims. What it does not buy: a name, an account, or any off-chain record.
 * The server only ever needs the address, and the address is all it keeps.
 *
 * `issuedAt` and `nonce` bound how useful a captured proof is. The server
 * rejects a proof older than `BINDING_TTL_MS` and remembers the nonces it has
 * already accepted, so one signature cannot be replayed into a second seat.
 * None of it is durable: a restart forgets the nonces, and the freshness window
 * still bounds the damage.
 *
 * No DOM, no Privy, no chain -- this module is the one contract both runtimes
 * share, and it stays dependency-free on purpose.
 */

/**
 * How long a signed binding stays valid, in ms.
 *
 * Long enough to survive a slow connection between "sign" and "join", short
 * enough that a proof captured off the wire is stale almost immediately.
 */
export const BINDING_TTL_MS = 5 * 60_000;

/** The fields a racer signs. `issuedAt` is ms since the Unix epoch. */
export interface WalletBinding {
  /** The address the racer claims. Anything not an address is rejected. */
  address: string;
  /** When the statement was signed. Bounded by `BINDING_TTL_MS` on the server. */
  issuedAt: number;
  /** One-shot value, so two joins never sign the same bytes. */
  nonce: string;
}

/** A binding plus the proof that produced it, exactly as it travels at join. */
export interface WalletProof extends WalletBinding {
  /** The 65-byte ECDSA signature over `bindingMessage(...)`. */
  signature: string;
  /**
   * The Privy access token for the session that owns this wallet.
   *
   * Only present when the client is configured for Privy. The server checks it
   * when, and only when, PRIVY_APP_ID + PRIVY_APP_SECRET are set -- so the same
   * proof travels in a Privy build and a wallet-only one.
   */
  accessToken?: string;
}

/**
 * The exact bytes a racer signs.
 *
 * A human-readable preamble, then one `field: value` per line. The order and
 * the separators are part of the contract: change either and every existing
 * proof stops verifying. There is deliberately no trailing newline.
 */
export function bindingMessage(binding: WalletBinding): string {
  return (
    'TEKK wallet binding\n' +
    `address: ${binding.address}\n` +
    `issuedAt: ${binding.issuedAt}\n` +
    `nonce: ${binding.nonce}`
  );
}

/**
 * Guard the wire shape.
 *
 * Join options are untrusted input, so anything that is not a fully-formed
 * proof is dropped whole rather than partially trusted: a truncated signature
 * must never reach the signature check, and a non-string address must never
 * reach `getAddress`. Range and format checks (freshness, checksum, recovery)
 * belong to the verifier, which alone knows what it considers valid.
 */
export function isWalletProof(value: unknown): value is WalletProof {
  if (typeof value !== 'object' || value === null) return false;
  const proof = value as Record<string, unknown>;
  const nonce = proof['nonce'];
  const signature = proof['signature'];
  const accessToken = proof['accessToken'];
  return (
    typeof proof['address'] === 'string' &&
    typeof proof['issuedAt'] === 'number' &&
    Number.isFinite(proof['issuedAt']) &&
    typeof nonce === 'string' &&
    nonce.length >= 8 &&
    typeof signature === 'string' &&
    /^0x[0-9a-fA-F]+$/.test(signature) &&
    (accessToken === undefined || typeof accessToken === 'string')
  );
}

/**
 * A fresh, unguessable nonce.
 *
 * `crypto` is a global in both runtimes we target (the browser and Node 20+),
 * so no import and no polyfill. 16 bytes is far past collision range for the
 * handful of joins a match ever sees.
 */
export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let nonce = '';
  for (const byte of bytes) nonce += byte.toString(16).padStart(2, '0');
  return nonce;
}
