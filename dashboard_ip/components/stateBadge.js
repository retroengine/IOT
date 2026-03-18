/**
 * stateBadge.js — Smart Grid Sentinel FSM State Badge Component
 * Phase 3 deliverable. DESIGN.md §5.2, §5.15, §17, §19.
 *
 * Persistent FSM state badge. Reads telemetryData.state and applies the
 * correct color token, animation class, and glow effect.
 *
 * Handles all 6 FSM states: BOOT, NORMAL, WARNING, FAULT, RECOVERY, LOCKOUT.
 *
 * State → visual mapping (DESIGN.md §5.2):
 *   BOOT:     --state-boot,     static, no animation
 *   NORMAL:   --state-normal,   static
 *   WARNING:  --state-warning,  .pulse-warning (1.5s)
 *   FAULT:    --state-fault,    .pulse-fault (0.8s)
 *   RECOVERY: --state-recovery, rotating arc ring via .rotate-recovery
 *   LOCKOUT:  --state-lockout,  static — no animation (locked)
 *
 * On state change: fires statusBarFlash on a designated status bar element
 * if one is provided in options.statusBarEl.
 *
 * Component interface (DESIGN.md §17):
 *   constructor(containerEl, options)
 *   update(telemetryData)
 *   destroy()
 */

// ── State configuration table ──────────────────────────────────────────────
// Maps FSM state string → CSS variable, animation class, and whether
// to show a ring (RECOVERY uses a rotating ring overlay).
const STATE_CONFIG = {
  BOOT:     { colorVar: '--state-boot',     textVar: '--text-primary',   animation: '',                ring: false },
  NORMAL:   { colorVar: '--state-normal',   textVar: '--text-primary',   animation: '',                ring: false },
  WARNING:  { colorVar: '--state-warning',  textVar: '--text-on-light',  animation: 'pulse-warning',   ring: false },
  FAULT:    { colorVar: '--state-fault',    textVar: '--text-primary',   animation: 'pulse-fault',     ring: false },
  RECOVERY: { colorVar: '--state-recovery', textVar: '--text-primary',   animation: '',                ring: true  },
  LOCKOUT:  { colorVar: '--state-lockout',  textVar: '--text-primary',   animation: '',                ring: false },
};

// Flash color variable per state — applied as CSS custom property before flash class
const FLASH_COLOR_VAR = {
  NORMAL:   'color-mix(in srgb, var(--state-normal)   40%, transparent)',
  WARNING:  'color-mix(in srgb, var(--state-warning)  40%, transparent)',
  FAULT:    'color-mix(in srgb, var(--state-fault)    45%, transparent)',
  LOCKOUT:  'color-mix(in srgb, var(--state-lockout)  55%, transparent)',
  RECOVERY: 'color-mix(in srgb, var(--state-recovery) 30%, transparent)',
  BOOT:     'color-mix(in srgb, var(--state-boot)     30%, transparent)',
};

// All possible animation classes (to clean up before applying new one)
const ALL_ANIMATIONS = ['pulse-warning', 'pulse-fault'];

export class StateBadge {
  /**
   * @param {HTMLElement} containerEl
   * @param {object}      options
   * @param {HTMLElement} [options.statusBarEl]  — element to flash on state change
   */
  constructor(containerEl, options = {}) {
    this._container    = containerEl;
    this._statusBarEl  = options.statusBarEl ?? null;
    this._lastState    = null;

    this._buildDOM();
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  _buildDOM() {
    // Outer pill wrapper — sets data-state for glow rules in effects.css
    this._badge = document.createElement('div');
    this._badge.style.cssText = [
      'display: inline-flex',
      'align-items: center',
      'gap: 6px',
      'padding: 5px 12px',
      'border-radius: var(--radius-pill)',
      'font-size: var(--text-label)',
      'font-weight: 500',
      'letter-spacing: 0.04em',
      'text-transform: uppercase',
      'position: relative',
      'overflow: hidden',
      'user-select: none',
      'transition: background-color 600ms ease-in-out, color 300ms ease-in-out',
    ].join(';');

    // Status dot inside badge
    this._dot = document.createElement('span');
    this._dot.style.cssText = [
      'display: inline-block',
      'width: 6px',
      'height: 6px',
      'border-radius: 50%',
      'background-color: currentColor',
      'opacity: 0.85',
      'flex-shrink: 0',
    ].join(';');

    // State label text
    this._text = document.createElement('span');
    this._text.textContent = '–';

    // RECOVERY ring overlay (rotate-recovery class from effects.css)
    this._ring = document.createElement('span');
    this._ring.style.cssText = [
      'position: absolute',
      'inset: 0',
      'border-radius: var(--radius-pill)',
      'border: 2px solid currentColor',
      'opacity: 0',
      'pointer-events: none',
      'transition: opacity 300ms ease',
    ].join(';');

    this._badge.appendChild(this._dot);
    this._badge.appendChild(this._text);
    this._badge.appendChild(this._ring);
    this._container.appendChild(this._badge);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * @param {object} telemetryData
   */
  update(telemetryData) {
    const state = telemetryData?.state ?? 'BOOT';
    const config = STATE_CONFIG[state] ?? STATE_CONFIG.BOOT;

    // Update data-state attribute so effects.css glow rules apply
    this._badge.dataset.state = state;

    // Background and text color
    this._badge.style.backgroundColor = `var(${config.colorVar})`;
    this._badge.style.color            = `var(${config.textVar})`;

    // Badge text
    this._text.textContent = state;

    // Animation classes — remove all, then apply correct one
    for (const cls of ALL_ANIMATIONS) {
      this._badge.classList.remove(cls);
    }
    if (config.animation) {
      this._badge.classList.add(config.animation);
    }

    // RECOVERY ring
    if (config.ring) {
      this._ring.style.opacity = '0.6';
      this._ring.classList.add('rotate-recovery');
    } else {
      this._ring.style.opacity = '0';
      this._ring.classList.remove('rotate-recovery');
    }

    // Fire status bar flash on state change
    if (state !== this._lastState && this._lastState !== null) {
      this._fireStatusBarFlash(state);
    }

    this._lastState = state;
  }

  /**
   * No animationLoop subscription — CSS handles all animation.
   */
  destroy() {
    // Nothing to unsubscribe.
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  _fireStatusBarFlash(state) {
    const target = this._statusBarEl;
    if (!target) return;

    // Set the flash color CSS variable on the target element
    const flashColor = FLASH_COLOR_VAR[state] ?? FLASH_COLOR_VAR.NORMAL;
    target.style.setProperty('--flash-color', flashColor);

    // Remove then re-add the class to restart the animation if already running
    target.classList.remove('status-bar-flash');
    // Force reflow to restart the animation
    void target.offsetWidth;
    target.classList.add('status-bar-flash');

    // Clean up class after animation completes (800ms)
    setTimeout(() => {
      target.classList.remove('status-bar-flash');
    }, 850);
  }
}
