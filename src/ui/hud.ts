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

export interface Hud {
  /** Per-frame readout of replicated state. */
  update(
    state: GameStateInstance,
    selfId: string,
    courseName: string,
    connection: ConnectionStatus,
    sim: HudSim,
  ): void;
  dispose(): void;
}

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

export function createHud(container: HTMLElement): Hud {
  const course = div('hud hud-course', container);
  const timer = new Slot(div('hud hud-timer', container));
  const status = new Slot(div('hud hud-status', container));
  const hold = new Slot(div('hud hud-hold', container));
  const banner = new Slot(div('banner', container));
  const connection = div('hud hud-connection', container);
  const board = new Slot(div('board', container));
  const readout = new Slot(div('hud hud-readout', container));
  const dash = new Slot(div('hud hud-dash', container));
  const controls = div('hud hud-controls', container);
  controls.textContent = 'WASD / ARROWS move · SPACE jump · SHIFT dash · MOUSE look';

  // Cosmetic latch for the "TAKE IT" flash. Not game state: the server has
  // already moved to `playing`; this only decides how long the callout lingers.
  let lastPhase = '';
  let flashUntil = 0;
  let lastCourse = '';
  let lastConnection = '';

  return {
    update(state, selfId, courseName, linkStatus, sim) {
      const phase = state.phase;
      const self = state.players.get(selfId);

      if (phase === 'playing' && lastPhase === 'countdown') {
        flashUntil = performance.now() + GO_FLASH_MS;
      }
      lastPhase = phase;

      if (courseName !== lastCourse) {
        lastCourse = courseName;
        course.textContent = courseName;
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
      }

      // --- dash meter ------------------------------------------------------
      dash.hidden(!(playing || phase === 'countdown'));
      dash.html(dashMarkup(sim));

      readout.html(
        `${self?.grounded ? 'grounded' : 'airborne'}  speed ${(self?.speed ?? 0).toFixed(1)}`,
      );

      renderBanner(banner, state, selfId, performance.now() < flashUntil);

      board.hidden(!playing);
      if (playing) board.html(boardMarkup(state, selfId));
    },

    dispose() {
      for (const el of [
        course,
        timer.el,
        status.el,
        hold.el,
        banner.el,
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
