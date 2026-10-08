/**
 * HUD
 *
 * DOM only. Displays replicated state and nothing else — every number shown
 * here is decided by the server: the match clock, who carries the Core, each
 * racer's hold time and the final ranking. The one exception is the dash meter,
 * which reads YOUR predicted sim because a cooldown that arrives 100ms late
 * would feel broken.
 *
 * Nothing is rewritten unless it changed. Each readout lives in a `Slot` that
 * remembers the markup it last wrote, so a frame with nothing new touches no
 * DOM at all — rewriting innerHTML every frame restarted CSS animations,
 * re-parsed the same markup 60x/sec and made text unselectable mid-update.
 */

import { DASH, MATCH } from '../constants.ts';
import type { GameStateInstance, PlayerStateInstance } from '../shared/state.ts';
import type { SimBody } from '../shared/sim.ts';

/** The slice of the predicted sim the HUD reads. */
export type HudSim = Pick<SimBody, 'dashTicks' | 'dashCooldownTicks' | 'carrying'>;

/** The slice of the course the HUD shows: the name, and the id cards mark as current. */
export type HudCourse = { id: string; name: string };

export interface Hud {
  /** Per-frame readout of replicated state. */
  update(
    state: GameStateInstance,
    selfId: string,
    course: HudCourse,
    connection: ConnectionStatus,
    sim: HudSim,
  ): void;
  /**
   * A one-shot callout for the big moments: you took the Core, it was stolen
   * from you. Replaces whatever callout is still showing, so rapid steals never
   * stack into a pile of text.
   */
  announce(text: string, tone: AnnounceTone): void;
  dispose(): void;
}

export interface HudOptions {
  /**
   * A map card was clicked. The id is taken from `state.catalog`, which the
   * server shipped — the HUD only ever echoes back an id it was given, and
   * the server re-checks it anyway.
   */
  onVote?(courseId: string): void;

  /**
   * Toggle your mid-match skip vote. Carries the explicit desired value
   * rather than "flip it", so a stale click against a tally the server has
   * already moved cannot invert what was meant.
   */
  onSkip?(value: boolean): void;
}

/** `gain` is good for you, `loss` is bad for you, `info` is someone else's moment. */
export type AnnounceTone = 'gain' | 'loss' | 'info';

/** How long a callout stays up. Matches the CSS animation in style.css. */
const ANNOUNCE_MS = 1100;

export type ConnectionStatus = 'connecting' | 'connected' | 'lost';

/** How long the "TAKE IT" flash holds after the countdown ends. Cosmetic only. */
const GO_FLASH_MS = 900;

const TAGLINE = 'take it. keep it. hodl it.';

/**
 * Write-on-change wrapper around an element's innerHTML.
 *
 * Comparing the markup string is the simplest key that cannot go stale: if the
 * rendered content is identical, nothing is written.
 */
class Slot {
  private last = '';
  private hiddenNow: boolean | null = null;

  readonly el: HTMLElement;

  constructor(el: HTMLElement) {
    this.el = el;
  }

  html(markup: string): void {
    if (markup === this.last) return;
    this.last = markup;
    this.el.innerHTML = markup;
  }

  hidden(value: boolean): void {
    if (value === this.hiddenNow) return;
    this.hiddenNow = value;
    this.el.hidden = value;
  }
}

export function createHud(container: HTMLElement, options: HudOptions = {}): Hud {
  const courseLabel = div('hud hud-course', container);
  const timer = new Slot(div('hud hud-timer', container));
  const status = new Slot(div('hud hud-status', container));
  const hold = new Slot(div('hud hud-hold', container));
  const banner = new Slot(div('banner', container));
  const lobby = new Slot(div('lobby', container));
  lobby.el.hidden = true;
  // Delegated on the container, not on the cards: the Slot rewrites the
  // cards' innerHTML whenever the tally moves, and per-card listeners would
  // die with each rewrite. Clicking a card in a locked-pointer game would
  // otherwise also leave focus behind — blur so Space keeps meaning jump.
  lobby.el.addEventListener('click', (event) => {
    const target =
      event.target instanceof Element ? event.target.closest<HTMLElement>('[data-course]') : null;
    const courseId = target?.dataset['course'];
    if (!courseId) return;
    target.blur();
    options.onVote?.(courseId);
  });
  const skip = new Slot(div('skip', container));
  skip.el.hidden = true;
  // Same delegation as the ballot above: the tally rewrites the pill's
  // markup whenever any racer votes, and the listener lives on the wrapper.
  // Blur for the same reason — mid-race, focus here would turn Space into a
  // skip click instead of a jump.
  skip.el.addEventListener('click', (event) => {
    const target =
      event.target instanceof Element ? event.target.closest<HTMLElement>('[data-skip]') : null;
    const next = target?.dataset['skip'];
    if (!target || next === undefined) return;
    target.blur();
    options.onSkip?.(next === '1');
  });
  const connection = div('hud hud-connection', container);
  const board = new Slot(div('board', container));
  const readout = new Slot(div('hud hud-readout', container));
  const dash = new Slot(div('hud hud-dash', container));
  const announcer = div('announce', container);
  announcer.hidden = true;
  let announceTimer = 0;
  const controls = div('hud hud-controls', container);
  controls.textContent = 'WASD / ARROWS move · SPACE jump · SHIFT dash · MOUSE look · M mute';

  // Cosmetic latch for the "TAKE IT" flash. Not game state: the server has
  // already moved to `playing`; this only decides how long the callout lingers.
  let lastPhase = '';
  let flashUntil = 0;
  let lastCourse = '';
  let lastConnection = '';
  // Whole seconds of your hold time last frame, for the per-second pop.
  let lastHoldSecond = -1;

  return {
    update(state, selfId, course, linkStatus, sim) {
      const phase = state.phase;
      const self = state.players.get(selfId);

      if (phase === 'playing' && lastPhase === 'countdown') {
        flashUntil = performance.now() + GO_FLASH_MS;
      }
      lastPhase = phase;

      if (course.name !== lastCourse) {
        lastCourse = course.name;
        courseLabel.textContent = course.name;
      }
      if (linkStatus !== lastConnection) {
        lastConnection = linkStatus;
        connection.textContent = linkStatus;
        connection.className = `hud hud-connection is-${linkStatus}`;
      }

      const playing = phase === 'playing';

      // --- match clock ---------------------------------------------------
      // Countdown and ready show the full match length and results shows zero,
      // so the clock's slot never looks broken between matches.
      const clockMs = playing ? state.phaseRemainingMs : phase === 'results' ? 0 : MATCH.durationMs;
      timer.html(
        `<span class="${playing && clockMs <= 10_000 ? 'is-low' : ''}">${formatClock(clockMs)}</span>`,
      );

      // --- status line + own hold time ----------------------------------
      const carrierId = state.carrierId;
      status.hidden(!playing);
      hold.hidden(!playing);
      if (playing) {
        const carrier = carrierId === '' ? undefined : state.players.get(carrierId);
        if (carrierId === selfId) {
          status.html(`<span class="is-you">YOU HAVE THE CORE — RUN</span>`);
        } else if (carrier) {
          status.html(`<span class="is-them">${escapeHtml(carrier.name)} HAS THE CORE</span>`);
        } else {
          status.html(`<span class="is-free">THE CORE IS FREE</span>`);
        }
        hold.html(
          `<span class="hold-label">YOUR HOLD</span><span class="hold-time">${formatHold(self?.holdMs ?? 0, true)}</span>`,
        );

        // Every whole second you bank pops the counter: the score visibly
        // climbing is the reward loop of the whole game.
        const holdSecond = Math.floor((self?.holdMs ?? 0) / 1000);
        if (holdSecond !== lastHoldSecond) {
          if (holdSecond > lastHoldSecond && lastHoldSecond >= 0 && carrierId === selfId) {
            restartAnimation(hold.el, 'is-tick');
          }
          lastHoldSecond = holdSecond;
        }
      }

      // --- dash meter ------------------------------------------------------
      dash.hidden(!(playing || phase === 'countdown'));
      dash.html(dashMarkup(sim));

      readout.html(
        `${self?.grounded ? 'grounded' : 'airborne'}  speed ${(self?.speed ?? 0).toFixed(1)}`,
      );

      renderBanner(banner, state, selfId, performance.now() < flashUntil);

      // --- the map ballot ---------------------------------------------------
      // Only in the two lobby windows, and only when the server shipped a
      // catalog to pick from. Votes themselves are server state: this just
      // draws who has voted for what.
      const voting = (phase === 'ready' || phase === 'results') && state.catalog.length > 0;
      lobby.hidden(!voting);
      if (voting) lobby.html(lobbyMarkup(state, course, selfId));

      // --- the skip vote ---------------------------------------------------
      // Mid-match only — the pill is a control, not a readout, and in a
      // lobby window the ballot below already carries the decision.
      const skipping = phase === 'countdown' || phase === 'playing';
      skip.hidden(!skipping);
      if (skipping) skip.html(skipMarkup(state, selfId));

      board.hidden(!playing);
      if (playing) board.html(boardMarkup(state, selfId));
    },

    announce(text, tone) {
      announcer.textContent = text;
      announcer.className = `announce is-${tone}`;
      announcer.hidden = false;
      restartAnimation(announcer, 'is-live');
      clearTimeout(announceTimer);
      announceTimer = window.setTimeout(() => {
        announcer.hidden = true;
      }, ANNOUNCE_MS);
    },

    dispose() {
      clearTimeout(announceTimer);
      announcer.remove();
      for (const el of [
        courseLabel,
        timer.el,
        status.el,
        hold.el,
        banner.el,
        lobby.el,
        skip.el,
        connection,
        board.el,
        readout.el,
        dash.el,
        controls,
      ]) {
        el.remove();
      }
    },
  };
}

/**
 * Re-run a CSS animation from its first frame. Removing and re-adding the
 * class is not enough on its own -- the browser coalesces it -- so a layout
 * read in between forces the restart.
 */
function restartAnimation(el: HTMLElement, className: string): void {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

function div(className: string, parent: HTMLElement): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  parent.appendChild(el);
  return el;
}

/**
 * The dash readout, from the predicted sim.
 *
 * Fill is quantised to 5% steps: the cooldown is 72 ticks, so finer than that
 * is invisible and would only force a write every frame.
 */
function dashMarkup(sim: HudSim): string {
  if (sim.carrying) {
    return `<span class="dash-label is-locked">CARRIER CAN'T DASH</span>`;
  }
  if (sim.dashTicks > 0) {
    return `<span class="dash-label is-active">DASH</span><span class="dash-bar"><i style="width:100%"></i></span>`;
  }
  if (sim.dashCooldownTicks > 0) {
    const fill = 1 - Math.min(1, sim.dashCooldownTicks / DASH.cooldownTicks);
    const pct = Math.round(fill * 20) * 5;
    return `<span class="dash-label is-cooling">DASH</span><span class="dash-bar"><i style="width:${pct}%"></i></span>`;
  }
  return `<span class="dash-label is-ready">DASH READY</span><span class="dash-bar is-ready"><i style="width:100%"></i></span>`;
}

/**
 * The centred callout, by phase.
 *
 * ready: what to do. countdown: the number. just-started: a flash. playing:
 * nothing, out of the way. results: who won and the full standings.
 */
function renderBanner(
  banner: Slot,
  state: GameStateInstance,
  selfId: string,
  flashing: boolean,
): void {
  switch (state.phase) {
    case 'ready':
      banner.hidden(false);
      banner.html(
        `<div class="banner-title">MOVE TO START</div><div class="banner-hint">${TAGLINE}</div>`,
      );
      return;

    case 'countdown': {
      const n = Math.max(1, Math.ceil(state.phaseRemainingMs / 1000));
      banner.hidden(false);
      banner.html(`<div class="banner-count">${n}</div><div class="banner-hint">get in position</div>`);
      return;
    }

    case 'playing':
      if (flashing) {
        banner.hidden(false);
        banner.html(`<div class="banner-go">TAKE IT</div>`);
      } else {
        banner.hidden(true);
      }
      return;

    case 'results': {
      const winner = state.winnerId === '' ? undefined : state.players.get(state.winnerId);
      const title = winner ? `${escapeHtml(winner.name)} HODLED IT` : 'NO WINNER';
      const next = Math.max(0, Math.ceil(state.phaseRemainingMs / 1000));
      const list = sortedPlayers(state, true)
        .map(({ player, id }, i) => {
          const cls = `result-row${id === selfId ? ' is-self' : ''}${id === state.winnerId ? ' is-winner' : ''}`;
          const place = player.rank > 0 ? player.rank : i + 1;
          return (
            `<div class="${cls}"><span class="result-rank">${place}</span>` +
            `<span class="result-name">${escapeHtml(player.name)}</span>` +
            `<span class="result-time">${formatHold(player.holdMs, true)}</span></div>`
          );
        })
        .join('');
      banner.hidden(false);
      banner.html(
        `<div class="banner-title is-result${winner ? ' has-winner' : ''}">${title}</div>` +
          `<div class="results">${list}</div>` +
          `<div class="banner-hint">next match in ${next}</div>`,
      );
      return;
    }

    default:
      banner.hidden(true);
  }
}

/**
 * The map ballot: one card per catalog entry, who has voted for what, and
 * when the votes count.
 *
 * Everything on it is server state — the catalog decides which cards exist,
 * `votedFor` decides whose names appear under them. The running map is
 * marked rather than hidden, because staying put is a real outcome of a tie
 * or an empty ballot, and a card that vanished the moment it won would read
 * as a bug.
 */
function lobbyMarkup(
  state: GameStateInstance,
  course: HudCourse,
  selfId: string,
): string {
  const settle =
    state.phase === 'results'
      ? 'votes settle when the lobby resets'
      : 'votes settle when someone starts the countdown';

  const cards = state.catalog
    .map((info) => {
      const voters: string[] = [];
      state.players.forEach((player, id) => {
        if (player.votedFor === info.id) voters.push(id === selfId ? 'you' : player.name);
      });
      const current = info.id === course.id;
      const mine = state.players.get(selfId)?.votedFor === info.id;
      const cls = `map-card${current ? ' is-current' : ''}${mine ? ' is-voted' : ''}`;
      const votes =
        voters.length > 0
          ? `<span class="map-votes">${escapeHtml(voters.join(' · '))}</span>`
          : '';
      const now = current ? `<span class="map-now">now running</span>` : '';
      return (
        `<button type="button" class="${cls}" data-course="${escapeHtml(info.id)}">` +
        `<span class="map-name">${escapeHtml(info.name)}</span>` +
        `<span class="map-stats">${info.solids} solids · ${info.pads} pads</span>` +
        votes +
        now +
        `</button>`
      );
    })
    .join('');

  return (
    `<div class="lobby-head">vote the next map</div>` +
    `<div class="lobby-cards">${cards}</div>` +
    `<div class="lobby-hint">${settle}</div>`
  );
}

/**
 * The mid-match skip pill: your vote, and the tally the server weighs.
 *
 * `n/m` is skip votes over everyone connected — abstaining counts as a vote
 * to play on, which is exactly what it means to the majority rule, so the
 * pill shows the real threshold rather than a count of voters.
 *
 * The next value travels in `data-skip`: the wrapper rewrites this markup
 * whenever any racer votes, and the click handler reads back what was shown
 * instead of tracking state the tally has since moved past.
 */
function skipMarkup(state: GameStateInstance, selfId: string): string {
  let votes = 0;
  let mine = false;
  state.players.forEach((player, id) => {
    if (player.votedToSkip) votes += 1;
    if (id === selfId) mine = player.votedToSkip;
  });

  const cls = mine ? 'skip-btn is-voted' : 'skip-btn';
  const label = mine ? 'skip ✓' : 'skip match';
  return (
    `<button type="button" class="${cls}" data-skip="${mine ? '0' : '1'}">` +
    `<span class="skip-label">${label}</span>` +
    `<span class="skip-count">${votes}/${state.players.size}</span>` +
    `</button>`
  );
}

/** Live standings by hold time, with the carrier marked. */
function boardMarkup(state: GameStateInstance, selfId: string): string {
  return sortedPlayers(state, false)
    .map(({ player, id }) => {
      const cls = `board-row${id === selfId ? ' is-self' : ''}${id === state.carrierId ? ' is-carrier' : ''}`;
      // Whole seconds on the board: tenths would change it ten times a second
      // for every row, and the ordering is what matters here.
      return (
        `<div class="${cls}"><span class="board-name">${escapeHtml(player.name)}</span>` +
        `<span class="board-time">${formatHold(player.holdMs, false)}</span></div>`
      );
    })
    .join('');
}

interface Row {
  player: PlayerStateInstance;
  id: string;
}

/**
 * Players ordered by score. Results prefer the server's final `rank` (which
 * already applies the lastHeldAtMs tiebreak); live play falls back to holdMs
 * with the same tiebreak so the board does not shuffle ties arbitrarily.
 */
function sortedPlayers(state: GameStateInstance, final: boolean): Row[] {
  const rows: Row[] = [];
  state.players.forEach((player, id) => rows.push({ player, id }));
  rows.sort((a, b) => {
    if (final && a.player.rank > 0 && b.player.rank > 0) return a.player.rank - b.player.rank;
    if (b.player.holdMs !== a.player.holdMs) return b.player.holdMs - a.player.holdMs;
    return b.player.lastHeldAtMs - a.player.lastHeldAtMs;
  });
  return rows;
}

/** M:SS, rounding up so the clock reads 0:01 until it is truly over. */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Hold time as M:SS, or M:SS.t when `tenths` — floored, since it is accrued time. */
function formatHold(ms: number, tenths: boolean): string {
  const safe = Math.max(0, ms);
  const total = Math.floor(safe / 1000);
  const base = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  return tenths ? `${base}.${Math.floor((safe % 1000) / 100)}` : base;
}

/**
 * Racer names come from other players, so they are untrusted text going into
 * innerHTML. Strip anything that could close the element.
 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}
