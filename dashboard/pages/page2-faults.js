/**
 * page2-faults.js — Smart Grid Sentinel Page 2: Faults & Control
 * Phase 6 deliverable. DESIGN.md §9.
 *
 * Operational control page for fault management, system inspection and reset.
 *
 * Layout (top → bottom):
 *   Row 1 (header)    — page title · FSM state badge · sound mute toggle
 *   Row 2 (top grid)  — FaultMatrix (left) · AlarmLog (right)
 *   Row 3 (mid grid)  — FSM flow diagram · IDMT arc + reclose timer · Reset guard
 *   Row 4 (bottom)    — RelayToggle + override banner + last-change + protection ArcGauge
 *
 * Page lifecycle (DESIGN.md §17):
 *   mount(containerEl)     — build DOM, instantiate components
 *   update(telemetryData)  — route live data to all sub-components
 *   destroy()              — tear down all components, remove injected styles
 *
 * Update rate gating (DESIGN.md §7):
 *   always  — FaultMatrix, AlarmLog, IDMT arc, relay state
 *   1 Hz    — FSM badge, trip counter, reset guard, reclose countdown
 *   0.5 Hz  — ArcGauge (protection curve)
 */

import { FaultMatrix }  from '../components/faultMatrix.js';
import { AlarmLog }     from '../components/alarmLog.js';
import { RelayToggle }  from '../components/relayToggle.js';
import { ArcGauge }     from '../components/arcGauge.js';
import { StateBadge }   from '../components/stateBadge.js';

// ── Style injection (scoped to this page) ─────────────────────────────────
const STYLE_ID   = 'p2-page-styles';
const LAYOUT_CLS = 'p2-active';

const PAGE2_CSS = `
/* ─── Page 2 root layout ─── */
.p2-active {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  padding: var(--space-lg) var(--space-xl);
  min-height: 0;
}

/* ─── Cards ─── */
.p2-card {
  background: var(--bg-card-dark);
  border-radius: var(--radius-md);
  padding: var(--space-md);
}
.p2-card-hdr {
  font-size: var(--text-micro);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: var(--space-sm);
}

/* ─── Page header row ─── */
.p2-page-hdr {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.p2-page-title {
  font-size: var(--text-section);
  font-weight: 300;
  color: var(--text-primary);
  letter-spacing: 0.02em;
  flex: 1;
}

/* ─── Top grid: two equal columns ─── */
.p2-top-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-md);
  min-height: 0;
}

/* ─── Mid grid: three columns ─── */
.p2-mid-grid {
  display: grid;
  grid-template-columns: 1.6fr 1.2fr 1fr;
  gap: var(--space-md);
  min-height: 0;
}

/* ─── Bottom row ─── */
.p2-bottom-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-md);
}

/* ─── Mute toggle button ─── */
.p2-mute-btn {
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: var(--text-micro);
  padding: 4px 10px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 5px;
  transition: border-color 200ms ease, color 200ms ease;
}
.p2-mute-btn:hover {
  border-color: var(--text-primary);
  color: var(--text-primary);
}
.p2-mute-btn.muted {
  border-color: var(--fault-active);
  color: var(--fault-active);
}

/* ─── Action buttons (Ack All, Clear) ─── */
.p2-action-btn {
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: var(--text-micro);
  padding: 6px 14px;
  cursor: pointer;
  transition: border-color 200ms ease, color 200ms ease, background 200ms ease;
}
.p2-action-btn:hover {
  border-color: var(--text-primary);
  color: var(--text-primary);
}
.p2-action-btn.danger:hover {
  border-color: var(--fault-active);
  color: var(--fault-active);
}

/* ─── FSM State Flow SVG ─── */
.p2-fsm-svg { width: 100%; height: auto; display: block; }

/* ─── Trip counter steps ─── */
.p2-trip-steps {
  display: flex;
  align-items: center;
  gap: 0;
  justify-content: center;
  margin-top: 14px;
}
.p2-trip-circle {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 2px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-micro);
  font-weight: 600;
  color: var(--text-faint);
  background: var(--bg-card-dark-2, var(--bg-card-dark));
  transition: background 400ms ease, border-color 400ms ease, color 400ms ease;
  flex-shrink: 0;
  position: relative;
  z-index: 1;
}
.p2-trip-line {
  flex: 1;
  height: 2px;
  background: var(--border-subtle);
  transition: background 400ms ease;
}
.p2-trip-label {
  font-size: var(--text-micro);
  color: var(--text-muted);
  text-align: center;
  margin-top: 8px;
}

/* ─── IDMT accumulator bar ─── */
.p2-idmt-track {
  height: 14px;
  background: var(--progress-track);
  border-radius: var(--radius-pill);
  overflow: hidden;
  position: relative;
  margin: 8px 0;
}
.p2-idmt-fill {
  height: 100%;
  width: 0%;
  border-radius: var(--radius-pill);
  background: var(--health-excellent);
  transition: width 600ms ease-in-out, background 400ms ease-in-out;
  position: relative;
}
.p2-idmt-fill::after {
  content: '';
  position: absolute;
  right: -2px;
  top: 0;
  width: 4px;
  height: 100%;
  background: inherit;
  border-radius: 0 var(--radius-pill) var(--radius-pill) 0;
  opacity: 0.8;
}
.p2-idmt-ticks {
  display: flex;
  justify-content: space-between;
  font-size: 9px;
  color: var(--text-faint);
  font-family: var(--font-mono);
  margin-top: 3px;
}

/* ─── Reclose countdown ring ─── */
.p2-reclose-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.p2-reclose-svg {
  width: 88px;
  height: 88px;
}
.p2-reclose-label {
  font-size: var(--text-micro);
  color: var(--text-muted);
  text-align: center;
}
.p2-reclose-hidden { opacity: 0.3; pointer-events: none; }

/* ─── Reset guard ─── */
.p2-guard-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px solid var(--border-subtle);
}
.p2-guard-row:last-of-type { border-bottom: none; }
.p2-guard-icon {
  font-size: 14px;
  width: 18px;
  text-align: center;
  flex-shrink: 0;
}
.p2-guard-name {
  font-size: var(--text-micro);
  color: var(--text-muted);
  flex: 1;
}
.p2-guard-value {
  font-size: var(--text-micro);
  color: var(--text-faint);
  font-family: var(--font-mono);
  text-align: right;
  flex-shrink: 0;
}
.p2-reset-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
  flex-wrap: wrap;
}
.p2-reset-btn {
  flex: 1;
  padding: 8px 4px;
  border-radius: var(--radius-sm);
  border: none;
  font-size: var(--text-micro);
  font-weight: 600;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: opacity 200ms ease, filter 200ms ease;
  min-width: 60px;
}
.p2-reset-btn:hover { filter: brightness(1.15); }
.p2-reset-btn:disabled { opacity: 0.35; cursor: not-allowed; filter: none; }
.p2-reset-btn--reset  { background: var(--health-excellent); color: #000; }
.p2-reset-btn--reboot { background: var(--state-warning);   color: #000; }
.p2-reset-btn--ping   { background: var(--state-recovery);  color: #000; }

/* ─── Relay override banner ─── */
.p2-relay-banner {
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: rgba(239,159,39,0.12);
  border-left: 3px solid var(--state-warning);
  font-size: var(--text-micro);
  color: var(--state-warning);
  margin-bottom: 10px;
  display: none;
}
.p2-relay-banner.visible { display: block; }

.p2-relay-last-change {
  font-size: var(--text-micro);
  color: var(--text-faint);
  margin-top: 8px;
}

/* ─── Confirm modal overlay ─── */
.p2-confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9000;
  opacity: 0;
  pointer-events: none;
  transition: opacity 200ms ease;
}
.p2-confirm-overlay.visible {
  opacity: 1;
  pointer-events: all;
}
.p2-confirm-dialog {
  background: var(--bg-card-dark);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 24px;
  max-width: 340px;
  width: 90%;
  box-shadow: 0 24px 64px rgba(0,0,0,0.6);
}
.p2-confirm-title {
  font-size: var(--text-label);
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 8px;
}
.p2-confirm-body {
  font-size: var(--text-micro);
  color: var(--text-muted);
  line-height: 1.6;
  margin-bottom: 20px;
}
.p2-confirm-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
.p2-confirm-cancel {
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: var(--text-micro);
  padding: 7px 16px;
  cursor: pointer;
}
.p2-confirm-ok {
  background: var(--fault-active);
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--text-micro);
  font-weight: 600;
  padding: 7px 16px;
  cursor: pointer;
}

/* ─── Responsive: single column on narrow screens ─── */
@media (max-width: 900px) {
  .p2-top-grid,
  .p2-mid-grid,
  .p2-bottom-row { grid-template-columns: 1fr; }
}
`;

// ── FSM state flow: node definitions ─────────────────────────────────────
// SVG viewBox 480×110. Nodes laid out in flow order.
const FSM_NODES = [
  { id: 'BOOT',     x:  10, y: 35, label: 'BOOT',     color: '#3B8BD4', muted: '#1a2a3a' },
  { id: 'NORMAL',   x:  95, y: 35, label: 'NORMAL',   color: '#1D9E75', muted: '#0f3025' },
  { id: 'WARNING',  x: 185, y: 35, label: 'WARNING',  color: '#EF9F27', muted: '#3a2a10' },
  { id: 'FAULT',    x: 280, y: 35, label: 'FAULT',    color: '#E24B4A', muted: '#3a1515' },
  { id: 'RECOVERY', x: 375, y:  5, label: 'RECOVERY', color: '#1D9E75', muted: '#0f3025' },
  { id: 'LOCKOUT',  x: 375, y: 65, label: 'LOCKOUT',  color: '#A32D2D', muted: '#2a1010' },
];
const FSM_NODE_W = 68;
const FSM_NODE_H = 26;

// ── IDMT fill color zones ─────────────────────────────────────────────────
function _idmtColor(pct) {
  if (pct >= 0.80) return 'var(--state-fault)';
  if (pct >= 0.50) return 'var(--state-warning)';
  return 'var(--health-excellent)';
}

// ── IDMT accumulator estimation (DESIGN.md §9 Infographic 2.5) ────────────
function _estimateIdmt(telemetryData) {
  const oc      = _getField(telemetryData, 'faults.over_current')    ?? false;
  const ocWarn  = _getField(telemetryData, 'faults.warnings.oc')     ?? false;
  const state   = telemetryData?.state ?? 'NORMAL';

  if (oc)     return 1.0;
  if (ocWarn) return 0.5 + (state === 'FAULT' ? 0.25 : 0.1);
  if (state === 'FAULT' || state === 'LOCKOUT') return 0.3;
  return 0.05;
}

// ── SVG helpers ────────────────────────────────────────────────────────────
const SVG_NS = 'http://www.w3.org/2000/svg';

function _svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

function _getField(obj, path) {
  if (!path || !obj) return null;
  if (!path.includes('.')) return obj[path] ?? null;
  return path.split('.').reduce((acc, k) => acc?.[k], obj) ?? null;
}

// ── Reclose dead times per trip count ────────────────────────────────────
const RECLOSE_DEAD_TIMES = [5, 15, 30]; // seconds for trips 1, 2, 3

// ── Page class ────────────────────────────────────────────────────────────
export class Page2Faults {
  // ── mount ────────────────────────────────────────────────────────────────

  mount(containerEl) {
    this._container = containerEl;

    // State
    this._soundEnabled          = true;
    this._lastTelemetry         = null;
    this._tickCount             = 0;
    this._relayChangeTs         = null;
    this._relayChangeReason     = '—';
    this._faultEnteredAt        = null;
    this._prevRelayState        = null;
    this._guardsPassing         = false;

    // Component references
    this._components = [];
    this._alarmLog   = null;
    this._faultMatrix = null;
    this._relayToggle = null;
    this._arcGauge   = null;
    this._stateBadge = null;

    // Reclose countdown tick handle
    this._recloseInterval = null;
    this._recloseDeadlineMs = null;

    // Inject page CSS
    _injectStyle(STYLE_ID, PAGE2_CSS);

    // Clear placeholder content
    containerEl.innerHTML = '';
    containerEl.classList.add(LAYOUT_CLS);

    // Build layout
    this._buildPageHeader(containerEl);
    this._buildTopGrid(containerEl);
    this._buildMidGrid(containerEl);
    this._buildBottomRow(containerEl);
    this._buildConfirmDialog(containerEl);
  }

  // ── update ───────────────────────────────────────────────────────────────

  update(telemetryData) {
    if (!telemetryData) return;
    this._lastTelemetry = telemetryData;
    this._tickCount++;

    // Always: fault matrix, alarm log, relay, IDMT, FSM diagram
    this._faultMatrix?.update(telemetryData);
    this._alarmLog?.update(telemetryData);
    this._updateRelaySection(telemetryData);
    this._updateIdmt(telemetryData);
    this._updateFsmDiagram(telemetryData);

    // Track fault entry time for reclose countdown
    const state = telemetryData.state ?? 'NORMAL';
    if (state === 'FAULT' && this._prevFsmState !== 'FAULT') {
      this._faultEnteredAt    = Date.now();
      const trips             = telemetryData.faults?.trip_count ?? 1;
      const deadSecs          = RECLOSE_DEAD_TIMES[Math.min(trips - 1, 2)] ?? 5;
      this._recloseDeadlineMs = this._faultEnteredAt + deadSecs * 1000;
      this._startRecloseTimer();
    } else if (state !== 'FAULT') {
      this._stopRecloseTimer();
    }
    this._prevFsmState = state;

    // 1 Hz: trip counter, state badge, reset guard
    if (this._tickCount % 2 === 0) {
      this._updateTripCounter(telemetryData);
      this._stateBadge?.update(telemetryData);
      this._updateResetGuard(telemetryData);
      this._updateRecloseVisibility(state);
    }

    // 0.5 Hz: protection arc gauge
    if (this._tickCount % 4 === 0) {
      const idmtPct = _estimateIdmt(telemetryData);
      // Feed as a synthetic telemetry-compatible object
      this._arcGauge?.update({ protection_idmt: idmtPct * 100 });
    }
  }

  // ── destroy ──────────────────────────────────────────────────────────────

  destroy() {
    this._stopRecloseTimer();

    for (const c of this._components) {
      try { c.destroy(); } catch (e) { console.error('[page2] component destroy error:', e); }
    }
    this._components = [];

    this._container?.classList.remove(LAYOUT_CLS);
    this._container?.querySelectorAll('[data-p2-confirm]').forEach(el => el.remove());

    const styleEl = document.getElementById(STYLE_ID);
    styleEl?.remove();

    this._container = null;
  }

  // ── Page header ───────────────────────────────────────────────────────────

  _buildPageHeader(parent) {
    const hdr = document.createElement('div');
    hdr.className = 'p2-page-hdr';

    const title = document.createElement('h2');
    title.className      = 'p2-page-title';
    title.textContent    = 'Faults & Control';

    // FSM state badge (using Phase 3 StateBadge component)
    const badgeWrap = document.createElement('div');
    this._stateBadge = new StateBadge(badgeWrap, {});
    this._components.push(this._stateBadge);
    // Seed with BOOT state until first update
    this._stateBadge.update({ state: 'BOOT' });

    // Sound mute toggle
    const muteBtn = document.createElement('button');
    muteBtn.className   = 'p2-mute-btn';
    muteBtn.innerHTML   = '🔔 Sound on';
    muteBtn.setAttribute('aria-pressed', 'false');
    muteBtn.setAttribute('aria-label', 'Toggle alarm sound');

    muteBtn.addEventListener('click', () => {
      this._soundEnabled = !this._soundEnabled;
      this._alarmLog?.setSoundEnabled(this._soundEnabled);

      if (this._soundEnabled) {
        muteBtn.innerHTML = '🔔 Sound on';
        muteBtn.classList.remove('muted');
        muteBtn.setAttribute('aria-pressed', 'false');
      } else {
        muteBtn.innerHTML = '🔇 Muted';
        muteBtn.classList.add('muted');
        muteBtn.setAttribute('aria-pressed', 'true');
      }
    });

    hdr.appendChild(title);
    hdr.appendChild(badgeWrap);
    hdr.appendChild(muteBtn);
    parent.appendChild(hdr);
  }

  // ── Top grid: FaultMatrix (left) + AlarmLog (right) ──────────────────────

  _buildTopGrid(parent) {
    const grid = document.createElement('div');
    grid.className = 'p2-top-grid';

    // Left: fault matrix
    const leftCard = document.createElement('div');
    leftCard.className = 'p2-card';

    const faultMatrixWrap = document.createElement('div');
    this._faultMatrix = new FaultMatrix(faultMatrixWrap, { showWarnings: true });
    this._components.push(this._faultMatrix);
    leftCard.appendChild(faultMatrixWrap);

    // Active/total counts summary
    this._faultSummaryEl = document.createElement('div');
    this._faultSummaryEl.style.cssText = [
      'margin-top: 12px',
      'padding-top: 10px',
      'border-top: 1px solid var(--border-subtle)',
      'display: flex',
      'gap: 20px',
    ].join(';');

    this._activeCountEl = _statItem('Active', '0');
    this._totalCountEl  = _statItem('Total (session)', '0');
    this._faultSummaryEl.appendChild(this._activeCountEl.el);
    this._faultSummaryEl.appendChild(this._totalCountEl.el);
    leftCard.appendChild(this._faultSummaryEl);

    this._totalFaultCount = 0;

    // Right: alarm log
    const rightCard = document.createElement('div');
    rightCard.className = 'p2-card';
    rightCard.style.cssText += '; display: flex; flex-direction: column; gap: 10px;';

    const alarmWrap = document.createElement('div');
    this._alarmLog = new AlarmLog(alarmWrap, {
      maxEntries: 200,
      onNewEvent: (entry) => {
        // Keep active/total counts in sync
        if (entry.severity === 'FAULT' || entry.severity === 'WARNING') {
          this._totalFaultCount++;
          this._totalCountEl.valueEl.textContent = this._totalFaultCount.toString();
        }
      },
    });
    this._components.push(this._alarmLog);
    rightCard.appendChild(alarmWrap);

    // Action buttons
    const actions = document.createElement('div');
    actions.style.cssText = [
      'display: flex',
      'gap: 8px',
      'flex-wrap: wrap',
    ].join(';');

    const ackAllBtn = document.createElement('button');
    ackAllBtn.className   = 'p2-action-btn';
    ackAllBtn.textContent = 'Acknowledge All';
    ackAllBtn.addEventListener('click', () => this._alarmLog?.acknowledgeAll());

    const clearBtn = document.createElement('button');
    clearBtn.className   = 'p2-action-btn danger';
    clearBtn.textContent = 'Clear Log';
    clearBtn.addEventListener('click', () => {
      this._alarmLog?.clearLog();
      this._totalFaultCount = 0;
      this._totalCountEl.valueEl.textContent = '0';
    });

    actions.appendChild(ackAllBtn);
    actions.appendChild(clearBtn);
    rightCard.appendChild(actions);

    grid.appendChild(leftCard);
    grid.appendChild(rightCard);
    parent.appendChild(grid);
  }

  _updateActiveFaultCount(telemetryData) {
    const faults = telemetryData?.faults ?? {};
    let count = 0;
    if (faults.over_voltage)  count++;
    if (faults.over_current)  count++;
    if (faults.over_temp)     count++;
    if (faults.short_circuit) count++;
    if (faults.active && faults.active !== 'NONE') count++;

    if (this._activeCountEl) {
      this._activeCountEl.valueEl.textContent = count.toString();
      this._activeCountEl.valueEl.style.color = count > 0
        ? 'var(--fault-active)' : 'var(--health-excellent)';
    }
  }

  // ── Mid grid: FSM diagram · IDMT + reclose · Reset guard ─────────────────

  _buildMidGrid(parent) {
    const grid = document.createElement('div');
    grid.className = 'p2-mid-grid';

    this._buildFsmCard(grid);
    this._buildIdmtCard(grid);
    this._buildResetGuardCard(grid);

    parent.appendChild(grid);
  }

  // ── FSM State Flow Diagram + Trip Counter ─────────────────────────────────

  _buildFsmCard(parent) {
    const card = document.createElement('div');
    card.className = 'p2-card';

    const hdr = document.createElement('div');
    hdr.className   = 'p2-card-hdr';
    hdr.textContent = 'FSM State Flow';
    card.appendChild(hdr);

    // Build SVG
    this._fsmSvg = this._buildFsmSvg();
    card.appendChild(this._fsmSvg);

    // Trip counter below the diagram
    const tripHdr = document.createElement('div');
    tripHdr.style.cssText = [
      'font-size: 9px',
      'color: var(--text-faint)',
      'text-transform: uppercase',
      'letter-spacing: 0.08em',
      'margin-top: 14px',
      'margin-bottom: 2px',
    ].join(';');
    tripHdr.textContent = 'Trip Counter';
    card.appendChild(tripHdr);

    this._tripSteps = this._buildTripCounter(card);

    parent.appendChild(card);
  }

  _buildFsmSvg() {
    const vbW = 480;
    const vbH = 115;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${vbW} ${vbH}`);
    svg.setAttribute('class', 'p2-fsm-svg');
    svg.setAttribute('aria-label', 'FSM state flow diagram');

    // Arrow marker
    const defs   = _svgEl('defs');
    const marker = _svgEl('marker', {
      id:           'fsm-arrow',
      viewBox:      '0 0 6 6',
      refX:         '5',
      refY:         '3',
      markerWidth:  '4',
      markerHeight: '4',
      orient:       'auto',
    });
    marker.appendChild(_svgEl('path', { d: 'M 0 0 L 6 3 L 0 6 Z', fill: 'var(--border-subtle)' }));
    defs.appendChild(marker);

    // Red arrow marker for LOCKOUT path
    const markerRed = _svgEl('marker', {
      id:           'fsm-arrow-red',
      viewBox:      '0 0 6 6',
      refX:         '5',
      refY:         '3',
      markerWidth:  '4',
      markerHeight: '4',
      orient:       'auto',
    });
    markerRed.appendChild(_svgEl('path', { d: 'M 0 0 L 6 3 L 0 6 Z', fill: 'var(--fault-active)' }));
    defs.appendChild(markerRed);
    svg.appendChild(defs);

    // ── Transition arrows ──────────────────────────────────────────────────
    const transitions = [
      // [fromId, toId, style] style: 'normal' | 'red' | 'dashed'
      ['BOOT',     'NORMAL',   'normal'],
      ['NORMAL',   'WARNING',  'normal'],
      ['WARNING',  'NORMAL',   'normal'],   // clears
      ['WARNING',  'FAULT',    'normal'],   // escalates
      ['FAULT',    'RECOVERY', 'normal'],
      ['FAULT',    'LOCKOUT',  'red'],      // direct lockout
      ['RECOVERY', 'NORMAL',   'dashed'],  // re-entry
      ['RECOVERY', 'FAULT',    'dashed'],  // re-trip
    ];

    for (const [fromId, toId, style] of transitions) {
      const from = FSM_NODES.find(n => n.id === fromId);
      const to   = FSM_NODES.find(n => n.id === toId);
      if (!from || !to) continue;

      // Mid-right of source, mid-left of dest
      const x1 = from.x + FSM_NODE_W;
      const y1 = from.y + FSM_NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y + FSM_NODE_H / 2;

      const attrs = {
        d:            `M ${x1} ${y1} L ${x2} ${y2}`,
        fill:         'none',
        'stroke-width': style === 'red' ? '1.5' : '1',
        'marker-end': style === 'red' ? 'url(#fsm-arrow-red)' : 'url(#fsm-arrow)',
      };

      if (style === 'dashed') {
        attrs['stroke-dasharray'] = '3,3';
        attrs['stroke']           = 'var(--border-subtle)';
        attrs['opacity']          = '0.6';
      } else if (style === 'red') {
        attrs['stroke'] = 'var(--fault-active)';
      } else {
        attrs['stroke'] = 'var(--border-subtle)';
      }

      svg.appendChild(_svgEl('path', attrs));
    }

    // ── State node boxes ──────────────────────────────────────────────────
    this._fsmNodeEls = new Map();

    for (const node of FSM_NODES) {
      const g = _svgEl('g');

      const rect = _svgEl('rect', {
        x:              node.x,
        y:              node.y,
        width:          FSM_NODE_W,
        height:         FSM_NODE_H,
        rx:             5,
        ry:             5,
        fill:           node.muted,
        stroke:         node.muted,
        'stroke-width': '1',
        style:          'transition: fill 600ms ease-in-out, stroke 600ms ease-in-out, filter 600ms ease-in-out;',
      });

      const text = _svgEl('text', {
        x:               node.x + FSM_NODE_W / 2,
        y:               node.y + FSM_NODE_H / 2 + 4,
        'text-anchor':   'middle',
        fill:            'var(--text-faint)',
        'font-size':     '9',
        'font-family':   'var(--font-primary)',
        'letter-spacing':'0.05em',
        style:           'transition: fill 600ms ease-in-out; pointer-events: none;',
      });
      text.textContent = node.label;

      g.appendChild(rect);
      g.appendChild(text);
      svg.appendChild(g);

      this._fsmNodeEls.set(node.id, { rect, text });
    }

    return svg;
  }

  _buildTripCounter(parent) {
    const wrap = document.createElement('div');
    wrap.className = 'p2-trip-steps';

    const circles  = [];
    const lines    = [];

    for (let i = 0; i < 3; i++) {
      if (i > 0) {
        const line = document.createElement('div');
        line.className = 'p2-trip-line';
        wrap.appendChild(line);
        lines.push(line);
      }

      const circle = document.createElement('div');
      circle.className = 'p2-trip-circle';
      circle.textContent = String(i + 1);
      wrap.appendChild(circle);
      circles.push(circle);
    }

    parent.appendChild(wrap);

    // Label below
    this._tripLabelEl = document.createElement('div');
    this._tripLabelEl.className   = 'p2-trip-label';
    this._tripLabelEl.textContent = 'Trip 0 of 3';
    parent.appendChild(this._tripLabelEl);

    return { circles, lines };
  }

  // ── IDMT Accumulator + Reclose Countdown ──────────────────────────────────

  _buildIdmtCard(parent) {
    const card = document.createElement('div');
    card.className = 'p2-card';

    // IDMT section
    const idmtHdr = document.createElement('div');
    idmtHdr.className   = 'p2-card-hdr';
    idmtHdr.textContent = 'IDMT Accumulator — IEC 60255';
    card.appendChild(idmtHdr);

    const idmtSubLabel = document.createElement('div');
    idmtSubLabel.style.cssText = [
      'font-size: 9px',
      'color: var(--text-faint)',
      'margin-bottom: 8px',
    ].join(';');
    idmtSubLabel.textContent = 'Thermal memory — decays below pickup';
    card.appendChild(idmtSubLabel);

    // Track bar
    const idmtTrack = document.createElement('div');
    idmtTrack.className = 'p2-idmt-track';

    this._idmtFillEl = document.createElement('div');
    this._idmtFillEl.className = 'p2-idmt-fill';
    idmtTrack.appendChild(this._idmtFillEl);
    card.appendChild(idmtTrack);

    // Tick marks
    const ticks = document.createElement('div');
    ticks.className = 'p2-idmt-ticks';
    ['0.00', '0.25', '0.50', '0.75', '1.00'].forEach(t => {
      const el = document.createElement('span');
      el.textContent = t;
      ticks.appendChild(el);
    });
    card.appendChild(ticks);

    // TRIPPED label (hidden unless at 1.0)
    this._idmtTrippedEl = document.createElement('div');
    this._idmtTrippedEl.style.cssText = [
      'font-size: var(--text-micro)',
      'color: var(--fault-active)',
      'font-weight: 600',
      'text-align: right',
      'margin-top: 3px',
      'display: none',
    ].join(';');
    this._idmtTrippedEl.textContent = '⚡ TRIPPED';
    card.appendChild(this._idmtTrippedEl);

    // Divider
    const divider = document.createElement('div');
    divider.style.cssText = [
      'border-top: 1px solid var(--border-subtle)',
      'margin: 14px 0',
    ].join(';');
    card.appendChild(divider);

    // Reclose section
    const recloseHdr = document.createElement('div');
    recloseHdr.className   = 'p2-card-hdr';
    recloseHdr.textContent = 'Auto-Reclose Countdown';
    card.appendChild(recloseHdr);

    this._recloseWrap = document.createElement('div');
    this._recloseWrap.className = 'p2-reclose-wrap p2-reclose-hidden';

    const rcSvg = this._buildRecloseRingSvg();
    this._recloseWrap.appendChild(rcSvg);

    const recloseLabel = document.createElement('div');
    recloseLabel.className = 'p2-reclose-label';

    this._recloseSubLabel = document.createElement('div');
    this._recloseSubLabel.style.cssText = [
      'font-size: 9px',
      'color: var(--text-faint)',
      'text-align: center',
      'margin-top: 2px',
    ].join(';');
    this._recloseSubLabel.textContent = 'Visible during FAULT state only';

    card.appendChild(this._recloseWrap);
    card.appendChild(this._recloseSubLabel);

    parent.appendChild(card);
  }

  _buildRecloseRingSvg() {
    const size = 88;
    const cx   = size / 2;
    const cy   = size / 2;
    const r    = 36;
    const circ = 2 * Math.PI * r;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('class', 'p2-reclose-svg');
    svg.setAttribute('aria-label', 'Reclose countdown ring');

    // Track
    svg.appendChild(_svgEl('circle', {
      cx, cy, r,
      fill:            'none',
      stroke:          'var(--progress-track)',
      'stroke-width':  '6',
    }));

    // Fill (depletes as time passes)
    this._recloseRingFill = _svgEl('circle', {
      cx, cy, r,
      fill:               'none',
      stroke:             'var(--state-recovery)',
      'stroke-width':     '6',
      'stroke-linecap':   'round',
      transform:          `rotate(-90 ${cx} ${cy})`,
      'stroke-dasharray': circ,
      'stroke-dashoffset': 0,
      style:              'transition: stroke-dashoffset 100ms linear;',
    });
    this._recloseCircumference = circ;
    svg.appendChild(this._recloseRingFill);

    // Center text
    this._recloseTimerText = _svgEl('text', {
      x:                   cx,
      y:                   cy + 5,
      'text-anchor':       'middle',
      fill:                'var(--text-primary)',
      'font-size':         '18',
      'font-weight':       '300',
      'font-family':       'var(--font-primary)',
    });
    this._recloseTimerText.textContent = '–';
    svg.appendChild(this._recloseTimerText);

    // Sub-text
    this._recloseSubText = _svgEl('text', {
      x:               cx,
      y:               cy + 16,
      'text-anchor':   'middle',
      fill:            'var(--text-faint)',
      'font-size':     '7',
      'font-family':   'var(--font-primary)',
    });
    this._recloseSubText.textContent = '';
    svg.appendChild(this._recloseSubText);

    return svg;
  }

  _startRecloseTimer() {
    this._stopRecloseTimer();
    this._recloseInterval = setInterval(() => this._tickReclose(), 100);
    this._recloseWrap?.classList.remove('p2-reclose-hidden');
  }

  _stopRecloseTimer() {
    clearInterval(this._recloseInterval);
    this._recloseInterval = null;
  }

  _tickReclose() {
    if (!this._recloseDeadlineMs) return;
    const remaining = Math.max(0, this._recloseDeadlineMs - Date.now());
    const secs      = remaining / 1000;
    const trips     = this._lastTelemetry?.faults?.trip_count ?? 1;
    const totalSecs = RECLOSE_DEAD_TIMES[Math.min(trips - 1, 2)] ?? 5;
    const pct       = remaining / (totalSecs * 1000);

    if (this._recloseTimerText) {
      this._recloseTimerText.textContent = secs < 0.1 ? '0s' : secs.toFixed(1) + 's';
    }
    if (this._recloseSubText) {
      this._recloseSubText.textContent = remaining > 0 ? 'reclosing in...' : 'Reclosing…';
    }
    if (this._recloseRingFill) {
      const offset = this._recloseCircumference * (1 - pct);
      this._recloseRingFill.style.strokeDashoffset = offset;
    }

    if (remaining <= 0) {
      this._stopRecloseTimer();
    }
  }

  _updateRecloseVisibility(state) {
    if (!this._recloseWrap) return;
    if (state === 'FAULT') {
      this._recloseWrap.classList.remove('p2-reclose-hidden');
    } else {
      this._recloseWrap.classList.add('p2-reclose-hidden');
      this._stopRecloseTimer();
    }
  }

  // ── Reset Guard Checklist ─────────────────────────────────────────────────

  _buildResetGuardCard(parent) {
    const card = document.createElement('div');
    card.className = 'p2-card';

    const hdr = document.createElement('div');
    hdr.className   = 'p2-card-hdr';
    hdr.textContent = 'Reset Guard';
    card.appendChild(hdr);

    // Guard rows (3 checks)
    this._guardRows = [];
    const guardDefs = [
      { key: 'temp',    label: 'Temperature',   unit: '°C' },
      { key: 'sensor',  label: 'DS18B20 Sensor', unit: ''  },
      { key: 'nofault', label: 'No Sensor Fault', unit: '' },
    ];

    for (const def of guardDefs) {
      const row = document.createElement('div');
      row.className = 'p2-guard-row';

      const icon    = document.createElement('div');
      icon.className = 'p2-guard-icon';
      icon.textContent = '–';

      const name    = document.createElement('div');
      name.className = 'p2-guard-name';
      name.textContent = def.label;

      const val     = document.createElement('div');
      val.className = 'p2-guard-value';
      val.textContent = '–';

      row.appendChild(icon);
      row.appendChild(name);
      row.appendChild(val);
      card.appendChild(row);

      this._guardRows.push({ icon, val, key: def.key, unit: def.unit });
    }

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'p2-reset-actions';

    this._resetBtn = document.createElement('button');
    this._resetBtn.className = 'p2-reset-btn p2-reset-btn--reset';
    this._resetBtn.textContent = 'RESET';
    this._resetBtn.disabled   = true;
    this._resetBtn.setAttribute('aria-label', 'Reset FSM state');
    this._resetBtn.addEventListener('click', () => this._doReset());

    const rebootBtn = document.createElement('button');
    rebootBtn.className   = 'p2-reset-btn p2-reset-btn--reboot';
    rebootBtn.textContent = 'REBOOT';
    rebootBtn.setAttribute('aria-label', 'Reboot device');
    rebootBtn.addEventListener('click', () => this._doReboot());

    const pingBtn = document.createElement('button');
    pingBtn.className   = 'p2-reset-btn p2-reset-btn--ping';
    pingBtn.textContent = 'PING';
    pingBtn.setAttribute('aria-label', 'Ping device');
    pingBtn.addEventListener('click', () => this._doPing(pingBtn));

    actions.appendChild(this._resetBtn);
    actions.appendChild(rebootBtn);
    actions.appendChild(pingBtn);
    card.appendChild(actions);

    parent.appendChild(card);
  }

  // ── Bottom row: Relay + ArcGauge ──────────────────────────────────────────

  _buildBottomRow(parent) {
    const row = document.createElement('div');
    row.className = 'p2-bottom-row';

    // Left: relay control panel
    const relayCard = document.createElement('div');
    relayCard.className = 'p2-card';

    const relayHdr = document.createElement('div');
    relayHdr.className   = 'p2-card-hdr';
    relayHdr.textContent = 'Relay Control';
    relayCard.appendChild(relayHdr);

    // Override warning banner (hidden until manual override detected)
    this._relayBanner = document.createElement('div');
    this._relayBanner.className = 'p2-relay-banner';
    this._relayBanner.textContent =
      '⚠ Manual override active — relay state may differ from FSM recommendation';
    relayCard.appendChild(this._relayBanner);

    // Relay toggle wrapper — intercept pointerdown for confirmation dialog
    const relayWrap = document.createElement('div');
    relayWrap.style.position = 'relative';

    // Transparent click-interceptor overlay (intercepts → confirm before passing through)
    const interceptor = document.createElement('div');
    interceptor.style.cssText = [
      'position: absolute',
      'inset: 0',
      'z-index: 1',
      'cursor: pointer',
    ].join(';');

    interceptor.addEventListener('pointerdown', (evt) => {
      const d = this._lastTelemetry;
      // Only intercept when relay is currently CLOSED and we'd be opening it
      if (d?.relay !== true) return; // relay already open — no confirmation needed

      evt.preventDefault();
      evt.stopPropagation();
      this._showConfirmDialog(
        'Open Relay?',
        'Opening the relay will disconnect the load immediately. The protection system may re-trip if fault conditions persist. Are you sure?',
        () => {
          // User confirmed — forward the click to the underlying toggle button
          interceptor.style.pointerEvents = 'none';
          const toggleBtn = relayWrap.querySelector('button[role="switch"]');
          toggleBtn?.click();
          // Re-enable interceptor after a tick
          requestAnimationFrame(() => {
            interceptor.style.pointerEvents = '';
          });

          // Record the manual override
          this._relayChangeTs     = Date.now();
          this._relayChangeReason = 'Manual override via dashboard';
          this._relayBanner.classList.add('visible');
          this._updateLastRelayChange();
        }
      );
    }, { capture: true });

    this._relayToggle = new RelayToggle(relayWrap, {
      label:    'Protection Relay',
      apiPath:  '/api/relay',
      onToggle: (newState) => {
        this._relayChangeTs     = Date.now();
        this._relayChangeReason = newState ? 'Relay closed via dashboard' : 'Relay opened via dashboard';
        this._updateLastRelayChange();
      },
    });
    this._components.push(this._relayToggle);

    relayWrap.appendChild(interceptor);
    relayCard.appendChild(relayWrap);

    // Last relay change info
    this._lastRelayChangeEl = document.createElement('div');
    this._lastRelayChangeEl.className   = 'p2-relay-last-change';
    this._lastRelayChangeEl.textContent = 'Last change: —';
    relayCard.appendChild(this._lastRelayChangeEl);

    row.appendChild(relayCard);

    // Right: protection ArcGauge (IDMT overcurrent accumulation)
    const arcCard = document.createElement('div');
    arcCard.className = 'p2-card';

    const arcHdr = document.createElement('div');
    arcHdr.className   = 'p2-card-hdr';
    arcHdr.textContent = 'Protection Curve — OC Accumulation';
    arcCard.appendChild(arcHdr);

    const arcWrap = document.createElement('div');
    arcWrap.style.cssText = [
      'display: flex',
      'justify-content: center',
      'align-items: center',
      'padding: 8px 0',
    ].join(';');

    this._arcGauge = new ArcGauge(arcWrap, {
      field:     'protection_idmt',
      min:       0,
      max:       100,
      unit:      '%',
      label:     'IDMT Accumulation',
      size:      140,
      colorRamp: [
        { threshold:  0, color: '--health-excellent' },
        { threshold: 50, color: '--state-warning'    },
        { threshold: 80, color: '--health-poor'      },
        { threshold: 95, color: '--state-fault'      },
      ],
    });
    this._components.push(this._arcGauge);
    arcCard.appendChild(arcWrap);

    // Accumulation note
    const arcNote = document.createElement('div');
    arcNote.style.cssText = [
      'font-size: 9px',
      'color: var(--text-faint)',
      'text-align: center',
      'margin-top: 4px',
    ].join(';');
    arcNote.textContent = 'Estimated — resets on relay open or NORMAL state';
    arcCard.appendChild(arcNote);

    row.appendChild(arcCard);
    parent.appendChild(row);
  }

  // ── Confirm dialog ────────────────────────────────────────────────────────

  _buildConfirmDialog(parent) {
    this._confirmOverlay = document.createElement('div');
    this._confirmOverlay.className = 'p2-confirm-overlay';
    this._confirmOverlay.setAttribute('data-p2-confirm', '');
    this._confirmOverlay.setAttribute('role', 'dialog');
    this._confirmOverlay.setAttribute('aria-modal', 'true');

    const dialog = document.createElement('div');
    dialog.className = 'p2-confirm-dialog';

    this._confirmTitle  = document.createElement('div');
    this._confirmTitle.className = 'p2-confirm-title';

    this._confirmBody   = document.createElement('div');
    this._confirmBody.className = 'p2-confirm-body';

    const actions = document.createElement('div');
    actions.className = 'p2-confirm-actions';

    this._confirmCancelBtn = document.createElement('button');
    this._confirmCancelBtn.className   = 'p2-confirm-cancel';
    this._confirmCancelBtn.textContent = 'Cancel';

    this._confirmOkBtn = document.createElement('button');
    this._confirmOkBtn.className   = 'p2-confirm-ok';
    this._confirmOkBtn.textContent = 'Confirm';

    actions.appendChild(this._confirmCancelBtn);
    actions.appendChild(this._confirmOkBtn);

    dialog.appendChild(this._confirmTitle);
    dialog.appendChild(this._confirmBody);
    dialog.appendChild(actions);
    this._confirmOverlay.appendChild(dialog);

    // Close on backdrop click
    this._confirmOverlay.addEventListener('click', (e) => {
      if (e.target === this._confirmOverlay) this._hideConfirmDialog();
    });

    // Keyboard: Escape cancels
    this._confirmKeyHandler = (e) => {
      if (e.key === 'Escape') this._hideConfirmDialog();
    };
    document.addEventListener('keydown', this._confirmKeyHandler);

    document.body.appendChild(this._confirmOverlay);
  }

  _showConfirmDialog(title, body, onConfirm) {
    this._confirmTitle.textContent = title;
    this._confirmBody.textContent  = body;

    // Wire up one-shot handlers
    const handleOk = () => {
      this._hideConfirmDialog();
      onConfirm();
    };
    const handleCancel = () => {
      this._hideConfirmDialog();
    };

    // Clone and replace buttons to remove old listeners
    const newOk     = this._confirmOkBtn.cloneNode(true);
    const newCancel = this._confirmCancelBtn.cloneNode(true);
    newOk.textContent     = 'Confirm';
    newCancel.textContent = 'Cancel';
    newOk.addEventListener('click',     handleOk,     { once: true });
    newCancel.addEventListener('click', handleCancel, { once: true });
    this._confirmOkBtn.replaceWith(newOk);
    this._confirmCancelBtn.replaceWith(newCancel);
    this._confirmOkBtn     = newOk;
    this._confirmCancelBtn = newCancel;

    this._confirmOverlay.classList.add('visible');
    this._confirmOkBtn.focus();
  }

  _hideConfirmDialog() {
    this._confirmOverlay?.classList.remove('visible');
  }

  // ── Live updaters ─────────────────────────────────────────────────────────

  _updateFsmDiagram(telemetryData) {
    const state = telemetryData?.state ?? 'BOOT';
    if (!this._fsmNodeEls) return;

    for (const node of FSM_NODES) {
      const { rect, text } = this._fsmNodeEls.get(node.id);
      const isActive = node.id === state;

      if (isActive) {
        rect.setAttribute('fill',   node.color);
        rect.setAttribute('stroke', node.color);
        rect.style.filter = `drop-shadow(0 0 6px ${node.color}80)`;
        text.setAttribute('fill', '#ffffff');
      } else {
        rect.setAttribute('fill',   node.muted);
        rect.setAttribute('stroke', node.muted);
        rect.style.filter = 'none';
        text.setAttribute('fill', 'var(--text-faint)');
      }
    }
  }

  _updateTripCounter(telemetryData) {
    const trips = telemetryData?.faults?.trip_count ?? 0;
    if (!this._tripSteps) return;

    const tripColors = ['#EF9F27', '#D85A30', '#E24B4A'];
    const { circles, lines } = this._tripSteps;

    for (let i = 0; i < 3; i++) {
      const filled = i < trips;
      const circle = circles[i];

      if (filled) {
        circle.style.background   = tripColors[i];
        circle.style.borderColor  = tripColors[i];
        circle.style.color        = '#000';
      } else {
        circle.style.background   = 'var(--bg-card-dark-2, var(--bg-card-dark))';
        circle.style.borderColor  = 'var(--border-subtle)';
        circle.style.color        = 'var(--text-faint)';
      }

      if (i < lines.length) {
        lines[i].style.background = i < trips - 1
          ? tripColors[i]
          : 'var(--border-subtle)';
      }
    }

    const remaining = 3 - trips;
    if (this._tripLabelEl) {
      if (trips === 0) {
        this._tripLabelEl.textContent = 'No trips — system healthy';
        this._tripLabelEl.style.color = 'var(--health-excellent)';
      } else if (trips >= 3) {
        this._tripLabelEl.textContent = 'Trip 3 of 3 — LOCKOUT triggered';
        this._tripLabelEl.style.color = 'var(--fault-active)';
      } else {
        this._tripLabelEl.textContent =
          `Trip ${trips} of 3 — ${remaining} remaining before lockout`;
        this._tripLabelEl.style.color = trips >= 2 ? 'var(--state-warning)' : 'var(--text-muted)';
      }
    }
  }

  _updateIdmt(telemetryData) {
    const pct    = _estimateIdmt(telemetryData);
    const pctPct = Math.round(pct * 100);

    if (this._idmtFillEl) {
      this._idmtFillEl.style.width      = `${pctPct}%`;
      this._idmtFillEl.style.background = _idmtColor(pct);
    }
    if (this._idmtTrippedEl) {
      this._idmtTrippedEl.style.display = pct >= 1.0 ? 'block' : 'none';
    }
  }

  _updateResetGuard(telemetryData) {
    if (!this._guardRows) return;

    const temp          = telemetryData?.t ?? 0;
    const sensorFault   = (telemetryData?.faults?.active ?? 'NONE') === 'SENSOR_FAIL';
    // Derive sensor present from sys health (proxy — no direct sensor_present in canonical)
    const sensorPresent = !sensorFault && (telemetryData?.sys?.health_status !== 'CRITICAL' || temp > 0);

    const guards = [
      { pass: temp < 85,      value: `${temp.toFixed(1)}°C`,  failMsg: '≥85°C' },
      { pass: sensorPresent,  value: sensorPresent ? 'OK' : 'DISCONNECTED', failMsg: 'Disconnected' },
      { pass: !sensorFault,   value: sensorFault ? 'SENSOR_FAIL' : 'Clear',  failMsg: 'Fault active' },
    ];

    let allPass = true;
    for (let i = 0; i < guards.length; i++) {
      const { pass, value } = guards[i];
      const { icon, val }   = this._guardRows[i];

      icon.textContent = pass ? '✓' : '✗';
      icon.style.color = pass ? 'var(--health-excellent)' : 'var(--fault-active)';
      val.textContent  = value;
      val.style.color  = pass ? 'var(--text-faint)' : 'var(--fault-active)';

      if (!pass) allPass = false;
    }

    this._guardsPassing = allPass;
    if (this._resetBtn) {
      this._resetBtn.disabled = !allPass;
      this._resetBtn.title    = allPass ? '' : 'One or more reset guards are not met';
    }
  }

  _updateRelaySection(telemetryData) {
    this._relayToggle?.update(telemetryData);
    this._updateActiveFaultCount(telemetryData);

    // Show override banner when relay state contradicts FSM recommendation
    const state    = telemetryData?.state ?? 'NORMAL';
    const relay    = telemetryData?.relay ?? true;
    const fsmWantsClosed = state !== 'FAULT' && state !== 'LOCKOUT';

    const override = fsmWantsClosed !== relay;
    if (this._relayBanner) {
      if (override && relay === false) {
        this._relayBanner.classList.add('visible');
      } else if (!override) {
        this._relayBanner.classList.remove('visible');
      }
    }
  }

  _updateLastRelayChange() {
    if (!this._lastRelayChangeEl || !this._relayChangeTs) return;
    const t = new Date(this._relayChangeTs);
    this._lastRelayChangeEl.textContent =
      `Last change: ${t.toLocaleTimeString()} — ${this._relayChangeReason}`;
  }

  // ── API actions ───────────────────────────────────────────────────────────

  async _doReset() {
    if (!this._guardsPassing) return;
    const btn = this._resetBtn;
    btn.disabled    = true;
    btn.textContent = '…';

    try {
      const res = await fetch('/api/reset', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ cmd: 'reset' }),
        signal:  AbortSignal.timeout(5000),
      });
      btn.textContent = res.ok ? '✓ RESET' : '✗ FAILED';
    } catch (err) {
      console.warn('[page2] reset error:', err.message);
      btn.textContent = '✗ ERROR';
    }

    setTimeout(() => {
      btn.textContent = 'RESET';
      btn.disabled    = !this._guardsPassing;
    }, 3000);
  }

  async _doReboot() {
    try {
      await fetch('/api/reset', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ cmd: 'reboot' }),
        signal:  AbortSignal.timeout(5000),
      });
    } catch (err) {
      console.warn('[page2] reboot error:', err.message);
    }
  }

  async _doPing(btn) {
    const original  = btn.textContent;
    btn.disabled    = true;
    btn.textContent = '…';

    try {
      const res = await fetch('/api/reset', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ cmd: 'ping' }),
        signal:  AbortSignal.timeout(3000),
      });
      btn.textContent = res.ok ? '✓ PONG' : '✗';
    } catch (_) {
      btn.textContent = '✗ TIMEOUT';
    }

    setTimeout(() => {
      btn.textContent = original;
      btn.disabled    = false;
    }, 2000);
  }
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function _statItem(label, value) {
  const el = document.createElement('div');
  el.style.cssText = [
    'display: flex',
    'flex-direction: column',
    'gap: 2px',
  ].join(';');

  const lbl = document.createElement('div');
  lbl.style.cssText = [
    'font-size: 9px',
    'color: var(--text-faint)',
    'text-transform: uppercase',
    'letter-spacing: 0.06em',
  ].join(';');
  lbl.textContent = label;

  const val = document.createElement('div');
  val.style.cssText = [
    'font-size: var(--text-label)',
    'color: var(--text-primary)',
    'font-variant-numeric: tabular-nums',
    'font-weight: 300',
  ].join(';');
  val.textContent = value;

  el.appendChild(lbl);
  el.appendChild(val);

  return { el, valueEl: val };
}

function _injectStyle(id, css) {
  if (document.getElementById(id)) return;
  const el    = document.createElement('style');
  el.id       = id;
  el.textContent = css;
  document.head.appendChild(el);
}
