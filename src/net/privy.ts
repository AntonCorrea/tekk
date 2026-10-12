/**
 * Privy, on the browser side (Stage 3)
 *
 * The real login. A thin wrapper over `@privy-io/js-sdk-core`, Privy's vanilla
 * client -- deliberately low-level, so this app owns the secure-context iframe,
 * the message plumbing, and the moment the wallet is asked to sign.
 *
 * The flow, in order:
 *
 *   1. `connect()`  -- build the client, restore a saved session, mount the
 *                      hidden iframe that holds the wallet key material.
 *   2. login        -- email OTP, or the session `connect()` restored.
 *   3. `signJoin()` -- mint the embedded wallet if this user has none, then
 *                      sign the join statement from `shared/identity.ts`.
 *
 * Everything is fail-soft. Storage blocked, network down, a user who never
 * finishes the OTP: each lands back in the caller's hands as `false`, `null` or
 * a thrown error the login card turns into a guest seat. The game must never be
 * unavailable because Privy is.
 *
 * The SDK is imported lazily inside `connect()`, so a build with no
 * VITE_PRIVY_APP_ID never downloads it and the main bundle is unchanged.
 */
import type Privy from '@privy-io/js-sdk-core';
import { bindingMessage, randomNonce, type WalletBinding, type WalletProof } from '../shared/identity.ts';

/** The module namespace, kept from the one dynamic import. */
type Sdk = typeof import('@privy-io/js-sdk-core');

/**
 * Privy's user object.
 *
 * Taken from the helper that consumes it rather than imported by name: the
 * user type lives in `@privy-io/api-types`, which is a transitive dependency
 * of the SDK and not something this project declares. Deriving it keeps the
 * import surface to the one package we actually installed.
 */
type PrivyUser = NonNullable<Parameters<Sdk['getUserEmbeddedEthereumWallet']>[0]>;

/**
 * Compiled-in app id. Empty means the entire Privy path is switched off and
 * the login card stays in its placeholder form.
 *
 * `VITE_*` is build-time and public: an app id is public by design. The app
 * SECRET is the one that must never appear here -- it lives in the server's
 * environment only.
 */
export function privyEnabled(): boolean {
  const appId = import.meta.env['VITE_PRIVY_APP_ID'];
  return typeof appId === 'string' && appId.length > 0;
}

let sdk: Sdk | null = null;
let client: Privy | null = null;
let frameReady: Promise<void> | null = null;
let connecting: Promise<boolean> | null = null;

/**
 * Build the client, restore a saved session and mount the secure context.
 *
 * Idempotent by memoised promise, not by a boolean: the SDK keeps one session
 * in storage and expects one iframe, so a second call must join the first
 * rather than build a rival pair. Returns false when Privy is unconfigured or
 * unavailable -- the caller then offers the guest path alone.
 */
export function connect(): Promise<boolean> {
  if (!privyEnabled()) return Promise.resolve(false);
  connecting ??= boot().catch((error) => {
    console.warn('[privy] unavailable, falling back to guest:', error);
    return false;
  });
  return connecting;
}

async function boot(): Promise<boolean> {
  const loaded = await import('@privy-io/js-sdk-core');
  const appId = import.meta.env['VITE_PRIVY_APP_ID'] as string;
  const clientId = import.meta.env['VITE_PRIVY_CLIENT_ID'];

  const instance = new loaded.default({
    appId,
    clientId: typeof clientId === 'string' && clientId.length > 0 ? clientId : undefined,
    storage: new loaded.LocalStorage(),
  });
  // Restores the stored session when there is one. The recipe is explicit that
  // everything else has to wait for this.
  await instance.initialize();

  // The secure context: a hidden iframe that holds the wallet key material and
  // performs the signing. It must be mounted and wired BEFORE any wallet call,
  // and only messages from THIS frame are forwarded -- `postMessage` is a
  // public channel, so `event.source` is the check that keeps it private.
  const element = document.createElement('iframe');
  element.src = instance.embeddedWallet.getURL();
  element.title = 'privy secure context';
  element.style.display = 'none';
  frameReady = new Promise<void>((resolve) => {
    element.onload = () => resolve();
  });
  document.body.appendChild(element);

  const contentWindow = element.contentWindow;
  if (!contentWindow) throw new Error('privy secure context iframe has no content window');

  // The SDK's poster contract is written for a webview, which exposes
  // `postMessage` and `reload` on the same object. A browser iframe splits them
  // (`contentWindow.postMessage` / `contentWindow.location.reload`), so the two
  // are welded together here instead of being cast away.
  instance.setMessagePoster({
    postMessage: (message: unknown, targetOrigin: string): void => {
      contentWindow.postMessage(message, targetOrigin);
    },
    reload: (): void => {
      contentWindow.location.reload();
    },
  });

  globalThis.addEventListener('message', (event) => {
    if (event.source !== contentWindow) return;
    try {
      // The SDK accepts the parsed object; the string form is what a
      // webview-style transport would hand over.
      instance.embeddedWallet.onMessage(
        typeof event.data === 'string' ? JSON.parse(event.data) : event.data,
      );
    } catch (error) {
      console.warn('[privy] dropped an unreadable secure-context message:', error);
    }
  });

  sdk = loaded;
  client = instance;
  return true;
}

/** The signed-in Privy user, or null. Never throws: no session is normal. */
export async function currentUser(): Promise<PrivyUser | null> {
  if (!client) return null;
  try {
    const { user } = await client.user.get();
    return user ?? null;
  } catch {
    // No session on this device (the SDK throws rather than returning null).
    return null;
  }
}

/** Send a one-time login code. Throws with Privy's own message on failure. */
export async function sendEmailCode(email: string): Promise<void> {
  if (!client) throw new Error('Privy is not available');
  await client.auth.email.sendCode(email);
}

/**
 * Exchange the one-time code for a session.
 *
 * `login-or-sign-up` (the default) mints a new Privy account for an unknown
 * email, which is what "continue with email" should mean to a first-time
 * racer. The card is the sign-up form too.
 */
export async function loginWithEmailCode(email: string, code: string): Promise<PrivyUser> {
  if (!client) throw new Error('Privy is not available');
  const session = await client.auth.email.loginWithCode(email, code);
  return session.user;
}

/** The embedded Ethereum wallet's address for the current user, or null. */
export function walletAddress(user: PrivyUser | null): string | null {
  if (!sdk) return null;
  return sdk.getUserEmbeddedEthereumWallet(user)?.address ?? null;
}

/**
 * Sign the join statement, after making sure the user has a wallet to sign
 * with.
 *
 * Returns null -- never throws -- for every way this can fail: no session, no
 * wallet that Privy would mint, no entropy to open it with, or a rejected
 * signature prompt. The caller then joins as a guest, which is always a valid
 * seat.
 *
 * The proof is single-use and short-lived (see `shared/identity.ts`), so this
 * runs per join rather than once per page.
 */
export async function signJoin(): Promise<WalletProof | null> {
  const instance = client;
  const modules = sdk;
  if (!instance || !modules) return null;

  try {
    let user = await currentUser();
    if (!user) return null;

    if (!modules.getUserEmbeddedEthereumWallet(user)) {
      // First sign-in for this account: Privy mints the wallet now, silently,
      // because the app is configured to provision wallets for its users.
      const created = await instance.embeddedWallet.create({});
      user = created.user;
    }

    const wallet = modules.getUserEmbeddedEthereumWallet(user);
    if (!wallet) return null;

    const entropy = modules.getEntropyDetailsFromUser(user);
    if (!entropy) return null;

    // The iframe has to have loaded for the provider to answer. `getEthereumProvider`
    // would eventually wait on its own; the cap here is so a stuck frame degrades
    // to a guest seat instead of hanging the login card forever.
    await settle(frameReady, 5000);

    const provider = await instance.embeddedWallet.getEthereumProvider({
      wallet,
      entropyId: entropy.entropyId,
      entropyIdVerifier: entropy.entropyIdVerifier,
    });

    const binding: WalletBinding = {
      address: wallet.address,
      issuedAt: Date.now(),
      nonce: randomNonce(),
    };
    const signature = await provider.request({
      method: 'personal_sign',
      params: [bindingMessage(binding), wallet.address],
    });
    if (typeof signature !== 'string') return null;

    const accessToken = await instance.getAccessToken();
    return { ...binding, signature, accessToken: accessToken ?? undefined };
  } catch (error) {
    console.warn('[privy] could not sign the join statement:', error);
    return null;
  }
}

/** Wait for a promise, but never longer than `ms`. */
async function settle(promise: Promise<void> | null, ms: number): Promise<void> {
  if (!promise) return;
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, ms);
    }),
  ]);
}
