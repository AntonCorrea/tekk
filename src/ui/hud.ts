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
import type { GameMode } from '../shared/course.ts';
import { TRAILS, BODY_COLORS, HATS, GEARS } from '../shared/cosmetics.ts';

/** The slice of the predicted sim the HUD reads. */
export type HudSim = Pick<SimBody, 'dashTicks' | 'dashCooldownTicks' | 'carrying'>;

/**
 * The slice of the course the HUD shows: the name, the id cards mark as
 * current, and — for the racing modes — the mode and how many cores a hunt map
 * hides. Typed from the parsed `Course` so the caller can pass it straight
 * through; `mode` and `cores` are optional because a `hold` course declares
 * neither.
 */
export type HudCourse = { id: string; name: string; mode?: string; cores?: readonly unknown[] };

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
  /**
   * A small, quiet confirmation pill — "unlocked the Golden body". Unlike
   * `announce`, several toasts may be up at once and each fades on its own
   * timer, so collecting two balls in a row stacks instead of clobbering.
   */
  toast(text: string): void;
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
   * A trail card was clicked. The id comes from the LOCAL account's wardrobe,
   * and the server validates both existence and ownership before it lands on
   * the wire — this is just the click becoming a request.
   */
  onEquip?(trailId: string): void;

  /**
   * The trail ids the local account owns, live. This is off-chain state (the
   * account in net/account.ts), so the HUD cannot read it from replicated
   * state; it asks the caller instead. Re-read per lobby render so an equip
   * never draws a stale wardrobe.
   */
  ownedTrails?(): readonly string[];

  /**
   * A body-colour card was clicked. Same contract as `onEquip`: the id comes
   * from the LOCAL account's wardrobe, and the server validates both
   * existence and ownership before it lands on the wire.
   */
  onEquipColor?(colorId: string): void;

  /**
   * The body-colour ids the local account owns, live. Same off-chain source
   * and the same re-read-per-lobby-render rule as `ownedTrails`.
   */
  ownedBodyColors?(): readonly string[];

  /**
   * A hat card was clicked. Same contract as `onEquip`: the id comes from the
   * LOCAL account's wardrobe, and the server validates both existence and
   * ownership before it lands on the wire.
   */
  onEquipHat?(hatId: string): void;

  /**
   * The hat ids the local account owns, live. Same off-chain source and the
   * same re-read-per-lobby-render rule as `ownedTrails`.
   */
  ownedHats?(): readonly string[];

  /**
   * A gear card was clicked. Same contract as `onEquip`: the id comes from
   * the LOCAL account's wardrobe, and the server validates both existence and
   * ownership before it lands on the wire.
   */
  onEquipGear?(gearId: string): void;

  /**
   * The gear ids the local account owns, live. Same off-chain source and the
   * same re-read-per-lobby-render rule as `ownedTrails`.
   */
  ownedGears?(): readonly string[];

  /**
   * A new racer name was committed in the customize panel. The id comes from
   * the local input field; the server sanitises and echoes it, so this is just
   * the commit becoming a request.
   */
  onRename?(name: string): void;

  /**
   * The local account's best finish time (ms) for a course, if it has one.
   * Off-chain state (net/account.ts), so like the wardrobe the HUD asks the
   * caller rather than reading it off the wire. Unused by `hold`, whose score
   * is banked hold time.
   */
  personalBest?(courseId: string): number | undefined;
}

/** `gain` is good for you, `loss` is bad for you, `info` is someone else's moment. */
export type AnnounceTone = 'gain' | 'loss' | 'info';

/** Display names for the three modes, shared by the HUD and the map cards. */
const MODE_NAMES: Record<GameMode, string> = {
  hold: 'Core Rush',
  reach: 'Race to the Core',
  hunt: 'Core Hunt',
};

/** How long a callout stays up. Matches the CSS animation in style.css. */
const ANNOUNCE_MS = 1100;

/** How long an unlock toast stays up, plus the fade-out headroom. */
const TOAST_MS = 2600;

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
  // The lobby is two separate panels — customize avatar (name, trail, colour,
  // hat, gear) and the map ballot — toggled by a button pair pinned to the top-right
  // corner, one panel open at a time. The panels' skeletons are built once and
  // only the card rows rewrite; the name field must survive re-renders whole
  // (a rebuilt input would drop the caret mid-type), so its value is synced
  // from the echoed server name only when it is not focused.
  const lobby = div('lobby', container);
  const customizeToggle = button('lobby-toggle', 'customize', lobby);
  customizeToggle.setAttribute('data-panel', 'customize');
  const voteToggle = button('lobby-toggle', 'vote map', lobby);
  voteToggle.setAttribute('data-panel', 'vote');

  const customizePanel = div('lobby-panel is-customize', container);
  customizePanel.hidden = true;
  const customizeHead = div('lobby-head', customizePanel);
  customizeHead.textContent = 'customize avatar';
  // A close button pinned to the panel's top-right corner — the mirror of the
  // toggle that raised it. It only ever takes the panel down.
  const customizeClose = button('panel-close', '✕', customizePanel);
  customizeClose.setAttribute('data-close', 'customize');
  customizeClose.setAttribute('aria-label', 'close customize panel');
  customizeClose.title = 'close';
  const nameRow = div('name-row', customizePanel);
  const nameLabel = div('field-label', nameRow);
  nameLabel.textContent = 'name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 20;
  nameInput.autocomplete = 'off';
  nameInput.spellcheck = false;
  nameInput.setAttribute('aria-label', 'racer name');
  nameRow.appendChild(nameInput);
  const trailLabel = div('field-label is-trail', customizePanel);
  trailLabel.textContent = 'trail / cosmetics';
  const trailCards = new Slot(div('lobby-cards', customizePanel));
  const colorLabel = div('field-label', customizePanel);
  colorLabel.textContent = 'body color';
  const colorCards = new Slot(div('lobby-cards', customizePanel));
  const hatLabel = div('field-label', customizePanel);
  hatLabel.textContent = 'hat';
  const hatCards = new Slot(div('lobby-cards', customizePanel));
  const gearLabel = div('field-label', customizePanel);
  gearLabel.textContent = 'gear';
  const gearCards = new Slot(div('lobby-cards', customizePanel));

  const votePanel = div('lobby-panel is-vote', container);
  votePanel.hidden = true;
  const voteHead = div('lobby-head', votePanel);
  voteHead.textContent = 'vote the next map';
  const voteCards = new Slot(div('lobby-cards', votePanel));
  const voteHint = new Slot(div('lobby-hint', votePanel));

  // Typing never reaches the game: keys staged for racing (Space jump, C
  // camera) would otherwise fire while the field is focused, and the field
  // would never see a space. Stopping propagation keeps the two inputs apart.
  nameInput.addEventListener('keydown', (event) => {
    event.stopPropagation();
    // Enter commits the name; an explicit cue beats relying on a blur nobody
    // asked for. Space is a perfectly good character in a name, so only Enter
    // binds.
    if ((event as KeyboardEvent).key === 'Enter') {
      event.preventDefault();
      commitName();
      nameInput.blur();
    }
  });
  nameInput.addEventListener('keyup', (event) => event.stopPropagation());
  nameInput.addEventListener('blur', () => commitName());

  function commitName(): void {
    const value = nameInput.value.trim();
    if (!value || value === lastSentName) return;
    lastSentName = value;
    options.onRename?.(value);
  }

  // Delegated on the container, not on the cards: the Slot rewrites the
  // cards' innerHTML whenever the tally moves, and per-card listeners would
  // die with each rewrite. Clicking a card in a locked-pointer game would
  // otherwise also leave focus behind — blur so Space keeps meaning jump.
  // Kept named so dispose() can remove it: the HUD's contract is that it
  // takes everything it made with it.
  const onLobbyClick = (event: Event): void => {
    const el = event.target instanceof Element ? event.target : null;

    // A panel close button beats the toggles: it always takes its panel down,
    // never flips it back open.
    const closeBtn = el?.closest<HTMLElement>('[data-close]');
    if (closeBtn) {
      closeBtn.blur();
      openPanel = null;
      return;
    }

    // A lobby toggle first: which panel the top-right buttons control. One
    // panel is open at a time; a tap on the open one's button closes it.
    const toggleBtn = el?.closest<HTMLElement>('[data-panel]');
    const panelId = toggleBtn?.dataset['panel'];
    if (panelId === 'customize' || panelId === 'vote') {
      toggleBtn?.blur();
      openPanel = openPanel === panelId ? null : panelId;
      return;
    }

    // Cosmetic cards first: they are also `<button class="map-card">`, so the
    // course check below must not swallow them. All four cosmetic kinds share
    // the shape, matched before the course lookup.
    const hatBtn = el?.closest<HTMLElement>('[data-hat]');
    const hatId = hatBtn?.dataset['hat'];
    if (hatId) {
      hatBtn?.blur();
      options.onEquipHat?.(hatId);
      return;
    }
    const gearBtn = el?.closest<HTMLElement>('[data-gear]');
    const gearId = gearBtn?.dataset['gear'];
    if (gearId) {
      gearBtn?.blur();
      options.onEquipGear?.(gearId);
      return;
    }
    const colorBtn = el?.closest<HTMLElement>('[data-color]');
    const colorId = colorBtn?.dataset['color'];
    if (colorId) {
      colorBtn?.blur();
      options.onEquipColor?.(colorId);
      return;
    }
    const trailBtn = el?.closest<HTMLElement>('[data-trail]');
    const trailId = trailBtn?.dataset['trail'];
    if (trailId) {
      trailBtn?.blur();
      options.onEquip?.(trailId);
      return;
    }
    const target = el?.closest<HTMLElement>('[data-course]');
    const courseId = target?.dataset['course'];
    if (!courseId) return;
    target.blur();
    options.onVote?.(courseId);
  };
  container.addEventListener('click', onLobbyClick);
  const connection = div('hud hud-connection', container);
  const board = new Slot(div('board', container));
  const readout = new Slot(div('hud hud-readout', container));
  const dash = new Slot(div('hud hud-dash', container));
  const announcer = div('announce', container);
  announcer.hidden = true;
  let announceTimer = 0;
  // Toasts pile in the bottom-left, each fading on its own timer.
  const toasts = div('toasts', container);
  const toastTimers: number[] = [];

  function pushToast(text: string): void {
    const pill = div('toast', toasts);
    pill.textContent = text;
    restartAnimation(pill, 'is-in');
    const timer = window.setTimeout(() => {
      pill.remove();
    }, TOAST_MS);
    toastTimers.push(timer);
  }
  const controls = div('hud hud-controls', container);
  controls.textContent = 'WASD / ARROWS move · SPACE jump · SHIFT dash · MOUSE look · M mute';

  // Cosmetic latch for the "TAKE IT" flash. Not game state: the server has
  // already moved to `playing`; this only decides how long the callout lingers.
  let lastPhase = '';
  let flashUntil = 0;
  let lastCourse = '';
  let lastConnection = '';
  // The mode of the running course, read off `course.mode` each update (a map
  // swap can change it) so the readouts below branch without re-parsing.
  let mode: GameMode = 'hold';
  let coreCount = 0;
  // Whole seconds of your hold time last frame, for the per-second pop.
  let lastHoldSecond = -1;
  /**
   * The match length captured the moment play started, so a racing mode can
   * show a RISING clock as `playDurationMs - phaseRemainingMs`. Taken from the
   * first `playing` sample rather than a constant, so a room created with
   * custom timings (the harness) still reads from zero.
   */
  let playDurationMs = 0;
  // Last name sent as a rename, so blur/Enter never re-send the same value;
  // re-seeded to the echoed server name each lobby render.
  let lastSentName = '';
  // Which lobby panel is open. 'vote' is the default — it is the lobby's
  // primary action — and a tap on the open panel's button closes it.
  let openPanel: 'customize' | 'vote' | null = 'vote';

  return {
    update(state, selfId, course, linkStatus, sim) {
      const phase = state.phase;
      const self = state.players.get(selfId);

      if (phase === 'playing' && lastPhase === 'countdown') {
        flashUntil = performance.now() + GO_FLASH_MS;
      }
      // A phase edge decides the lobby panels. When the match stops — or the
      // ballot goes live — the vote panel pops up so the next map is the first
      // thing seen. When play resumes, whatever panel was open closes so it
      // cannot sit over the race; the top-right toggle buttons stay up in every
      // phase, and reopening (customize, especially) works mid-match.
      if (phase !== lastPhase) {
        if (phase === 'ready' || phase === 'results') {
          openPanel = 'vote';
        } else {
          openPanel = null;
        }
        // Play has started: capture the length so a racing clock reads from
        // zero instead of assuming the default duration.
        if (phase === 'playing') playDurationMs = state.phaseRemainingMs;
      }
      lastPhase = phase;

      // The mode is a property of the course, not of replicated state, so it is
      // read here (and re-read after a swap) rather than looked up per readout.
      mode = modeOf(course.mode);
      coreCount = course.cores?.length ?? 0;

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
      const racing = mode !== 'hold';

      // --- match clock ---------------------------------------------------
      // Playing shows the real match clock; ready shows the lobby window
      // counting down to the countdown; countdown and results fill the slot
      // so it never looks broken between matches. A racing mode counts UP
      // instead: the score is a time, so the clock is the score climbing.
      if (racing && playing) {
        const elapsed = Math.max(0, playDurationMs - state.phaseRemainingMs);
        timer.html(`<span class="is-race">${formatHold(elapsed, true)}</span>`);
      } else {
        const clockMs = playing
          ? state.phaseRemainingMs
          : phase === 'ready'
            ? state.phaseRemainingMs
            : phase === 'results'
              ? 0
              : MATCH.durationMs;
        timer.html(
          `<span class="${playing && clockMs <= 10_000 ? 'is-low' : ''}">${formatClock(clockMs)}</span>`,
        );
      }

      // --- status line + own score --------------------------------------
      // The status line is the mode's objective; the second slot is your own
      // score in it — hold time, a finish time, or your core count.
      const carrierId = state.carrierId;
      const selfFinish = self?.finishMs ?? -1;
      status.hidden(!playing);
      hold.hidden(!playing);
      if (playing) {
        if (mode === 'reach') {
          if (selfFinish >= 0) {
            status.html(`<span class="is-you">YOU FINISHED — ${formatHold(selfFinish, true)}</span>`);
          } else {
            const finishers = countFinishers(state);
            status.html(
              `<span class="is-free">${finishers > 0 ? `${finishers} FINISHED · ` : ''}REACH THE CORE</span>`,
            );
          }
        } else if (mode === 'hunt') {
          if (selfFinish >= 0) {
            status.html(`<span class="is-you">ALL CORES — ${formatHold(selfFinish, true)}</span>`);
          } else {
            status.html(`<span class="is-free">CORES ${popcount(self?.coreMask ?? 0)}/${coreCount}</span>`);
          }
        } else {
          const carrier = carrierId === '' ? undefined : state.players.get(carrierId);
          if (carrierId === selfId) {
            status.html(`<span class="is-you">YOU HAVE THE CORE — RUN</span>`);
          } else if (carrier) {
            status.html(`<span class="is-them">${escapeHtml(carrier.name)} HAS THE CORE</span>`);
          } else {
            status.html(`<span class="is-free">THE CORE IS FREE</span>`);
          }
        }

        if (racing) {
          // The objective slot becomes the account's personal best on this
          // course, or your own finish the moment you cross. The PB is
          // off-chain, so it is asked for rather than read off the wire.
          if (selfFinish >= 0) {
            hold.html(
              `<span class="hold-label">YOUR TIME</span><span class="hold-time">${formatHold(selfFinish, true)}</span>`,
            );
          } else {
            const best = options.personalBest?.(course.id);
            hold.html(
              `<span class="hold-label">YOUR BEST</span><span class="hold-time">${best === undefined ? '--:--' : formatHold(best, true)}</span>`,
            );
          }
        } else {
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
      }

      // --- dash meter ------------------------------------------------------
      dash.hidden(!(playing || phase === 'countdown'));
      dash.html(dashMarkup(sim));

      readout.html(
        `${self?.grounded ? 'grounded' : 'airborne'}  speed ${(self?.speed ?? 0).toFixed(1)}`,
      );

      renderBanner(banner, state, selfId, performance.now() < flashUntil, mode);

      // --- the lobby --------------------------------------------------------
      // Two separate panels — customize avatar (name, trail) and the map
      // ballot — each toggled by a top-right button, one open at a time (or
      // none). The buttons stay pinned top-right in EVERY phase: equipping
      // cosmetics or renaming works mid-match (the server accepts both in any
      // phase), so the customize panel is available whenever play slows down.
      // The vote panel opens anywhere too — in a lobby window it is the
      // ballot, and while a match runs picking a card IS the change-map vote
      // (the server honours it: a majority ends the run and the picks settle
      // the next map). Panels auto-close when play starts (see the phase-edge
      // check above) so nothing sits over the race; the buttons themselves
      // never hide.
      customizePanel.hidden = openPanel !== 'customize';
      votePanel.hidden = openPanel !== 'vote';
      customizeToggle.classList.toggle('is-on', openPanel === 'customize');
      voteToggle.classList.toggle('is-on', openPanel === 'vote');
      if (openPanel) {
        trailCards.html(trailCardsMarkup(state, selfId, options.ownedTrails?.() ?? []));
        colorCards.html(bodyColorCardsMarkup(state, selfId, options.ownedBodyColors?.() ?? []));
        hatCards.html(hatCardsMarkup(state, selfId, options.ownedHats?.() ?? []));
        gearCards.html(gearCardsMarkup(state, selfId, options.ownedGears?.() ?? []));
        voteCards.html(voteCardsMarkup(state, course, selfId));
        voteHint.html(voteHintMarkup(state));

        // The echoed server name is truth. It only writes back into the field
        // while the player is NOT typing — overwriting a focused field every
        // time a patch arrives would fight the caret.
        const echoedName = self?.name ?? '';
        if (document.activeElement !== nameInput && nameInput.value !== echoedName) {
          nameInput.value = echoedName;
        }
        lastSentName = echoedName;
      } else if (document.activeElement === nameInput) {
        // A closed panel must not keep the game's keys hostage.
        nameInput.blur(); // commits any in-progress rename, like any blur
      }

      board.hidden(!playing);
      if (playing) board.html(boardMarkup(state, selfId, mode, coreCount));
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

    toast(text) {
      pushToast(text);
    },

    dispose() {
      clearTimeout(announceTimer);
      for (const timer of toastTimers) clearTimeout(timer);
      container.removeEventListener('click', onLobbyClick);
      announcer.remove();
      toasts.remove();
      for (const el of [
        courseLabel,
        timer.el,
        status.el,
        hold.el,
        banner.el,
        lobby,
        customizePanel,
        votePanel,
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

function button(className: string, text: string, parent: HTMLElement): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.textContent = text;
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
 * nothing, out of the way. results: who won and the full standings — by banked
 * hold time in `hold`, by fastest finish (DNF for the rest) in the racing modes.
 */
function renderBanner(
  banner: Slot,
  state: GameStateInstance,
  selfId: string,
  flashing: boolean,
  mode: GameMode,
): void {
  const racing = mode !== 'hold';
  switch (state.phase) {
    case 'ready':
      banner.hidden(false);
      banner.html(
        `<div class="banner-title">VOTE FOR THE NEXT MAP</div>` +
          `<div class="banner-hint">${TAGLINE} · countdown runs once everyone has voted — else in ${formatClock(state.phaseRemainingMs)}</div>`,
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
        banner.html(`<div class="banner-go">${racing ? 'GO' : 'TAKE IT'}</div>`);
      } else {
        banner.hidden(true);
      }
      return;

    case 'results': {
      const winner = state.winnerId === '' ? undefined : state.players.get(state.winnerId);
      const title = racing
        ? winner
          ? `${escapeHtml(winner.name)} WINS`
          : 'NO FINISHERS'
        : winner
          ? `${escapeHtml(winner.name)} HODLED IT`
          : 'NO WINNER';
      const next = Math.max(0, Math.ceil(state.phaseRemainingMs / 1000));
      const list = sortedPlayers(state, mode, true)
        .map(({ player, id }, i) => {
          const cls = `result-row${id === selfId ? ' is-self' : ''}${id === state.winnerId ? ' is-winner' : ''}`;
          const place = player.rank > 0 ? player.rank : i + 1;
          const score = racing
            ? player.finishMs >= 0
              ? formatHold(player.finishMs, true)
              : 'DNF'
            : formatHold(player.holdMs, true);
          return (
            `<div class="${cls}"><span class="result-rank">${place}</span>` +
            `<span class="result-name">${escapeHtml(player.name)}</span>` +
            `<span class="result-time">${score}</span></div>`
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
 *
 * While a match runs (`countdown`/`playing`) the same cards are the
 * change-map vote: a pick is a wish for that map AND a vote to end the run,
 * and each card shows the room tally `n/m` as well as the names, so the
 * majority's progress is visible at a glance. Same-card re-pick withdraws.
 */
function voteCardsMarkup(state: GameStateInstance, course: HudCourse, selfId: string): string {
  const racing = state.phase === 'countdown' || state.phase === 'playing';
  return state.catalog
    .map((info) => {
      const voters: string[] = [];
      state.players.forEach((player, id) => {
        if (player.votedFor === info.id) voters.push(id === selfId ? 'you' : player.name);
      });
      const current = info.id === course.id;
      const mine = state.players.get(selfId)?.votedFor === info.id;
      const cls = `map-card${current ? ' is-current' : ''}${mine ? ' is-voted' : ''}`;
      const names = voters.join(' · ');
      const line = racing
        ? `${voters.length}/${state.players.size} picked` +
          (voters.length > 0 ? ` · ${names}` : '')
        : names;
      const votes = line ? `<span class="map-votes">${escapeHtml(line)}</span>` : '';
      const now = current ? `<span class="map-now">now running</span>` : '';
      return (
        `<button type="button" class="${cls}" data-course="${escapeHtml(info.id)}">` +
        `<span class="map-name">${escapeHtml(info.name)}</span>` +
        `<span class="map-stats">${MODE_NAMES[modeOf(info.mode)]} · ${info.solids} solids · ${info.pads} pads</span>` +
        votes +
        now +
        `</button>`
      );
    })
    .join('');
}

/** The one line under the ballot explaining when votes settle. */
function voteHintMarkup(state: GameStateInstance): string {
  if (state.phase === 'results') return 'votes settle when the lobby resets';
  if (state.phase === 'ready')
    return 'votes settle the moment every player has voted — or when the window runs out';
  // Mid-match the cards are the change-map vote; re-picking your card withdraws.
  return 'pick a map to play next — a majority pick calls the match off and plays it';
}

/**
 * The trail picker: one card per acquired trail from the LOCAL account's
 * wardrobe, marked against the EQUIPPED id the server replicated. Reuses the
 * map-card styling so it needs no new CSS; the swatch is an inline dot, so a
 * cosmetic's colour shows without a palette table living in this file.
 *
 * Returns '' (and draws nothing) when the account owns nothing.
 */
function trailCardsMarkup(
  state: GameStateInstance,
  selfId: string,
  owned: readonly string[],
): string {
  const equipped = state.players.get(selfId)?.equippedTrailId ?? '';
  return owned
    .map((id) => {
      const def = TRAILS[id];
      if (!def) return '';
      const on = id === equipped;
      const swatch =
        def.color === null
          ? 'var(--ink-dim)'
          : `#${def.color.toString(16).padStart(6, '0')}`;
      return (
        `<button type="button" class="map-card${on ? ' is-voted' : ''}" data-trail="${escapeHtml(id)}">` +
        `<span class="map-name">` +
        `<span style="display:inline-block;width:9px;height:9px;margin-right:8px;border-radius:50%;vertical-align:middle;background:${swatch};box-shadow:0 0 8px ${swatch}"></span>` +
        `${escapeHtml(def.name)}</span>` +
        `<span class="map-stats">${on ? 'equipped' : 'acquired'}</span>` +
        `</button>`
      );
    })
    .join('');
}

/**
 * The body-colour picker: one card per acquired colour from the LOCAL
 * account's wardrobe, marked against the EQUIPPED id the server replicated.
 * Same shape and swatch language as the trail picker; the swatch IS the body
 * tint, so a pick previews the look. Stock draws as the dim ink because it
 * inherits the seat colour, which lives in the render palette, not here.
 *
 * Returns '' (and draws nothing) when the account owns nothing.
 */
function bodyColorCardsMarkup(
  state: GameStateInstance,
  selfId: string,
  owned: readonly string[],
): string {
  const equipped = state.players.get(selfId)?.equippedBodyColorId ?? '';
  return owned
    .map((id) => {
      const def = BODY_COLORS[id];
      if (!def) return '';
      const on = id === equipped;
      const swatch =
        def.color === null
          ? 'var(--ink-dim)'
          : `#${def.color.toString(16).padStart(6, '0')}`;
      return (
        `<button type="button" class="map-card${on ? ' is-voted' : ''}" data-color="${escapeHtml(id)}">` +
        `<span class="map-name">` +
        `<span style="display:inline-block;width:9px;height:9px;margin-right:8px;border-radius:50%;vertical-align:middle;background:${swatch};box-shadow:0 0 8px ${swatch}"></span>` +
        `${escapeHtml(def.name)}</span>` +
        `<span class="map-stats">${on ? 'equipped' : 'acquired'}</span>` +
        `</button>`
      );
    })
    .join('');
}

/**
 * The hat picker: one card per acquired hat from the LOCAL account's
 * wardrobe, marked against the EQUIPPED id the server replicated. Same shape
 * as the other pickers; the swatch is the hat's main static colour (dim ink
 * for Stock, which draws nothing on the head).
 *
 * Returns '' (and draws nothing) when the account owns nothing.
 */
function hatCardsMarkup(
  state: GameStateInstance,
  selfId: string,
  owned: readonly string[],
): string {
  const equipped = state.players.get(selfId)?.equippedHatId ?? '';
  return owned
    .map((id) => {
      const def = HATS[id];
      if (!def) return '';
      const on = id === equipped;
      const swatch =
        def.color === null
          ? 'var(--ink-dim)'
          : `#${def.color.toString(16).padStart(6, '0')}`;
      return (
        `<button type="button" class="map-card${on ? ' is-voted' : ''}" data-hat="${escapeHtml(id)}">` +
        `<span class="map-name">` +
        `<span style="display:inline-block;width:9px;height:9px;margin-right:8px;border-radius:50%;vertical-align:middle;background:${swatch};box-shadow:0 0 8px ${swatch}"></span>` +
        `${escapeHtml(def.name)}</span>` +
        `<span class="map-stats">${on ? 'equipped' : 'acquired'}</span>` +
        `</button>`
      );
    })
    .join('');
}

/**
 * The gear picker: one card per acquired gear piece from the LOCAL account's
 * wardrobe, marked against the EQUIPPED id the server replicated. Same shape
 * as the other pickers; the swatch is the gear's main static colour (dim ink
 * for Stock, which draws nothing on the body).
 *
 * Returns '' (and draws nothing) when the account owns nothing.
 */
function gearCardsMarkup(
  state: GameStateInstance,
  selfId: string,
  owned: readonly string[],
): string {
  const equipped = state.players.get(selfId)?.equippedGearId ?? '';
  return owned
    .map((id) => {
      const def = GEARS[id];
      if (!def) return '';
      const on = id === equipped;
      const swatch =
        def.color === null
          ? 'var(--ink-dim)'
          : `#${def.color.toString(16).padStart(6, '0')}`;
      return (
        `<button type="button" class="map-card${on ? ' is-voted' : ''}" data-gear="${escapeHtml(id)}">` +
        `<span class="map-name">` +
        `<span style="display:inline-block;width:9px;height:9px;margin-right:8px;border-radius:50%;vertical-align:middle;background:${swatch};box-shadow:0 0 8px ${swatch}"></span>` +
        `${escapeHtml(def.name)}</span>` +
        `<span class="map-stats">${on ? 'equipped' : 'acquired'}</span>` +
        `</button>`
      );
    })
    .join('');
}
function boardMarkup(state: GameStateInstance, selfId: string, mode: GameMode, coreCount: number): string {
  return sortedPlayers(state, mode, false)
    .map(({ player, id }) => {
      const carrierCls = mode === 'hold' && id === state.carrierId ? ' is-carrier' : '';
      const cls = `board-row${id === selfId ? ' is-self' : ''}${carrierCls}`;
      // Hold banks whole seconds; a racing mode shows the finish time once
      // there is one, and otherwise hunt's found count or a dash for reach.
      const time =
        mode === 'hold'
          ? formatHold(player.holdMs, false)
          : player.finishMs >= 0
            ? formatHold(player.finishMs, true)
            : mode === 'hunt'
              ? `${popcount(player.coreMask)}/${coreCount}`
              : '·';
      return (
        `<div class="${cls}"><span class="board-name">${escapeHtml(player.name)}</span>` +
        `<span class="board-time">${time}</span></div>`
      );
    })
    .join('');
}

interface Row {
  player: PlayerStateInstance;
  id: string;
}

/**
 * Players ordered by score, mode-aware.
 *
 * `hold` ranks by banked hold time with the `lastHeldAtMs` tiebreak; the racing
 * modes rank by finish — finishers first, fastest first, then hunt's found
 * count, then sessionId so the order is total. Results prefer the server's
 * final `rank` (which already applied the same ordering) so the board and the
 * banner agree exactly once the match is over.
 */
function sortedPlayers(state: GameStateInstance, mode: GameMode, final: boolean): Row[] {
  const rows: Row[] = [];
  state.players.forEach((player, id) => rows.push({ player, id }));
  rows.sort((a, b) => {
    if (final && a.player.rank > 0 && b.player.rank > 0) return a.player.rank - b.player.rank;
    if (mode === 'hold') {
      if (b.player.holdMs !== a.player.holdMs) return b.player.holdMs - a.player.holdMs;
      return b.player.lastHeldAtMs - a.player.lastHeldAtMs;
    }
    const aFin = a.player.finishMs >= 0;
    const bFin = b.player.finishMs >= 0;
    if (aFin !== bFin) return aFin ? -1 : 1;
    if (aFin && bFin && a.player.finishMs !== b.player.finishMs) {
      return a.player.finishMs - b.player.finishMs;
    }
    if (mode === 'hunt') {
      const foundDiff = popcount(b.player.coreMask) - popcount(a.player.coreMask);
      if (foundDiff !== 0) return foundDiff;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return rows;
}

/** Narrow a replicated/stored mode string to a `GameMode`, defaulting to hold. */
function modeOf(value: string | undefined): GameMode {
  return value === 'reach' || value === 'hunt' ? value : 'hold';
}

/** How many racers have finished a racing match. */
function countFinishers(state: GameStateInstance): number {
  let count = 0;
  for (const player of state.players.values()) {
    if (player.finishMs >= 0) count += 1;
  }
  return count;
}

/** Number of set bits — the count behind a hunt racer's `coreMask`. */
function popcount(mask: number): number {
  let bits = mask | 0;
  let count = 0;
  while (bits !== 0) {
    bits &= bits - 1;
    count += 1;
  }
  return count;
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
