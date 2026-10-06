/**
 * HUD
 *
 * DOM only. Displays replicated state and nothing else — every number shown
 * here is decided by the server. The HUD has no opinion about the race, which
 * is why two players looking at the same moment see the same clock.
 */

import { formatTime } from '../game/race.ts';
import { displayTime, type GameStateInstance, type PlayerStateInstance } from '../shared/state.ts';

export interface Hud {
  /** Per-frame readout of replicated state. */
  update(
    state: GameStateInstance,
    selfId: string,
    courseName: string,
    connection: ConnectionStatus,
  ): void;
  dispose(): void;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'lost';

export function createHud(container: HTMLElement): Hud {
  const course = div('hud hud-course', container);
  const timer = div('hud hud-timer', container);
  const banner = div('banner', container);
  banner.hidden = true;

  const connection = div('hud hud-connection', container);
  const board = div('board', container);
  const readout = div('hud hud-readout', container);

  return {
    update(state, selfId, courseName, status) {
      course.textContent = courseName;

      const self = state.players.get(selfId);

      // The server's clock, not a local stopwatch. A player's own time is
      // frozen at the moment they crossed the line, which is the only number
      // that matters once they are done.
      const shown = displayTime(state, selfId);
      timer.textContent =
        state.phase === 'ready' || shown === null ? '--:--.---' : formatTime(shown);
      timer.classList.toggle('is-finished', state.phase === 'finished');

      connection.textContent = status;
      connection.className = `hud hud-connection is-${status}`;

      readout.textContent =
        `${self?.grounded ? 'grounded' : 'airborne'}  ` +
        `speed ${(self?.speed ?? 0).toFixed(1)}`;

      renderBanner(banner, state, selfId);
      renderBoard(board, state, selfId);
    },

    dispose() {
      for (const el of [course, timer, banner, connection, board, readout]) el.remove();
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
 * The centred callout.
 *
 * Ready says what to do next, running stays out of the way, and finished shows
 * your time and place — the two things a racer wants at that moment.
 */
function renderBanner(
  banner: HTMLDivElement,
  state: GameStateInstance,
  selfId: string,
): void {
  const self = state.players.get(selfId);

  if (state.phase === 'ready') {
    banner.hidden = false;
    banner.innerHTML =
      `<div class="banner-title">GET READY</div>` +
      `<div class="banner-hint">move to start the race</div>`;
    return;
  }

  if (state.phase === 'finished' && self && self.finishedMs >= 0) {
    const place = ordinal(self.place);
    banner.hidden = false;
    banner.innerHTML =
      `<div class="banner-title">${place}</div>` +
      `<div class="banner-time">${formatTime(self.finishedMs)}</div>` +
      `<div class="banner-hint">next race shortly</div>`;
    return;
  }

  banner.hidden = true;
}

/** Live standings, sorted by finish then by distance along the lane. */
function renderBoard(
  board: HTMLDivElement,
  state: GameStateInstance,
  selfId: string,
): void {
  const rows: Array<{ player: PlayerStateInstance; id: string; progress: number }> = [];

  state.players.forEach((player, id) => {
    rows.push({ player, id, progress: player.finishedMs >= 0 ? Infinity : -player.z });
  });

  rows.sort((a, b) => {
    // Finishers first, ordered by place; then racers still going, furthest first.
    const aDone = a.player.finishedMs >= 0;
    const bDone = b.player.finishedMs >= 0;
    if (aDone && bDone) return a.player.place - b.player.place;
    if (aDone) return -1;
    if (bDone) return 1;
    return b.progress - a.progress;
  });

  board.innerHTML = rows
    .map(({ player, id }) => {
      const isSelf = id === selfId;
      const time =
        player.finishedMs >= 0
          ? formatTime(player.finishedMs)
          : player.place > 0 || player.finishedMs >= 0
            ? '—'
            : 'racing';
      return (
        `<div class="board-row${isSelf ? ' is-self' : ''}">` +
        `<span class="board-name">${escapeHtml(player.name)}</span>` +
        `<span class="board-time">${time}</span>` +
        `</div>`
      );
    })
    .join('');
}

function ordinal(place: number): string {
  if (place <= 0) return 'FINISHED';
  const suffix = place === 1 ? 'st' : place === 2 ? 'nd' : place === 3 ? 'rd' : 'th';
  return `${place}${suffix}`;
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