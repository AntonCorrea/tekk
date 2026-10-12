/**
 * The login card (Stage 3)
 *
 * Two cards live behind one entry point, because the app has two honest states:
 *
 *   - No `VITE_PRIVY_APP_ID`: the placeholder. Nothing off-chain is verified, so
 *     every row "succeeds" and records a method; it exists so the step is
 *     visible and the boot flow has a door where auth will sit.
 *   - Privy configured: the real card. Email one-time code, or the session
 *     Privy already restored, then one signed statement that binds the wallet
 *     to the join (see `shared/identity.ts`). Signing is part of logging in
 *     here, so there is no second prompt later: one signature per visit.
 *
 * The card owns the whole exchange and resolves with an outcome, not a bare
 * method string, because the boot needs the signed proof too. Every failure --
 * Privy unreachable, a wrong code, a rejected signature -- degrades to the
 * guest row rather than to a dead end. A racer who cannot log in can still
 * race; they just arrive without a wallet, and their match goes on-chain with
 * the zero address.
 *
 * `guestName` names the off-chain account underneath and is offered as the
 * always-available path out.
 */

import type { LoginMethod } from '../net/account.ts';
import {
  connect,
  currentUser,
  loginWithEmailCode,
  privyEnabled,
  sendEmailCode,
  signJoin,
  walletAddress,
} from '../net/privy.ts';
import type { WalletProof } from '../shared/identity.ts';

/** What the boot does with the card's answer. */
export interface LoginOutcome {
  /** The method the account records. `'guest'` when nothing was verified. */
  method: LoginMethod;
  /**
   * The signed join statement, when a wallet produced one. Absent means the
   * racer joins walletless -- a valid seat, with a zero address on-chain.
   */
  proof?: WalletProof;
  /** The address that signed, for the HUD. */
  wallet?: string;
}

interface Provider {
  method: LoginMethod;
  label: string;
  /** Brand-ish dot colour. Placeholder only; Privy ships real provider logos. */
  color: string;
}

/** The rows the placeholder offers: the dashboard-enabled list in a real build. */
const PROVIDERS: Provider[] = [
  { method: 'google', label: 'Continue with Google', color: '#4285f4' },
  { method: 'apple', label: 'Continue with Apple', color: '#c9ced6' },
  { method: 'twitter', label: 'Continue with Twitter', color: '#1da1f2' },
  { method: 'email', label: 'Continue with email', color: '#9ec7fa' },
  { method: 'passkey', label: 'Continue with a passkey', color: '#f086b8' },
  { method: 'wallet', label: 'Sign in with wallet', color: '#ff8a1f' },
];

/**
 * Show the login card and resolve with the outcome.
 *
 * The Privy path is chosen only when the app id is compiled in; otherwise this
 * is exactly the placeholder the prototype shipped, byte for byte, so a build
 * without credentials behaves as it always did.
 */
export function promptLogin(container: HTMLElement, guestName: string): Promise<LoginOutcome> {
  return privyEnabled() ? promptPrivy(container, guestName) : promptPlaceholder(container, guestName);
}

/** The off-chain placeholder. Nothing is verified; every row just records. */
function promptPlaceholder(container: HTMLElement, guestName: string): Promise<LoginOutcome> {
  const overlay = document.createElement('div');
  overlay.className = 'login';

  const rows = PROVIDERS.map(
    (p) =>
      `<button type="button" class="login-row" data-method="${p.method}">` +
      `<span class="login-dot" style="background:${p.color}"></span>` +
      `<span class="login-label">${p.label}</span>` +
      `</button>`,
  ).join('');

  overlay.innerHTML =
    `<div class="login-card">` +
    `<div class="login-brand">TEKK</div>` +
    `<div class="login-title">log in</div>` +
    `<div class="login-methods">${rows}</div>` +
    `<button type="button" class="login-row login-guest" data-method="guest">` +
    `<span class="login-dot" style="background:var(--ink-dim)"></span>` +
    `<span class="login-label">continue as guest · ${escapeHtml(guestName)}</span>` +
    `</button>` +
    `<div class="login-note">identity stays local until Privy is wired — these rows are placeholders</div>` +
    `</div>`;

  container.appendChild(overlay);

  return new Promise((resolve) => {
    overlay.addEventListener('click', (event) => {
      const btn =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-method]')
          : null;
      const method = btn?.dataset['method'] as LoginMethod | undefined;
      if (!method) return;

      if (method !== 'guest') {
        // The real flow hands off here: Privy opens its hosted modal, the
        // verified user object comes back, and the join carries it.
        console.info(`TEKK login: "${method}" tapped — real auth (Privy) lands here`);
      }
      overlay.remove();
      resolve({ method });
    });
  });
}

/** The real card: Privy auth, then one signed join statement. */
async function promptPrivy(container: HTMLElement, guestName: string): Promise<LoginOutcome> {
  const overlay = document.createElement('div');
  overlay.className = 'login';
  overlay.innerHTML =
    `<div class="login-card">` +
    `<div class="login-brand">TEKK</div>` +
    `<div class="login-title">log in</div>` +
    `<div class="login-status">starting privy…</div>` +
    `<button type="button" class="login-row login-resume" data-act="resume" hidden></button>` +
    `<form class="login-form">` +
    `<input class="login-input" type="email" name="email" placeholder="you@example.com" ` +
    `autocomplete="email" spellcheck="false" />` +
    `<input class="login-input" type="text" name="code" placeholder="6-digit code" ` +
    `inputmode="numeric" autocomplete="one-time-code" hidden />` +
    `<button class="login-row login-submit" type="submit">send login code</button>` +
    `</form>` +
    `<div class="login-error" hidden></div>` +
    `<button type="button" class="login-row login-guest" data-act="guest">` +
    `<span class="login-dot" style="background:var(--ink-dim)"></span>` +
    `<span class="login-label">continue as guest · ${escapeHtml(guestName)}</span>` +
    `</button>` +
    `<div class="login-note">privy · embedded wallet · one signature binds it to the match record</div>` +
    `</div>`;
  container.appendChild(overlay);

  const status = query<HTMLElement>(overlay, '.login-status');
  const form = query<HTMLFormElement>(overlay, '.login-form');
  const emailInput = query<HTMLInputElement>(overlay, '[name="email"]');
  const codeInput = query<HTMLInputElement>(overlay, '[name="code"]');
  const submit = query<HTMLButtonElement>(overlay, '.login-submit');
  const resume = query<HTMLButtonElement>(overlay, '.login-resume');
  const guest = query<HTMLButtonElement>(overlay, '[data-act="guest"]');
  const errorLine = query<HTMLElement>(overlay, '.login-error');

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

    /** Auth is done: bind the wallet to this seat and resolve. */
    const signIn = async (): Promise<void> => {
      say('sign the join statement…');
      const proof = await signJoin();
      if (proof) {
        finish({ method: 'email', proof, wallet: proof.address });
        return;
      }
      // Signed in, but no wallet proof: a valid seat with no on-chain identity.
      // Worth saying out loud, because the record will carry the zero address.
      console.warn('TEKK login: authenticated, but no wallet signature — joining as a guest seat');
      finish({ method: 'email', wallet: address ?? undefined });
    };

    guest.addEventListener('click', () => finish({ method: 'guest' }));

    resume.addEventListener('click', () => {
      resume.disabled = true;
      void signIn();
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
          address = walletAddress(user);
          await signIn();
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
        say('privy is unreachable — you can still race as a guest');
        form.hidden = true;
        return;
      }
      // A restored session means no code and no waiting: Privy kept the login.
      const user = await currentUser();
      if (!user || settled) return;
      address = walletAddress(user);
      resume.hidden = false;
      resume.innerHTML =
        `<span class="login-dot" style="background:#9ec7fa"></span>` +
        `<span class="login-label">continue as ${escapeHtml(shortAddress(address))}</span>`;
      say('signed in already — continue, or use another email');
    })();
  });
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
