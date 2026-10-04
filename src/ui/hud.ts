/**
 * HUD
 *
 * DOM only. Reads game state, never mutates it — the HUD has no opinion
 * about the race, it just displays what the pure logic in game/race.ts says.
 */

import { formatTime } from '../game/race.ts';
import type { RaceState } from '../game/race.ts';

export interface Hud {
  /** Per-frame readout. */
  update(player: PlayerReadout, race: RaceState, courseName: string): void;
  /** Big centred banner for finish. Hidden by default. */
  showFinish(elapsedMs: number): void;
  hideBanner(): void;
  dispose(): void;
}

export interface PlayerReadout {
  grounded: boolean;
  horizontalSpeed: number;
  /** Metres above the kill plane. */
  heightAboveKill: number;
}

export function createHud(container: HTMLElement): Hud {
  const courseLabel = document.createElement('div');
  courseLabel.className = 'hud hud-course';
  container.appendChild(courseLabel);

  const timer = document.createElement('div');
  timer.className = 'hud hud-timer';
  container.appendChild(timer);

  const readout = document.createElement('div');
  readout.className = 'hud hud-readout';
  container.appendChild(readout);

  const banner = document.createElement('div');
  banner.className = 'banner';
  banner.hidden = true;
  container.appendChild(banner);

  const warning = document.createElement('div');
  warning.className = 'warning';
  warning.hidden = true;
  container.appendChild(warning);

  return {
    update(player, race, courseName) {
      courseLabel.textContent = courseName;

      timer.textContent = race.phase === 'ready'
        ? '--:--.---'
        : formatTime(race.finishedMs ?? race.elapsedMs);
      timer.classList.toggle('is-finished', race.phase === 'finished');

      readout.textContent =
        `${player.grounded ? 'grounded' : 'airborne'}  ` +
        `speed ${player.horizontalSpeed.toFixed(1)}  ` +
        `height ${player.heightAboveKill.toFixed(0)}`;

      // Only warn once falling is genuinely unrecoverable.
      warning.hidden = player.heightAboveKill > 6;
    },

    showFinish(elapsedMs) {
      banner.hidden = false;
      banner.innerHTML =
        `<div class="banner-title">FINISHED</div>` +
        `<div class="banner-time">${formatTime(elapsedMs)}</div>` +
        `<div class="banner-hint">press R to run again</div>`;
    },

    hideBanner() {
      banner.hidden = true;
    },

    dispose() {
      for (const el of [courseLabel, timer, readout, banner, warning]) {
        el.remove();
      }
    },
  };
}