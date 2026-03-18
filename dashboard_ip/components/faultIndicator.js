/**
 * faultIndicator.js — Smart Grid Sentinel Fault Indicator Component
 * Phase 3 deliverable. DESIGN.md §2.3, §2.4, §17, §19.
 *
 * Single dot + label indicator for one fault or warning flag.
 * Active: --fault-active (red) with .pulse-fault animation.
 * Inactive: --fault-inactive (dark grey), no animation.
 *
 * For warning flags, pass warningMode: true — uses --warn-active (amber)
 * with .pulse-warning animation.
 *
 * Component interface (DESIGN.md §17):
 *   constructor(containerEl, options)
 *   update(telemetryData)
 *   destroy()
 *
 * Options:
 *   faultKey     {string}   — dot-path key into telemetryData
 *                             e.g. 'faults.over_voltage', 'faults.warnings.oc'
 *   label        {string}   — display label (e.g. 'Over Voltage')
 *   warningMode  {boolean}  — use amber warning colors (default false = fault red)
 */

export class FaultIndicator {
  /**
   * @param {HTMLElement} containerEl
   * @param {object}      options
   */
  constructor(containerEl, options = {}) {
    this._container  = containerEl;
    this._faultKey   = options.faultKey   ?? 'faults.over_voltage';
    this._label      = options.label      ?? 'Fault';
    this._isWarning  = options.warningMode ?? false;

    this._buildDOM();
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  _buildDOM() {
    this._cell = document.createElement('div');
    this._cell.style.cssText = [
      'display: flex',
      'align-items: center',
      'gap: 8px',
      'padding: 8px 12px',
      'border-radius: var(--radius-sm)',
      'background-color: var(--fault-inactive)',
      'transition: background-color 300ms ease',
    ].join(';');

    // Dot indicator
    this._dot = document.createElement('span');
    this._dot.setAttribute('aria-hidden', 'true');
    this._dot.style.cssText = [
      'display: inline-block',
      'width: 8px',
      'height: 8px',
      'border-radius: 50%',
      'flex-shrink: 0',
      'transition: background-color 300ms ease',
      'background-color: var(--fault-inactive)',
    ].join(';');

    // Label text — always present (accessibility: color is not the only indicator)
    this._labelEl = document.createElement('span');
    this._labelEl.style.cssText = [
      'font-size: var(--text-label)',
      'color: var(--text-muted)',
      'transition: color 300ms ease',
      'letter-spacing: 0.01em',
    ].join(';');
    this._labelEl.textContent = this._label;

    this._cell.appendChild(this._dot);
    this._cell.appendChild(this._labelEl);
    this._container.appendChild(this._cell);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * @param {object} telemetryData
   */
  update(telemetryData) {
    const isActive = Boolean(_getField(telemetryData, this._faultKey));
    this._applyState(isActive);
  }

  /**
   * No animationLoop subscription.
   */
  destroy() {
    // Nothing to clean up — CSS handles all animations.
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  _applyState(active) {
    if (active) {
      // Active fault/warning state
      const activeBg    = this._isWarning ? 'rgba(239,159,39,0.12)' : 'rgba(226,75,74,0.12)';
      const dotColor    = this._isWarning ? 'var(--warn-active)'   : 'var(--fault-active)';
      const textColor   = 'var(--text-primary)';
      const pulseClass  = this._isWarning ? 'pulse-warning'        : 'pulse-fault';
      const removeClass = this._isWarning ? 'pulse-fault'          : 'pulse-warning';

      this._cell.style.backgroundColor = activeBg;
      this._dot.style.backgroundColor  = dotColor;
      this._labelEl.style.color        = textColor;

      this._dot.classList.remove(removeClass);
      this._dot.classList.add(pulseClass);
    } else {
      // Inactive state
      this._cell.style.backgroundColor = 'transparent';
      this._dot.style.backgroundColor  = 'var(--fault-inactive)';
      this._labelEl.style.color        = 'var(--text-muted)';

      this._dot.classList.remove('pulse-fault', 'pulse-warning');
    }
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function _getField(obj, path) {
  if (!path) return null;
  if (!path.includes('.')) return obj?.[path] ?? null;
  return path.split('.').reduce((acc, k) => acc?.[k], obj) ?? null;
}
