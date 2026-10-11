/**
 * Login placeholder (off-chain)
 *
 * The screen a real Privy build replaces wholesale. Until then it exists so
 * the login step is *visible* and the boot flow has a door where auth will
 * sit: tap a provider row and the chosen method is recorded on the local
 * account (`net/account.ts`). There is nothing to verify off-chain, so every
 * button "succeeds" — that is the point of the prototype.
 *
 * The layout mirrors the Privy modal (a centred card, one row per sign-in
 * method, a privacy footnote) so the swap is a visual confirmation rather
 * than a rethink: the real thing renders this list from the methods enabled
 * in the Privy dashboard and only resolves once its session is authenticated.
 *
 * Nothing here reads the sim; the HUD and lobby stay untouched.
 */

import type { LoginMethod } from '../net/account.ts';

interface Provider {
  method: LoginMethod;
  label: string;
  /** Brand-ish dot colour. Placeholder only; Privy ships real provider logos. */
  color: string;
}

/** The rows the placeholder offers. The dashboard-enabled list in a real build. */
const PROVIDERS: Provider[] = [
  { method: 'google', label: 'Continue with Google', color: '#4285f4' },
  { method: 'apple', label: 'Continue with Apple', color: '#c9ced6' },
  { method: 'twitter', label: 'Continue with Twitter', color: '#1da1f2' },
  { method: 'email', label: 'Continue with email', color: '#9ec7fa' },
  { method: 'passkey', label: 'Continue with a passkey', color: '#f086b8' },
  { method: 'wallet', label: 'Sign in with wallet', color: '#ff8a1f' },
];

/**
 * Show the login card and resolve with the chosen method.
 *
 * `guestName` names the off-chain account underneath, offered as the guest
 * path so the placeholder always has a way in — the real build replaces this
 * with the Privy session state.
 */
export function promptLogin(container: HTMLElement, guestName: string): Promise<LoginMethod> {
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
      resolve(method);
    });
  });
}

/** Names in the card come from local storage, so escape before innerHTML. */
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