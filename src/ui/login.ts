/**
 * The login card (Stage 3)
 *
 * One card, three groups, and two honest states behind one entry point:
 *
 *   - Privy configured: the real card. An "Embedded wallet" group (emailed
 *     one-time code, Google, passkey), an "Own wallet" group (the wallet the
 *     browser already has), and a "No wallet" group (the guest seat). Whichever
 *     route is used, the racer then signs ONE statement that binds a wallet to
 *     the join (see `shared/identity.ts`), so there is no second prompt later:
 *     one signature per visit. The group a route sits in is also the wallet it
 *     signs with -- the code follows the card here, not the other way round,
 *     and a wallet linked on an earlier visit is not a choice about this match.
 *   - No `VITE_PRIVY_APP_ID`: nothing can be verified and no wallet can be
 *     made, so the routes that would not run are simply not drawn. Only the
 *     guest seat stays -- it is real, and it is honest about being all there is.
 *
 * Every failure -- Privy unreachable, a wrong code, a rejected signature, a
 * provider that refuses to return -- drops the card back to the guest group
 * rather than to a dead end. A racer who cannot log in can still race; they
 * just arrive without a wallet, and their match goes on-chain with the zero
 * address.
 *
 * The restore-session row is drawn from the first paint and disabled until a
 * session is really found, so the card never reflows under the racer's hand.
 */

import { loadAccount, type LoginMethod } from '../net/account.ts';
import {
  beginGoogleLogin,
  completeOAuthCallback,
  connect,
  currentUser,
  externalWalletAvailable,
  identityAddress,
  isOAuthCallback,
  loginWithEmailCode,
  loginWithExternalWallet,
  loginWithPasskey,
  passkeyAvailable,
  privyEnabled,
  sendEmailCode,
  signJoin,
} from '../net/privy.ts';
import type { Signer } from '../net/privy.ts';
import { randomRacerName } from '../shared/input.ts';
import type { WalletProof } from '../shared/identity.ts';

/** What the boot does with the card's answer. */
export interface LoginOutcome {
  /** The method the account records. `'guest'` when nothing was verified. */
  method: LoginMethod;
  /**
   * A fresh random racer handle, for the boot to adopt if the account has never
   * named itself. A name is off-chain and public, so it is minted rather than
   * lifted out of the email address or the Google account -- the standings show
   * it to everyone. Absent for the guest seat.
   */
  name?: string;
  /**
   * The signed join statement, when a wallet produced one. Absent means the
   * racer joins walletless -- a valid seat, with a zero address on-chain.
   */
  proof?: WalletProof;
  /** The address that signed, for the HUD. */
  wallet?: string;
}

/** The three groups the card is built from, and what each one is for. */
type GroupId = 'embedded' | 'own' | 'none';

const GROUPS: Record<GroupId, { label: string; hint: string }> = {
  embedded: {
    label: 'Embedded wallet',
    hint:
      'A wallet Privy makes for you the first time you race. Nothing to install, no ' +
      'seed phrase — your email, Google account or passkey controls it.',
  },
  own: {
    label: 'Own wallet',
    hint:
      'Use a wallet you already own. It signs the match, so your existing address ' +
      'gets the credit on-chain.',
  },
  none: {
    label: 'No wallet',
    hint:
      'Play without an account. The match still counts, but the record carries the ' +
      'zero address — nothing is credited to you.',
  },
};

/** A route row: the dot, the label, and the marker the handlers bind to. */
function routeRow(act: string, color: string, label: string, extraClass = ''): string {
  return (
    `<button type="button" class="login-row${extraClass ? ` ${extraClass}` : ''}" ` +
    `data-act="${act}">` +
    `<span class="login-dot" style="background:${color}"></span>` +
    `<span class="login-label">${label}</span>` +
    `</button>`
  );
}

/**
 * The door back into a session Privy already restored. Drawn enabled or not
 * from the first paint -- disabled until `currentUser()` actually finds one --
 * so the card does not change height once the SDK answers.
 */
function resumeRow(): string {
  return (
    `<button type="button" class="login-row login-resume" data-act="resume" disabled>` +
    `<span class="login-dot" style="background:#9ec7fa"></span>` +
    `<span class="login-label">no saved session on this device</span>` +
    `</button>`
  );
}

/** A group heading, its ⓘ, and the explanation that ⓘ reveals. */
function groupBlock(id: GroupId, rows: string): string {
  const { label, hint } = GROUPS[id];
  return (
    `<div class="login-group" data-group="${id}">` +
    `<div class="login-head">` +
    `<span class="login-head-label">${label}</span>` +
    `<button type="button" class="login-hint" data-hint="${id}" aria-expanded="false" ` +
    `aria-label="What does ${label.toLowerCase()} mean?">?</button>` +
    `</div>` +
    `<p class="login-hint-text" data-hint-text="${id}" hidden>${hint}</p>` +
    rows +
    `</div>`
  );
}

/** The ⓘ toggles: each one opens the explanation for its own group. */
function wireHints(overlay: HTMLElement): void {
  overlay.addEventListener('click', (event) => {
    const button =
      event.target instanceof Element ? event.target.closest<HTMLElement>('[data-hint]') : null;
    const id = button?.dataset['hint'];
    if (!button || !id) return;
    const text = overlay.querySelector<HTMLElement>(`[data-hint-text="${id}"]`);
    if (!text) return;
    const open = text.hidden;
    text.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  });
}

/** The top of the card: brand, tagline, the status line, and the door back. */
function cardChrome(status: string): string {
  return (
    `<div class="login-brand">TEKK</div>` +
    `<div class="login-tagline">Take it, Keep it, HODL it</div>` +
    (status ? `<div class="login-status">${status}</div>` : '') +
    resumeRow()
  );
}

/**
 * Show the login card and resolve with the outcome.
 *
 * The Privy path is chosen only when the app id is compiled in; otherwise only
 * the guest seat is offered, because it is the only route that is real.
 *
 * `_guestName` stays in the signature for the boot's call site; the card no
 * longer shows it -- the guest seat is one door, not a named identity.
 */
export function promptLogin(container: HTMLElement, _guestName: string): Promise<LoginOutcome> {
  return privyEnabled() ? promptPrivy(container) : promptPlaceholder(container);
}

/**
 * The off-chain card. Nothing here can be verified and nothing can mint a
 * wallet, so the routes that would not run are not drawn at all. What is left
 * is the guest seat, which was never a fallback.
 */
function promptPlaceholder(container: HTMLElement): Promise<LoginOutcome> {
  const overlay = document.createElement('div');
  overlay.className = 'login';
  overlay.innerHTML =
    `<div class="login-card">` +
    cardChrome('') +
    groupBlock('none', routeRow('guest', 'var(--ink-dim)', 'Login as a guest', 'login-guest')) +
    `</div>`;
  container.appendChild(overlay);
  wireHints(overlay);

  return new Promise((resolve) => {
    overlay.addEventListener('click', (event) => {
      const button =
        event.target instanceof Element ? event.target.closest<HTMLElement>('[data-act]') : null;
      if (button?.dataset['act'] !== 'guest') return;
      overlay.remove();
      resolve({ method: 'guest' });
    });
  });
}

/** The real card: Privy auth, then one signed join statement. */
async function promptPrivy(container: HTMLElement): Promise<LoginOutcome> {
  const overlay = document.createElement('div');
  overlay.className = 'login';
  // Coming back from Google is not a fresh login: say so, so the card does not
  // read as a login that has not started.
  const returning = isOAuthCallback();

  const embedded =
    routeRow('mail', '#c69dfa', 'Login with mail') +
    // Revealed by the mail row rather than standing open, so the three groups
    // read as three doors instead of a form with buttons around it.
    `<form class="login-form" hidden>` +
    `<input class="login-input" type="email" name="email" placeholder="you@example.com" ` +
    `autocomplete="email" spellcheck="false" />` +
    `<input class="login-input" type="text" name="code" placeholder="6-digit code" ` +
    `inputmode="numeric" autocomplete="one-time-code" hidden />` +
    `<button class="login-row login-submit" type="submit">send login code</button>` +
    `</form>` +
    routeRow('google', '#4285f4', 'Login with Google') +
    // Offered only where the browser can run a WebAuthn ceremony at all.
    (passkeyAvailable() ? routeRow('passkey', '#f086b8', 'Login with passkey') : '');

  // The wallet group is only honest when a wallet is actually there to sign,
  // and a heading with no rows under it reads as broken -- so it goes whole.
  const own = externalWalletAvailable()
    ? routeRow('wallet', '#ff8a1f', 'Login using your own wallet')
    : '';

  overlay.innerHTML =
    `<div class="login-card">` +
    cardChrome(returning ? 'finishing sign-in…' : 'starting privy…') +
    groupBlock('embedded', embedded) +
    (own ? groupBlock('own', own) : '') +
    groupBlock('none', routeRow('guest', 'var(--ink-dim)', 'Login as a guest', 'login-guest')) +
    `<div class="login-error" hidden></div>` +
    `<div class="login-note">Powered by Privy</div>` +
    `</div>`;
  container.appendChild(overlay);
  wireHints(overlay);

  const status = query<HTMLElement>(overlay, '.login-status');
  const form = query<HTMLFormElement>(overlay, '.login-form');
  const emailInput = query<HTMLInputElement>(overlay, '[name="email"]');
  const codeInput = query<HTMLInputElement>(overlay, '[name="code"]');
  const submit = query<HTMLButtonElement>(overlay, '.login-submit');
  const resume = query<HTMLButtonElement>(overlay, '.login-resume');
  const resumeLabel = query<HTMLElement>(resume, '.login-label');
  const mail = query<HTMLButtonElement>(overlay, '[data-act="mail"]');
  const guest = query<HTMLButtonElement>(overlay, '[data-act="guest"]');
  const google = query<HTMLButtonElement>(overlay, '[data-act="google"]');
  const passkeyButton = overlay.querySelector<HTMLButtonElement>('[data-act="passkey"]');
  const walletButton = overlay.querySelector<HTMLButtonElement>('[data-act="wallet"]');
  const errorLine = query<HTMLElement>(overlay, '.login-error');
  const note = query<HTMLElement>(overlay, '.login-note');

  // "Continue" is the one route with no row of its own, so it inherits what
  // this device chose last time instead of guessing. `guest` means the local
  // account never signed in -- cleared storage, most likely -- so a session
  // Privy kept on its own is labelled and signed as the Privy wallet, the only
  // identity left that can be named.
  const previous = loadAccount().loginMethod;
  const resumeSigner: Signer = previous === 'wallet' ? 'own' : 'embedded';
  const resumeMethod: LoginMethod = previous === 'guest' ? 'email' : previous;

  return new Promise<LoginOutcome>((resolve) => {
    let settled = false;
    let stage: 'email' | 'code' = 'email';
    let address: string | null = null;

    const finish = (outcome: LoginOutcome): void => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(outcome);
    };

    const say = (text: string): void => {
      status.textContent = text;
    };

    const complain = (text: string): void => {
      errorLine.textContent = text;
      errorLine.hidden = false;
    };

    const clearError = (): void => {
      errorLine.hidden = true;
      errorLine.textContent = '';
    };

    /**
     * Auth is done: bind the wallet to this seat and resolve.
     *
     * `method` is what the account records and `signer` is which wallet the
     * route means. They are separate because three routes share one wallet:
     * mail, Google and passkey all mean the Privy wallet, and only the wallet
     * row means the racer's own.
     */
    const signIn = async (method: LoginMethod, signer: Signer): Promise<void> => {
      say('sign the join statement…');
      const proof = await signJoin(signer);
      // A fresh handle for this racer, for the boot to adopt if the account has
      // never named itself. Minted here, never read off the login: a Google
      // display name or an email local part is the racer's to publish, and the
      // board shows this to everyone.
      const name = randomRacerName();
      if (proof) {
        finish({ method, name, proof, wallet: proof.address });
        return;
      }
      // Signed in, but no wallet proof: a valid seat with no on-chain identity.
      // Worth saying out loud, because the record will carry the zero address.
      console.warn('TEKK login: authenticated, but no wallet signature — joining as a guest seat');
      finish({ method, name, wallet: address ?? undefined });
    };

    /** Shared shape for the two row-triggered routes that can fail. */
    const runRoute = async (label: string, run: () => Promise<void>): Promise<void> => {
      clearError();
      say(label);
      try {
        await run();
      } catch (error) {
        complain(error instanceof Error ? error.message : String(error));
        say('try another way in');
      }
    };

    guest.addEventListener('click', () => finish({ method: 'guest' }));

    resume.addEventListener('click', () => {
      resume.disabled = true;
      void signIn(resumeMethod, resumeSigner);
    });

    mail.addEventListener('click', () => {
      clearError();
      form.hidden = false;
      mail.setAttribute('aria-expanded', 'true');
      emailInput.focus();
    });

    google.addEventListener('click', () => {
      // Does not come back in the success case: the page navigates away, and
      // the flow resumes at the top of `promptPrivy` on the return trip.
      void runRoute('opening Google…', async () => {
        google.disabled = true;
        await beginGoogleLogin();
      });
    });

    walletButton?.addEventListener('click', () => {
      void runRoute('waiting for your wallet…', async () => {
        walletButton.disabled = true;
        const user = await loginWithExternalWallet();
        address = identityAddress(user, 'own');
        await signIn('wallet', 'own');
      });
    });

    passkeyButton?.addEventListener('click', () => {
      void runRoute('waiting for your passkey…', async () => {
        passkeyButton.disabled = true;
        try {
          const user = await loginWithPasskey();
          address = identityAddress(user, 'embedded');
          await signIn('passkey', 'embedded');
        } catch (error) {
          // Dismissing the prompt is the ordinary way this fails, and the row
          // is the only way in that needs it -- so it goes back to being
          // clickable, with the reason left on screen.
          passkeyButton.disabled = false;
          throw error;
        }
      });
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void (async () => {
        clearError();
        submit.disabled = true;
        try {
          if (stage === 'email') {
            const email = emailInput.value.trim();
            if (email.length === 0) {
              complain('enter an email address');
              return;
            }
            say('sending a login code…');
            await sendEmailCode(email);
            stage = 'code';
            codeInput.hidden = false;
            emailInput.readOnly = true;
            submit.textContent = 'verify & sign in';
            say(`code sent to ${email}`);
            codeInput.focus();
            return;
          }

          const code = codeInput.value.trim();
          if (code.length === 0) {
            complain('enter the code from your email');
            return;
          }
          say('checking the code…');
          const user = await loginWithEmailCode(emailInput.value.trim(), code);
          address = identityAddress(user, 'embedded');
          await signIn('email', 'embedded');
        } catch (error) {
          // Privy's own message is the useful one (bad code, rate limit), so it
          // is shown as-is rather than replaced with something generic.
          complain(error instanceof Error ? error.message : String(error));
          say('try again');
        } finally {
          submit.disabled = false;
        }
      })();
    });

    void (async () => {
      if (!(await connect())) {
        // No Privy, so none of the three real routes can run. Collapse to the
        // one seat that is always real and say why.
        say('privy is unreachable — you can still race as a guest');
        for (const group of overlay.querySelectorAll<HTMLElement>('[data-group]')) {
          group.hidden = group.dataset['group'] !== 'none';
        }
        note.hidden = true;
        return;
      }
      if (settled) return;

      // This page load may BE the return trip from Google. Rounds out the
      // session and skips the card entirely -- there is nothing left to ask.
      try {
        const returned = await completeOAuthCallback();
        if (returned) {
          address = identityAddress(returned, 'embedded');
          await signIn('google', 'embedded');
          return;
        }
      } catch (error) {
        complain(error instanceof Error ? error.message : String(error));
        say('that sign-in did not complete — try again');
      }
      if (settled) return;

      // A restored session means no code and no waiting: Privy kept the login.
      // The row was always there; this is the moment it becomes clickable.
      const user = await currentUser();
      if (!user || settled) return;
      address = identityAddress(user, resumeSigner);
      resume.disabled = false;
      resumeLabel.textContent = `continue as ${shortAddress(address)}`;
      say('signed in already — continue, or use another method');
    })();
  });
}

/**
 * A small persistent "who is signed in" chip with a way out.
 *
 * The card is gone by the time the game is running, and without this there is
 * no way to switch accounts short of clearing site data. The chip is the
 * account switcher: signing out reloads into the card again, which is also the
 * only honest way to re-run a login -- every module here caches a
 * session-shaped assumption, and a fresh page load re-derives all of them.
 */
export function showIdentityChip(
  container: HTMLElement,
  identity: { method: LoginMethod; wallet: string | null },
  onSignOut: () => void,
): void {
  const chip = document.createElement('div');
  chip.className = 'identity-chip';
  chip.innerHTML =
    `<span class="identity-who">${escapeHtml(identity.method)}</span>` +
    `<span class="identity-wallet">${escapeHtml(identity.wallet ? shortAddress(identity.wallet) : 'no wallet')}</span>`;

  const out = document.createElement('button');
  out.type = 'button';
  out.className = 'identity-out';
  out.textContent = 'sign out';
  out.addEventListener('click', () => {
    out.disabled = true;
    onSignOut();
  });
  chip.appendChild(out);
  container.appendChild(chip);
}

/** `0x1234…abcd`, or a stand-in when there is no address at all. */
function shortAddress(address: string | null): string {
  if (!address) return 'your account';
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** Query a required element, failing loudly rather than at first use. */
function query<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`login card is missing ${selector}`);
  return found;
}

/** Names and addresses come from outside, so escape before innerHTML. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
