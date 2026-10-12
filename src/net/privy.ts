/**
 * Privy, on the browser side (Stage 3)
 *
 * The real login. A thin wrapper over `@privy-io/js-sdk-core`, Privy's vanilla
 * client -- deliberately low-level, so this app owns the secure-context iframe,
 * the message plumbing, and the moment a wallet is asked to sign.
 *
 * Three ways in, one way out:
 *
 *   - email  : a one-time code. The account and its wallet are both new.
 *   - google : an OAuth redirect, finished at /login-callback on the way back.
 *   - wallet : Sign-In With Ethereum against the wallet the browser already
 *              has. Their key, their address, no Privy wallet minted.
 *
 * Whichever route is used, the racer then signs ONE join statement and that
 * proof is what the server credits (see `shared/identity.ts`).
 *
 * Which address gets credited is the one real decision this module makes: the
 * user's own wallet wins over Privy's, always. A wallet minted for you is a
 * convenience; a wallet you brought is the one you can actually spend from, and
 * "sign in with your wallet" would be a lie if the record named the other one.
 * `externalEthereumAddress` is where that choice is made.
 *
 * Everything is fail-soft. Storage blocked, network down, no browser wallet, a
 * user who never finishes the code: each lands back in the caller's hands as
 * `false`, `null` or a thrown error the login card turns into a guest seat. The
 * game must never be unavailable because Privy is.
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

/** The client instance type, for pulling parameter shapes off the API. */
type PrivyInstance = InstanceType<Sdk['default']>;

/** The wallet shape `auth.siwe.init` accepts, taken from that call itself. */
type SiweWallet = Parameters<PrivyInstance['auth']['siwe']['init']>[0];

/**
 * Where an OAuth provider sends the browser back.
 *
 * Has to match the redirect URI allowlisted in the Privy dashboard, or the
 * provider will refuse to return at all.
 */
const OAUTH_CALLBACK_PATH = '/login-callback';

/**
 * Compiled-in app id. Empty means the entire Privy path is switched off and
 * the login card stays in its placeholder form.
 *
 * `VITE_*` is build-time and public: an app id is public by design. The app
 * SECRET is the one that must never appear here -- it lives in the server's
 * environment only, and note that nothing in the token-verification path even
 * needs it.
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
 * The wallet this session signed in with, when it did so through SIWE.
 *
 * Held so the join proof comes from the same key the login proved. The
 * alternative -- always signing joins with the embedded wallet -- would quietly
 * route a wallet user's record to an address they do not control.
 */
let externalWallet: SiweWallet | null = null;

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

// --- signing in ------------------------------------------------------------

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

/**
 * Send the browser to Google.
 *
 * Does not return in the normal case: the page navigates. The URL, and the
 * `state` it carries, are Privy's -- the state is what makes the callback safe
 * to accept, so it is never hand-rolled here.
 */
export async function beginGoogleLogin(): Promise<void> {
  if (!client) throw new Error('Privy is not available');
  const redirectURI = `${globalThis.location.origin}${OAUTH_CALLBACK_PATH}`;
  const { url } = await client.auth.oauth.generateURL('google', redirectURI);
  globalThis.location.assign(url);
}

/** True when this page load is an OAuth provider coming back. */
export function isOAuthCallback(): boolean {
  try {
    return new URL(globalThis.location.href).pathname === OAUTH_CALLBACK_PATH;
  } catch {
    return false;
  }
}

/**
 * Finish an OAuth login that this page load is the tail of.
 *
 * Returns null when this is not a callback at all. The query string is cleared
 * before returning, either way: the code is single-use, so leaving it in the
 * URL would only invite a confusing replayed attempt on refresh.
 */
export async function completeOAuthCallback(): Promise<PrivyUser | null> {
  if (!client || !isOAuthCallback()) return null;
  const params = new URL(globalThis.location.href).searchParams;
  // Privy namespaces the callback: it returns `privy_oauth_code` and
  // `privy_oauth_state`, not the bare names. The bare ones are read as well
  // because providers echo those for some flows, and a miss here would silently
  // drop through to the login card instead of finishing the sign-in.
  const code = params.get('privy_oauth_code') ?? params.get('code');
  const state = params.get('privy_oauth_state') ?? params.get('state');
  const error = params.get('error') ?? params.get('privy_oauth_error');
  const description = params.get('error_description');

  globalThis.history.replaceState(null, '', '/');
  if (error) throw new Error(description ?? error);
  if (!code || !state) return null;

  const session = await client.auth.oauth.loginWithCode(code, state, 'google');
  return session.user;
}

/** A minimal EIP-1193 surface: all this app needs from a browser wallet. */
interface InjectedProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/**
 * The wallet the browser has injected, if any.
 *
 * Deliberately narrow -- request accounts, read the chain, personal_sign -- and
 * deliberately not MetaMask-specific. Anything that speaks EIP-1193 works,
 * which is why there is no wallet-connection SDK in the dependency list.
 */
function injectedProvider(): InjectedProvider | null {
  const candidate = (globalThis as { ethereum?: unknown }).ethereum;
  if (typeof candidate !== 'object' || candidate === null) return null;
  if (typeof (candidate as { request?: unknown }).request !== 'function') return null;
  return candidate as InjectedProvider;
}

/** True when "sign in with your own wallet" can be offered at all. */
export function externalWalletAvailable(): boolean {
  return injectedProvider() !== null;
}

/**
 * Sign in with the wallet the browser already has (SIWE).
 *
 * Privy owns every step of the protocol: it builds the EIP-4361 message and
 * checks the signature that comes back. This function only brokers -- ask the
 * wallet to connect, hand the message over to be signed, send the signature in.
 *
 * The signing wallet is remembered on the module, because it is also the
 * address the join should be credited to. That is the entire point of this
 * route: the key never leaves the user's own wallet.
 */
export async function loginWithExternalWallet(): Promise<PrivyUser> {
  const instance = client;
  if (!instance) throw new Error('Privy is not available');
  const provider = injectedProvider();
  if (!provider) throw new Error('no browser wallet found');

  // Both of these prompt the wallet: connecting first is what makes the later
  // personal_sign a signature request rather than a permissions request.
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const address = strings(accounts)[0];
  if (!address) throw new Error('the wallet returned no account');

  // EIP-4361 requires the address embedded in the message to be EIP-55
  // checksummed, and Privy's validator enforces it (an all-lowercase address is
  // exactly the 422 that produced this fix). Providers do not guarantee the
  // casing -- MetaMask returns the lowercase form on some paths -- so normalise
  // here rather than trusting the wallet.
  const owner = await checksumAddress(address);

  const chainHex = await provider.request({ method: 'eth_chainId' });
  const chain = typeof chainHex === 'string' ? Number.parseInt(chainHex, 16) : Number.NaN;
  const wallet: SiweWallet = {
    address: owner,
    chainId: `eip155:${Number.isFinite(chain) ? chain : 1}`,
  };

  const { message } = await instance.auth.siwe.init(
    wallet,
    globalThis.location.host,
    globalThis.location.origin,
  );
  // Logged deliberately. A rejection here reads the same whether the message
  // was mangled, the signature came from another account, or the app is not
  // configured for wallet login -- and the only way to tell those apart is to
  // see exactly what was put in front of the wallet.
  console.info(
    `[privy] SIWE message (domain ${globalThis.location.host}):\n${message}`,
  );

  const signature = await provider.request({
    method: 'personal_sign',
    params: [message, owner],
  });
  if (typeof signature !== 'string') throw new Error('the wallet returned no signature');
  console.info(
    `[privy] SIWE signature from ${owner}: ` +
      `${signature.slice(0, 18)}… (${signature.length} chars)`,
  );

  // `login-or-sign-up` is passed explicitly rather than left to the server
  // default: the first visit from a given wallet has to be able to create the
  // account, and that is the whole point of offering this route.
  const session = await instance.auth.siwe.loginWithSiwe(
    signature,
    wallet,
    message,
    'login-or-sign-up',
  );
  externalWallet = wallet;
  return session.user;
}

// --- identity --------------------------------------------------------------

/**
 * The user's own (external) Ethereum wallet, or null.
 *
 * Privy tags the wallets it mints `wallet_client: 'privy'` and
 * `connector_type: 'embedded'`; a `type: 'wallet'` entry that is neither is one
 * the user brought with them. Read defensively, because this crosses the wire
 * from Privy: a shape change degrades to "no external wallet" rather than
 * throwing in the middle of a login.
 */
function externalEthereumAddress(user: PrivyUser | null): string | null {
  const accounts = (user as { linked_accounts?: unknown } | null)?.linked_accounts;
  if (!Array.isArray(accounts)) return null;
  for (const entry of accounts) {
    if (typeof entry !== 'object' || entry === null) continue;
    const account = entry as Record<string, unknown>;
    if (account['type'] !== 'wallet') continue;
    if (account['chain_type'] !== 'ethereum') continue;
    if (account['wallet_client'] === 'privy') continue;
    if (account['connector_type'] === 'embedded') continue;
    const address = account['address'];
    if (typeof address === 'string' && address.length > 0) return address;
  }
  return null;
}

/** The embedded Ethereum wallet's address for the current user, or null. */
function embeddedAddress(user: PrivyUser | null): string | null {
  if (!sdk) return null;
  return sdk.getUserEmbeddedEthereumWallet(user)?.address ?? null;
}

/**
 * The address this session should be credited with: theirs if they have one,
 * Privy's otherwise. Used for the label the card shows before a signature
 * exists; the signature itself is the authority.
 */
export function identityAddress(user: PrivyUser | null): string | null {
  return externalWallet?.address ?? externalEthereumAddress(user) ?? embeddedAddress(user);
}

// --- signing the join -----------------------------------------------------

/**
 * The address from a JSON-RPC account list, if it holds one.
 *
 * Wallets return `string[]`, but they are third-party code and some return
 * objects; `strings` keeps the filtering in one place instead of at each call.
 */
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * EIP-55 checksum an address.
 *
 * Imported lazily on purpose: viem is otherwise a server-only dependency here,
 * and a static import would drag it into the eager bundle. This only runs when
 * someone actually uses the wallet row.
 */
async function checksumAddress(address: string): Promise<string> {
  const { getAddress } = await import('viem/utils');
  return getAddress(address);
}

/**
 * Sign the join statement with the browser wallet.
 *
 * The account is requested again rather than trusted from login time: the user
 * may have switched accounts in the meantime, and a signature has to come from
 * an account the wallet will actually sign with. The session's own address is
 * preferred when it is on offer, so the common case does not drift.
 */
async function signWithExternalWallet(preferred: string): Promise<WalletProof | null> {
  const provider = injectedProvider();
  if (!provider) return null;

  const accounts = strings(await provider.request({ method: 'eth_requestAccounts' }));
  const signer =
    accounts.find((a) => a.toLowerCase() === preferred.toLowerCase()) ?? accounts[0];
  if (!signer) return null;

  const binding: WalletBinding = {
    address: signer,
    issuedAt: Date.now(),
    nonce: randomNonce(),
  };
  const signature = await provider.request({
    method: 'personal_sign',
    params: [bindingMessage(binding), signer],
  });
  if (typeof signature !== 'string') return null;

  const accessToken = await client?.getAccessToken();
  return { ...binding, signature, accessToken: accessToken ?? undefined };
}

/** Sign the join statement with the Privy embedded wallet, minting it if new. */
async function signWithEmbeddedWallet(user: PrivyUser): Promise<WalletProof | null> {
  const instance = client;
  const modules = sdk;
  if (!instance || !modules) return null;

  let owner = user;
  if (!modules.getUserEmbeddedEthereumWallet(owner)) {
    // First sign-in for this account: Privy mints the wallet now, silently,
    // because the app is configured to provision wallets for its users.
    owner = (await instance.embeddedWallet.create({})).user;
  }

  const wallet = modules.getUserEmbeddedEthereumWallet(owner);
  if (!wallet) return null;

  const entropy = modules.getEntropyDetailsFromUser(owner);
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
}

/**
 * Sign the join statement with whichever wallet owns this session.
 *
 * Returns null -- never throws -- for every way this can fail: no session, no
 * wallet to sign with, no entropy to open one, or a rejected signature prompt.
 * The caller then joins as a guest, which is always a valid seat.
 *
 * The proof is single-use and short-lived (see `shared/identity.ts`), so this
 * runs per join rather than once per page.
 */
export async function signJoin(): Promise<WalletProof | null> {
  if (!client) return null;
  try {
    const user = await currentUser();
    if (!user) return null;

    const external = externalWallet?.address ?? externalEthereumAddress(user);
    return external
      ? await signWithExternalWallet(external)
      : await signWithEmbeddedWallet(user);
  } catch (error) {
    console.warn('[privy] could not sign the join statement:', error);
    return null;
  }
}

// --- signing out -----------------------------------------------------------

/**
 * End the session on this device.
 *
 * Local state goes first and revocation is best-effort -- the SDK does not
 * await the network round trip -- so this resolves quickly and works offline.
 * The caller reloads afterwards: every module here caches a session-shaped
 * assumption, and re-deriving all of them from a fresh page load is easier to
 * trust than unwinding each one in place.
 */
export async function signOut(): Promise<void> {
  const instance = client;
  externalWallet = null;
  if (!instance) return;
  try {
    const user = await currentUser();
    const id = (user as { id?: unknown } | null)?.id;
    await instance.auth.logout(user ? { userId: typeof id === 'string' ? id : undefined } : undefined);
  } catch (error) {
    console.warn('[privy] sign-out was not clean:', error);
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
