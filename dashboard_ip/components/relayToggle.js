/**
 * relayToggle.js — Smart Grid Sentinel Relay Toggle Component
 * Phase 3 deliverable. DESIGN.md §5.11, §17.
 *
 * Toggle switch that controls relay state via POST /api/relay.
 * Implements optimistic UI update with revert on API error.
 * Reads relay state from telemetryData.relay on each update().
 *
 * Component interface (DESIGN.md §17):
 *   constructor(containerEl, options)
 *   update(telemetryData)
 *   destroy()
 *
 * Options:
 *   onToggle  {function(newState: boolean): void}  — callback after API call
 *   label     {string}  — display label (default 'Relay')
 *   apiPath   {string}  — API endpoint path (default '/api/relay')
 */

export class RelayToggle {
  /**
   * @param {HTMLElement} containerEl
   * @param {object}      options
   */
  constructor(containerEl, options = {}) {
    this._container = containerEl;
    this._onToggle  = options.onToggle ?? null;
    this._label     = options.label    ?? 'Relay';
    this._apiPath   = options.apiPath  ?? '/api/relay';

    // UI state tracks what the toggle is currently showing (may differ from
    // telemetry during an in-flight API call — optimistic update)
    this._uiState      = false;
    // True state as last confirmed by telemetry (used for revert)
    this._confirmedState = false;
    // Whether an API call is currently in flight
    this._pending      = false;

    this._buildDOM();
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  _buildDOM() {
    // Outer row
    this._row = document.createElement('div');
    this._row.style.cssText = [
      'display: flex',
      'align-items: center',
      'gap: 12px',
      'padding: 8px 0',
    ].join(';');

    // Label
    const labelEl = document.createElement('span');
    labelEl.style.cssText = [
      'font-size: var(--text-label)',
      'color: var(--text-muted)',
      'flex: 1',
    ].join(';');
    labelEl.textContent = this._label;

    // Status text (CLOSED / OPEN / PENDING)
    this._statusEl = document.createElement('span');
    this._statusEl.style.cssText = [
      'font-size: var(--text-micro)',
      'color: var(--text-faint)',
      'min-width: 52px',
      'text-align: right',
    ].join(';');
    this._statusEl.textContent = '–';

    // Toggle wrapper — DESIGN.md §5.11: 40×22px minimum
    this._track = document.createElement('button');
    this._track.setAttribute('role', 'switch');
    this._track.setAttribute('aria-checked', 'false');
    this._track.setAttribute('aria-label', `${this._label} relay toggle`);
    this._track.style.cssText = [
      'position: relative',
      'display: inline-block',
      'width: 40px',
      'height: 22px',
      'border-radius: var(--radius-pill)',
      'border: none',
      'cursor: pointer',
      'padding: 0',
      'transition: background-color 200ms ease',
      'background-color: var(--toggle-track-off)',
      'outline-offset: 3px',
      'flex-shrink: 0',
    ].join(';');

    // Thumb
    this._thumb = document.createElement('span');
    this._thumb.style.cssText = [
      'position: absolute',
      'top: 2px',
      'left: 2px',
      'width: 18px',
      'height: 18px',
      'border-radius: 50%',
      'background-color: var(--toggle-thumb)',
      'box-shadow: 0 1px 3px rgba(0,0,0,0.4)',
      'transition: transform 200ms ease',
      'pointer-events: none',
    ].join(';');

    this._track.appendChild(this._thumb);

    // Click handler
    this._onClick = this._onClick.bind(this);
    this._track.addEventListener('click', this._onClick);

    this._row.appendChild(labelEl);
    this._row.appendChild(this._statusEl);
    this._row.appendChild(this._track);
    this._container.appendChild(this._row);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * @param {object} telemetryData
   */
  update(telemetryData) {
    const relayState = telemetryData?.relay ?? false;

    // Always track the confirmed state from telemetry
    this._confirmedState = relayState;

    // Only override the UI if we're not mid-optimistic-update
    if (!this._pending) {
      this._setUI(relayState);
    }
  }

  /**
   * No animationLoop subscription.
   */
  destroy() {
    this._track.removeEventListener('click', this._onClick);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  _setUI(state) {
    this._uiState = state;

    // Track color
    this._track.style.backgroundColor = state
      ? 'var(--toggle-track-on)'
      : 'var(--toggle-track-off)';

    // Thumb position (ON = slid right, 20px = 40 - 18 - 2)
    this._thumb.style.transform = state ? 'translateX(18px)' : 'translateX(0)';

    // aria-checked
    this._track.setAttribute('aria-checked', state ? 'true' : 'false');

    // Status label
    this._statusEl.textContent = state ? 'CLOSED' : 'OPEN';
    this._statusEl.style.color = state
      ? 'var(--health-excellent)'
      : 'var(--state-fault)';
  }

  async _onClick() {
    if (this._pending) return; // ignore clicks during in-flight request

    const newState = !this._uiState;

    // Optimistic update — show the new state immediately
    this._pending = true;
    this._setUI(newState);
    this._statusEl.textContent = '…';
    this._statusEl.style.color = 'var(--text-faint)';
    this._track.disabled       = true;

    try {
      const response = await fetch(this._apiPath, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ state: newState }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      // API confirmed — keep the new state
      this._confirmedState = newState;
      if (this._onToggle) {
        this._onToggle(newState);
      }
    } catch (err) {
      // Revert to the last confirmed state from telemetry
      console.warn('[relayToggle] API error — reverting:', err.message);
      this._setUI(this._confirmedState);
    } finally {
      this._pending        = false;
      this._track.disabled = false;
    }
  }
}
