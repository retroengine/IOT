/**
 * alarmLog.js — Smart Grid Sentinel Alarm Event Log Component
 * Phase 6 deliverable. DESIGN.md §9 Infographic 2.8.
 *
 * In-memory event log. Detects FSM state transitions from live telemetry
 * and records alarm events in a circular buffer (max 200 entries).
 * Newest entry always at the top.
 *
 * Entry schema:
 *   { id, ts, severity, faultName, state, ackedAt, ackedBy }
 *
 * Severity:
 *   'FAULT'   — state FAULT or LOCKOUT
 *   'WARNING' — state WARNING
 *   'INFO'    — state NORMAL, RECOVERY, BOOT
 *
 * Sound:
 *   Web Audio beep (440 Hz, 200 ms) on FAULT/LOCKOUT transition.
 *   AudioContext is created lazily after the first user gesture.
 *   Mutable via setSoundEnabled(bool).
 *
 * Notifications:
 *   Requests Notification permission on mount.
 *   Fires a browser notification on FAULT entry (if permission granted).
 *
 * Ack API:
 *   POST /api/alarm/ack { id }
 *   Falls back to local-only ack on network error.
 *
 * Component interface (DESIGN.md §17):
 *   constructor(containerEl, options)
 *   update(telemetryData)
 *   setSoundEnabled(bool)
 *   acknowledgeAll()
 *   clearLog()
 *   destroy()
 *
 * Options:
 *   maxEntries  {number}  — max in-memory entries (default 200)
 *   onNewEvent  {function(entry)} — callback for each new event
 */

// ── Severity mapping ──────────────────────────────────────────────────────
const STATE_SEVERITY = {
  FAULT:    'FAULT',
  LOCKOUT:  'FAULT',
  WARNING:  'WARNING',
  RECOVERY: 'INFO',
  NORMAL:   'INFO',
  BOOT:     'INFO',
};

const SEVERITY_COLOR = {
  FAULT:   'var(--fault-active)',
  WARNING: 'var(--warn-active)',
  INFO:    'var(--state-normal)',
};

const SEVERITY_BG = {
  FAULT:   'rgba(226,75,74,0.15)',
  WARNING: 'rgba(239,159,39,0.12)',
  INFO:    'transparent',
};

// ── Unique ID generator ───────────────────────────────────────────────────
let _uid = 0;
function _nextId() {
  return `alarm-${Date.now()}-${++_uid}`;
}

export class AlarmLog {
  /**
   * @param {HTMLElement} containerEl
   * @param {object}      options
   */
  constructor(containerEl, options = {}) {
    this._container  = containerEl;
    this._maxEntries = options.maxEntries ?? 200;
    this._onNewEvent = options.onNewEvent ?? null;

    // In-memory log: most-recent first
    this._entries = [];

    // State tracking for transition detection
    this._prevState       = null;
    this._prevFaultActive = null;
    this._stateEnteredAt  = Date.now();

    // Sound
    this._audioCtx     = null;   // created lazily
    this._soundEnabled = true;
    this._firstGesture = false;

    // Build DOM
    this._buildDOM();

    // Request notification permission (non-blocking)
    this._requestNotificationPermission();

    // Ensure AudioContext can be created after a user gesture
    this._gestureListener = () => {
      if (!this._firstGesture) {
        this._firstGesture = true;
        this._ensureAudioCtx();
      }
    };
    document.addEventListener('click', this._gestureListener, { once: true, passive: true });
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  _buildDOM() {
    // Section header row
    const hdr = document.createElement('div');
    hdr.style.cssText = [
      'display: flex',
      'align-items: center',
      'justify-content: space-between',
      'margin-bottom: 10px',
    ].join(';');

    this._hdrTitle = document.createElement('span');
    this._hdrTitle.style.cssText = [
      'font-size: var(--text-micro)',
      'color: var(--text-muted)',
      'text-transform: uppercase',
      'letter-spacing: 0.08em',
    ].join(';');
    this._hdrTitle.textContent = 'Alarm Log';

    this._hdrCount = document.createElement('span');
    this._hdrCount.style.cssText = [
      'font-size: var(--text-micro)',
      'color: var(--text-faint)',
    ].join(';');
    this._hdrCount.textContent = '0 events';

    hdr.appendChild(this._hdrTitle);
    hdr.appendChild(this._hdrCount);
    this._container.appendChild(hdr);

    // Scrollable list area
    this._listEl = document.createElement('div');
    this._listEl.setAttribute('role', 'log');
    this._listEl.setAttribute('aria-live', 'polite');
    this._listEl.setAttribute('aria-label', 'Alarm event log');
    this._listEl.style.cssText = [
      'overflow-y: auto',
      'max-height: 320px',
      'display: flex',
      'flex-direction: column',
      'gap: 4px',
      // Subtle scrollbar
      'scrollbar-width: thin',
      'scrollbar-color: var(--border-subtle) transparent',
    ].join(';');

    // Empty state placeholder
    this._emptyEl = document.createElement('div');
    this._emptyEl.style.cssText = [
      'padding: 24px',
      'text-align: center',
      'color: var(--text-faint)',
      'font-size: var(--text-micro)',
    ].join(';');
    this._emptyEl.textContent = 'No alarm events yet — monitoring live';
    this._listEl.appendChild(this._emptyEl);

    this._container.appendChild(this._listEl);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Called by the page on each telemetry tick.
   * Detects state transitions and adds alarm events.
   * @param {object} telemetryData
   */
  update(telemetryData) {
    const state       = telemetryData?.state ?? 'BOOT';
    const faultActive = telemetryData?.faults?.active ?? 'NONE';
    const ts          = telemetryData?.ts ?? Date.now();

    const stateChanged       = state !== this._prevState;
    const faultActiveChanged = faultActive !== this._prevFaultActive && faultActive !== 'NONE';

    if (stateChanged && this._prevState !== null) {
      // Compute how long the previous state lasted
      const durationMs = ts - this._stateEnteredAt;
      this._addEvent(state, faultActive, ts, durationMs);
      this._stateEnteredAt = ts;
    } else if (faultActiveChanged && state === this._prevState) {
      // Same state but new fault type — add a supplementary event
      this._addEvent(state, faultActive, ts, 0);
    }

    this._prevState       = state;
    this._prevFaultActive = faultActive;
  }

  /**
   * Enable or disable alarm beep sound.
   * @param {boolean} enabled
   */
  setSoundEnabled(enabled) {
    this._soundEnabled = Boolean(enabled);
  }

  /**
   * Acknowledge all unacknowledged alarms.
   * Attempts POST /api/alarm/ack/all; falls back to local-only on failure.
   */
  async acknowledgeAll() {
    const unacked = this._entries.filter(e => !e.ackedAt);
    if (unacked.length === 0) return;

    try {
      await fetch('/api/alarm/ack/all', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ids: unacked.map(e => e.id) }),
        signal:  AbortSignal.timeout(4000),
      });
    } catch (err) {
      console.warn('[alarmLog] acknowledgeAll API error (local fallback):', err.message);
    }

    // Apply local ack regardless of API response
    const now    = new Date().toISOString();
    const by     = 'Operator';
    for (const entry of unacked) {
      entry.ackedAt = now;
      entry.ackedBy = by;
      this._applyAckStyle(entry.id, now, by);
    }
  }

  /**
   * Clear all entries from memory and DOM.
   * Local-only — does not affect the device NVS log.
   */
  clearLog() {
    this._entries = [];
    this._listEl.innerHTML = '';
    this._listEl.appendChild(this._emptyEl);
    this._updateHdrCount();
  }

  /**
   * Remove event listeners and DOM.
   */
  destroy() {
    document.removeEventListener('click', this._gestureListener);
    if (this._audioCtx) {
      try { this._audioCtx.close(); } catch (_) {}
      this._audioCtx = null;
    }
  }

  // ── Event management ──────────────────────────────────────────────────────

  /**
   * Add a new alarm event to the log.
   * @param {string} state
   * @param {string} faultActive
   * @param {number} ts         — epoch ms
   * @param {number} durationMs — how long the previous state lasted
   */
  _addEvent(state, faultActive, ts, durationMs) {
    const severity  = STATE_SEVERITY[state] ?? 'INFO';
    const faultName = faultActive !== 'NONE' ? faultActive : state;

    const entry = {
      id:         _nextId(),
      ts,
      severity,
      state,
      faultName,
      durationMs,
      ackedAt:    null,
      ackedBy:    null,
    };

    // Prepend to memory array (newest first)
    this._entries.unshift(entry);

    // Enforce max-size: drop the oldest (last) entry if over limit
    if (this._entries.length > this._maxEntries) {
      const removed = this._entries.pop();
      // Remove its DOM row from the bottom of the list
      const oldRow = this._listEl.querySelector(`[data-alarm-id="${removed.id}"]`);
      oldRow?.remove();
    }

    // Remove empty placeholder if this is the first entry
    if (this._entries.length === 1) {
      this._emptyEl.remove();
    }

    // Prepend DOM row at the top
    const row = this._buildRow(entry);
    this._listEl.prepend(row);
    this._updateHdrCount();

    // Notify callback
    if (this._onNewEvent) {
      try { this._onNewEvent(entry); } catch (err) {
        console.error('[alarmLog] onNewEvent callback error:', err);
      }
    }

    // Sound on FAULT/LOCKOUT
    if (severity === 'FAULT' && this._soundEnabled) {
      this._playBeep(440, 200);
    }

    // Browser notification on FAULT
    if (severity === 'FAULT') {
      this._sendNotification(faultName, state);
    }
  }

  // ── DOM row builder ───────────────────────────────────────────────────────

  _buildRow(entry) {
    const row = document.createElement('div');
    row.setAttribute('data-alarm-id', entry.id);
    row.style.cssText = [
      'display: flex',
      'align-items: center',
      'gap: 8px',
      'padding: 8px 10px',
      'border-radius: var(--radius-sm)',
      `background: ${SEVERITY_BG[entry.severity]}`,
      'border-left: 2px solid ' + SEVERITY_COLOR[entry.severity],
      'transition: opacity 400ms ease',
    ].join(';');

    // Timestamp
    const tsEl = document.createElement('span');
    tsEl.style.cssText = [
      'font-size: var(--text-micro)',
      'color: var(--text-faint)',
      'font-family: var(--font-mono)',
      'white-space: nowrap',
      'flex-shrink: 0',
      'min-width: 58px',
    ].join(';');
    tsEl.textContent = _relativeTime(entry.ts);
    // Update relative time every minute
    tsEl._ts = entry.ts;

    // Severity badge
    const badge = document.createElement('span');
    badge.style.cssText = [
      'font-size: 9px',
      'font-weight: 600',
      'padding: 2px 6px',
      'border-radius: var(--radius-pill)',
      `color: ${SEVERITY_COLOR[entry.severity]}`,
      `border: 1px solid ${SEVERITY_COLOR[entry.severity]}`,
      'white-space: nowrap',
      'flex-shrink: 0',
    ].join(';');
    badge.textContent = entry.severity;

    // Fault name
    const nameEl = document.createElement('span');
    nameEl.style.cssText = [
      'font-size: var(--text-micro)',
      'color: var(--text-primary)',
      'flex: 1',
      'min-width: 0',
      'overflow: hidden',
      'text-overflow: ellipsis',
      'white-space: nowrap',
    ].join(';');
    nameEl.textContent = entry.faultName.replace(/_/g, ' ');

    // Duration badge (hidden if 0)
    const durEl = document.createElement('span');
    durEl.style.cssText = [
      'font-size: var(--text-micro)',
      'color: var(--text-faint)',
      'font-family: var(--font-mono)',
      'white-space: nowrap',
      'flex-shrink: 0',
    ].join(';');
    if (entry.durationMs > 500) {
      durEl.textContent = _formatDuration(entry.durationMs);
    }

    // Ack button
    const ackBtn = document.createElement('button');
    ackBtn.style.cssText = [
      'background: transparent',
      'border: 1px solid var(--border-subtle)',
      'border-radius: var(--radius-sm)',
      'color: var(--text-muted)',
      'font-size: 9px',
      'padding: 2px 7px',
      'cursor: pointer',
      'white-space: nowrap',
      'flex-shrink: 0',
      'transition: border-color 200ms ease, color 200ms ease',
    ].join(';');
    ackBtn.textContent = 'ACK';
    ackBtn.setAttribute('aria-label', `Acknowledge alarm ${entry.faultName}`);

    ackBtn.addEventListener('mouseenter', () => {
      ackBtn.style.borderColor = SEVERITY_COLOR[entry.severity];
      ackBtn.style.color       = SEVERITY_COLOR[entry.severity];
    });
    ackBtn.addEventListener('mouseleave', () => {
      ackBtn.style.borderColor = 'var(--border-subtle)';
      ackBtn.style.color       = 'var(--text-muted)';
    });

    ackBtn.addEventListener('click', () => this._ackEntry(entry.id, ackBtn));

    row.appendChild(tsEl);
    row.appendChild(badge);
    row.appendChild(nameEl);
    row.appendChild(durEl);
    row.appendChild(ackBtn);

    return row;
  }

  // ── Acknowledge ───────────────────────────────────────────────────────────

  async _ackEntry(id, ackBtn) {
    const entry = this._entries.find(e => e.id === id);
    if (!entry || entry.ackedAt) return;

    // Disable button while request is in flight
    ackBtn.disabled    = true;
    ackBtn.textContent = '…';

    try {
      await fetch('/api/alarm/ack', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id }),
        signal:  AbortSignal.timeout(4000),
      });
    } catch (err) {
      console.warn('[alarmLog] ack API error (local fallback):', err.message);
    }

    // Apply local ack regardless of API result
    const now = new Date().toISOString();
    entry.ackedAt = now;
    entry.ackedBy = 'Operator';
    this._applyAckStyle(id, now, 'Operator');
  }

  _applyAckStyle(id, ackedAt, ackedBy) {
    const row = this._listEl.querySelector(`[data-alarm-id="${id}"]`);
    if (!row) return;

    // Dim the row
    row.style.opacity     = '0.45';
    row.style.borderColor = 'var(--border-subtle)';
    row.style.background  = 'transparent';

    // Replace ack button with acked label
    const ackBtn = row.querySelector('button');
    if (ackBtn) {
      ackBtn.style.border  = 'none';
      ackBtn.style.color   = 'var(--text-faint)';
      ackBtn.style.cursor  = 'default';
      ackBtn.disabled      = true;
      ackBtn.textContent   = '✓ ACK';
      ackBtn.title         = `Acked by ${ackedBy} at ${new Date(ackedAt).toLocaleTimeString()}`;
    }
  }

  // ── Header count ──────────────────────────────────────────────────────────

  _updateHdrCount() {
    const total   = this._entries.length;
    const unacked = this._entries.filter(e => !e.ackedAt).length;

    if (total === 0) {
      this._hdrCount.textContent = '0 events';
    } else if (unacked > 0) {
      this._hdrCount.textContent = `${total} events · ${unacked} unacked`;
      this._hdrCount.style.color = 'var(--warn-active)';
    } else {
      this._hdrCount.textContent = `${total} events`;
      this._hdrCount.style.color = 'var(--text-faint)';
    }
  }

  // ── Sound ─────────────────────────────────────────────────────────────────

  _ensureAudioCtx() {
    if (this._audioCtx) return;
    try {
      this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (err) {
      console.warn('[alarmLog] Web Audio API not available:', err.message);
    }
  }

  /**
   * Play a sine-wave beep.
   * @param {number} freq       — Hz
   * @param {number} durationMs — milliseconds
   */
  _playBeep(freq, durationMs) {
    if (!this._soundEnabled) return;
    this._ensureAudioCtx();
    const ctx = this._audioCtx;
    if (!ctx) return;

    try {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type      = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime);

      // Smooth attack and decay to avoid clicks
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.01);
      gain.gain.linearRampToValueAtTime(0,    ctx.currentTime + durationMs / 1000);

      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + durationMs / 1000 + 0.02);
    } catch (err) {
      console.warn('[alarmLog] beep error:', err.message);
    }
  }

  // ── Browser notifications ─────────────────────────────────────────────────

  _requestNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }

  _sendNotification(faultName, state) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    try {
      new Notification('Smart Grid Sentinel — FAULT', {
        body: `${faultName.replace(/_/g, ' ')} · FSM state: ${state}`,
        icon: '/favicon.ico',
        tag:  'sgs-fault',  // replaces previous notification instead of stacking
      });
    } catch (err) {
      console.warn('[alarmLog] notification error:', err.message);
    }
  }
}

// ── Time formatters ───────────────────────────────────────────────────────────

/**
 * Returns a relative time string: "just now", "2m ago", "1h 14m ago", etc.
 * @param {number} ts — epoch ms
 */
function _relativeTime(ts) {
  const diffMs = Date.now() - ts;
  const s      = Math.floor(diffMs / 1000);
  if (s < 10)  return 'just now';
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m ago`;
}

/**
 * Format a duration in ms as "4.8s", "2m 3s", etc.
 * @param {number} ms
 */
function _formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)  return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}
