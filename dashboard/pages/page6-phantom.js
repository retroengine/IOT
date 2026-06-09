/**
 * page6-phantom.js — Smart Grid Sentinel Page 6: Phantom Grid
 *
 * Integrated SIL Physics Engine control panel — replaces the standalone
 * tools/phantom_dashboard/index.html with a native dashboard page.
 *
 * Layout (top → bottom):
 *   Row 0 (header)     — page title + SIL badge + WS connection badge
 *   Row 1 (connection) — ESP32 IP + API key + Connect/Disconnect + Fetch State
 *   Row 2 (telemetry)  — 4 meters: Voltage, Current, FSM State, Active Fault
 *   Row 3 (scenarios)  — 8 SIL scenario buttons (grid)
 *   Row 4 (events)     — Voltage Sag sliders (left) | Voltage Swell sliders (right)
 *   Row 5 (custom)     — Custom V/I injection (left) | Scenario Cheat Sheet (right)
 *   Row 6 (system)     — System controls: Reset FSM, Reboot, Relay ON/OFF
 *   Row 7 (log)        — Status toast + scrollable command log
 *
 * Page lifecycle (DESIGN.md §17):
 *   mount(containerEl)    — build DOM, inject styles, set up event handlers
 *   update(telemetryData) — route live telemetry to meters (from main.js poller)
 *   destroy()             — close WS, remove styles, clean up
 *
 * WebSocket: Uses the global telemetryPoller context.
 * REST: Uses the global main.js fetch configuration.
 */

// ── Style injection ──────────────────────────────────────────────────────────
const STYLE_ID   = 'p6-page-styles';
const LAYOUT_CLS = 'p6-active';

const PAGE6_CSS = `
/* ─── Page 6 root layout ─── */
.p6-active {
  display: flex !important;
  flex-direction: column;
  gap: var(--space-md);
  padding: var(--space-lg) var(--space-xl);
  min-height: 0;
}

/* ─── Cards ─── */
.p6-card {
  background: var(--bg-card-dark);
  border-radius: var(--radius-md);
  padding: var(--space-md) var(--space-lg);
}
.p6-card-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-sm);
}
.p6-card-title {
  font-size: var(--text-micro);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 500;
}
.p6-card-badge {
  display: inline-flex;
  align-items: center;
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.04em;
  background: color-mix(in srgb, var(--state-boot) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--state-boot) 35%, transparent);
  color: var(--state-boot);
  transition: all 400ms ease;
}
.p6-card-badge.sil-on {
  background: color-mix(in srgb, var(--health-excellent) 15%, transparent);
  border-color: color-mix(in srgb, var(--health-excellent) 35%, transparent);
  color: var(--health-excellent);
}

/* ─── Page header ─── */
.p6-page-hdr {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding-bottom: var(--space-sm);
  border-bottom: 1px solid var(--border-subtle);
}
.p6-page-title {
  font-size: var(--text-section);
  font-weight: 300;
  color: var(--text-primary);
  letter-spacing: 0.02em;
  flex: 1;
}

/* ─── Connection badge ─── */
.p6-conn-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 14px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 500;
  background: color-mix(in srgb, var(--state-fault) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--state-fault) 30%, transparent);
  color: var(--state-fault);
  transition: all 400ms ease;
}
.p6-conn-badge.online {
  background: color-mix(in srgb, var(--health-excellent) 12%, transparent);
  border-color: color-mix(in srgb, var(--health-excellent) 30%, transparent);
  color: var(--health-excellent);
}
.p6-conn-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--state-fault);
  transition: all 400ms ease;
}
.p6-conn-badge.online .p6-conn-dot {
  background: var(--health-excellent);
  box-shadow: 0 0 8px color-mix(in srgb, var(--health-excellent) 60%, transparent);
  animation: p6-pulse-dot 2s ease-in-out infinite;
}
@keyframes p6-pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* ─── Connection form ─── */
.p6-conn-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-sm) var(--space-md);
}
.p6-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.p6-field-label {
  font-size: 9px;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.07em;
}
.p6-input {
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 8px 12px;
  outline: none;
  transition: border-color 200ms ease;
  width: 100%;
  box-sizing: border-box;
}
.p6-input:focus {
  border-color: color-mix(in srgb, var(--health-excellent) 60%, transparent);
}
.p6-input::placeholder { color: var(--text-faint); }
.p6-conn-actions {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-top: var(--space-sm);
  flex-wrap: wrap;
}

/* ─── Buttons ─── */
.p6-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 18px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.04em;
  cursor: pointer;
  border: none;
  transition: opacity 200ms ease, box-shadow 200ms ease, filter 200ms ease, transform 150ms ease;
  font-family: var(--font-primary);
}
.p6-btn:disabled { opacity: 0.35; cursor: not-allowed; filter: none; }
.p6-btn:not(:disabled):hover { filter: brightness(1.12); transform: translateY(-1px); }
.p6-btn:not(:disabled):active { transform: translateY(0); }
.p6-btn--connect {
  background: var(--health-excellent);
  color: #060f06;
}
.p6-btn--connect:not(:disabled):hover {
  box-shadow: 0 0 14px color-mix(in srgb, var(--health-excellent) 50%, transparent);
}
.p6-btn--slate {
  background: var(--bg-rec-item);
  border: 1px solid var(--border-subtle);
  color: var(--text-muted);
}
.p6-btn--red {
  background: var(--state-fault);
  color: var(--text-primary);
}
.p6-btn--amber {
  background: var(--state-warning);
  color: #060f06;
}
.p6-btn--violet {
  background: var(--state-boot);
  color: var(--text-primary);
}
.p6-btn--green {
  background: var(--health-excellent);
  color: #060f06;
}

/* ─── Telemetry meters ─── */
.p6-meter-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-sm);
}
.p6-meter {
  background: var(--bg-card-dark-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  text-align: center;
  position: relative;
  overflow: hidden;
}
.p6-meter::after {
  content: '';
  position: absolute;
  bottom: 0; left: 0;
  width: 100%; height: 3px;
}
.p6-meter.m-v::after { background: linear-gradient(90deg, var(--wave-voltage), var(--wave-current)); }
.p6-meter.m-i::after { background: linear-gradient(90deg, var(--health-excellent), var(--health-good)); }
.p6-meter.m-s::after { background: linear-gradient(90deg, var(--state-boot), var(--wave-current)); }
.p6-meter.m-f::after { background: linear-gradient(90deg, var(--state-fault), var(--fault-active)); }
.p6-meter-label {
  font-size: 9px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  margin-bottom: 6px;
}
.p6-meter-value {
  font-size: clamp(22px, 3vw, 32px);
  font-weight: 300;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  letter-spacing: -0.5px;
  color: var(--text-primary);
  transition: color 400ms ease;
}
.p6-meter.m-v .p6-meter-value { color: var(--wave-voltage); }
.p6-meter.m-i .p6-meter-value { color: var(--health-excellent); }
.p6-meter.m-s .p6-meter-value { color: var(--state-boot); font-size: clamp(14px, 2vw, 20px); }
.p6-meter.m-f .p6-meter-value { color: var(--text-faint); font-size: clamp(13px, 1.8vw, 18px); }
.p6-meter.m-f.active .p6-meter-value { color: var(--fault-active); }
.p6-meter-unit {
  font-size: 10px;
  font-weight: 400;
  color: var(--text-faint);
  margin-top: 4px;
}

/* ─── SIL Scenario Grid ─── */
.p6-sil-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
.p6-sil-btn {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 14px 8px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: rgba(255,255,255,0.03);
  color: var(--text-muted);
  font-family: var(--font-primary);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.03em;
  cursor: pointer;
  transition: background 200ms ease, border-color 250ms ease,
              color 200ms ease, transform 150ms ease, box-shadow 250ms ease;
  overflow: hidden;
}
.p6-sil-btn:hover {
  background: rgba(255,255,255,0.07);
  border-color: rgba(255,255,255,0.18);
  color: var(--text-primary);
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(0,0,0,0.3);
}
.p6-sil-btn:active {
  transform: translateY(0);
  box-shadow: none;
}
.p6-sil-btn .sil-icon {
  font-size: 20px;
  line-height: 1;
}
.p6-sil-btn.sil-active {
  border-color: var(--health-excellent);
  color: var(--health-excellent);
  background: color-mix(in srgb, var(--health-excellent) 10%, transparent);
  box-shadow: 0 0 12px color-mix(in srgb, var(--health-excellent) 20%, transparent);
}
.p6-sil-status {
  font-size: 10px;
  color: var(--text-faint);
  text-align: center;
  margin-top: var(--space-xs);
  min-height: 16px;
  font-family: var(--font-mono);
}

/* ─── Voltage Events Grid ─── */
.p6-events-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-md);
}
.p6-event-col {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.p6-event-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.p6-range-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.p6-range-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.p6-range-val {
  font-weight: 600;
  font-size: 12px;
  color: var(--health-excellent);
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
}
input[type="range"].p6-range {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 5px;
  border-radius: 3px;
  background: var(--progress-track);
  border: none;
  padding: 0;
  outline: none;
}
input[type="range"].p6-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--health-excellent);
  cursor: pointer;
  box-shadow: 0 0 8px color-mix(in srgb, var(--health-excellent) 50%, transparent);
  transition: transform 150ms ease;
}
input[type="range"].p6-range::-webkit-slider-thumb:hover {
  transform: scale(1.2);
}

/* ─── Bottom grid: custom inject + cheat sheet ─── */
.p6-bottom-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-md);
}
.p6-inject-fields {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}
.p6-cheat-grid {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  font-size: 12px;
}
.p6-cheat-label {
  font-weight: 600;
}
.p6-cheat-value {
  font-family: var(--font-mono);
  color: var(--text-muted);
  text-align: right;
}

/* ─── System Controls ─── */
.p6-sys-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}

/* ─── Toast + Log ─── */
.p6-toast {
  min-height: 32px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
  background: var(--bg-card-dark-2);
  border: 1px solid var(--border-subtle);
  color: var(--text-muted);
  transition: all 300ms ease;
}
.p6-toast.ok {
  color: var(--health-excellent);
  border-color: color-mix(in srgb, var(--health-excellent) 25%, transparent);
  background: color-mix(in srgb, var(--health-excellent) 6%, transparent);
}
.p6-toast.err {
  color: var(--state-fault);
  border-color: color-mix(in srgb, var(--state-fault) 25%, transparent);
  background: color-mix(in srgb, var(--state-fault) 6%, transparent);
}
.p6-toast.warn {
  color: var(--state-warning);
  border-color: color-mix(in srgb, var(--state-warning) 25%, transparent);
  background: color-mix(in srgb, var(--state-warning) 6%, transparent);
}
.p6-log-box {
  background: var(--bg-card-dark-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  max-height: 180px;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-muted);
}
.p6-log-box::-webkit-scrollbar { width: 4px; }
.p6-log-box::-webkit-scrollbar-thumb {
  background: var(--text-faint);
  border-radius: 2px;
}
.p6-log-entry { white-space: nowrap; }
.p6-log-ts { color: var(--text-faint); }
.p6-log-ok { color: var(--health-excellent); }
.p6-log-err { color: var(--state-fault); }

/* ─── Responsive ─── */
@media (max-width: 900px) {
  .p6-meter-row { grid-template-columns: repeat(2, 1fr); }
  .p6-sil-grid { grid-template-columns: repeat(2, 1fr); }
  .p6-events-grid { grid-template-columns: 1fr; }
  .p6-bottom-grid { grid-template-columns: 1fr; }
  .p6-sys-grid { grid-template-columns: repeat(2, 1fr); }
  .p6-conn-form { grid-template-columns: 1fr; }
}
`;

// ── FSM + Fault Lookup ────────────────────────────────────────────────────────
const FSM_STATES  = ['BOOT','NORMAL','WARNING','FAULT','RECOVERY','LOCKOUT'];
const FAULT_NAMES = ['NONE','OV','UV','OC','THERMAL','SC','SENSOR','LOCKED_ROTOR','MECH_STALL'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function _el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls)  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function _injectStyle(id, css) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

// ══════════════════════════════════════════════════════════════════════════════
// Page6Phantom
// ══════════════════════════════════════════════════════════════════════════════

export class Page6Phantom {

  constructor() {
    this._container   = null;
    this._ws          = null;
    this._reconnTimer = null;
    this._reconnDelay = 2000;
    this._intentionalClose = false;

    // DOM refs
    this._silBadge    = null;
    this._toast       = null;
    this._logBox      = null;

    // Meters
    this._dispV       = null;
    this._dispI       = null;
    this._dispState   = null;
    this._dispFault   = null;
    this._meterFault  = null;

    // Sliders
    this._sliders     = {};

    // SIL
    this._silButtons  = [];
    this._silStatusEl = null;
    this._silStatusTimer = null;
  }

  // ── mount ──────────────────────────────────────────────────────────────────

  mount(containerEl) {
    this._container = containerEl;
    _injectStyle(STYLE_ID, PAGE6_CSS);

    containerEl.innerHTML = '';
    containerEl.classList.add(LAYOUT_CLS);

    this._buildPageHeader(containerEl);
    this._buildTelemetryCard(containerEl);
    this._buildScenariosCard(containerEl);
    this._buildVoltageEventsCard(containerEl);
    this._buildBottomGrid(containerEl);
    this._buildSystemControls(containerEl);
    this._buildLogCard(containerEl);
  }

  // ── update (from main.js telemetry poller) ─────────────────────────────────

  update(telemetryData) {
    if (!telemetryData) return;
    this._updateMetersFromTelemetry(telemetryData);
  }

  // ── destroy ────────────────────────────────────────────────────────────────

  destroy() {
    clearTimeout(this._silStatusTimer);

    // Clean up DOM
    this._container?.classList.remove(LAYOUT_CLS);
    if (this._container) this._container.innerHTML = '';
    document.getElementById(STYLE_ID)?.remove();

    this._container = null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Row 0 — Page Header
  // ══════════════════════════════════════════════════════════════════════════

  _buildPageHeader(parent) {
    const hdr = _el('div', 'p6-page-hdr');

    hdr.appendChild(_el('h2', 'p6-page-title', 'Phantom Grid'));

    this._silBadge = _el('span', 'p6-card-badge', 'SIL Inactive');
    hdr.appendChild(this._silBadge);

    this._connBadge = _el('div', 'p6-conn-badge');
    const dot  = _el('div', 'p6-conn-dot');
    this._connText = _el('span', '', 'Offline');
    this._connBadge.appendChild(dot);
    this._connBadge.appendChild(this._connText);
    hdr.appendChild(this._connBadge);

    parent.appendChild(hdr);
  }



  // ══════════════════════════════════════════════════════════════════════════
  // Row 2 — Live Telemetry Meters
  // ══════════════════════════════════════════════════════════════════════════

  _buildTelemetryCard(parent) {
    const card = _el('div', 'p6-card');

    const hdr = _el('div', 'p6-card-hdr');
    hdr.appendChild(_el('span', 'p6-card-title', 'Live Telemetry'));
    card.appendChild(hdr);

    const row = _el('div', 'p6-meter-row');

    // Voltage
    const mV = this._buildMeter('Voltage RMS', '---', 'Volts', 'm-v');
    this._dispV = mV.valueEl;
    row.appendChild(mV.el);

    // Current
    const mI = this._buildMeter('Current RMS', '---', 'Amps', 'm-i');
    this._dispI = mI.valueEl;
    row.appendChild(mI.el);

    // FSM State
    const mS = this._buildMeter('FSM State', '—', '\u00A0', 'm-s');
    this._dispState = mS.valueEl;
    this._dispStateSub = mS.unitEl;
    row.appendChild(mS.el);

    // Active Fault
    const mF = this._buildMeter('Active Fault', 'CLEAR', '\u00A0', 'm-f');
    this._dispFault = mF.valueEl;
    this._meterFault = mF.el;
    row.appendChild(mF.el);

    card.appendChild(row);
    parent.appendChild(card);
  }

  _buildMeter(label, initValue, unit, cls) {
    const el = _el('div', `p6-meter ${cls}`);
    el.appendChild(_el('div', 'p6-meter-label', label));
    const valueEl = _el('div', 'p6-meter-value', initValue);
    el.appendChild(valueEl);
    const unitEl = _el('div', 'p6-meter-unit', unit);
    el.appendChild(unitEl);
    return { el, valueEl, unitEl };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Row 3 — Grid Scenarios
  // ══════════════════════════════════════════════════════════════════════════

  _buildScenariosCard(parent) {
    const card = _el('div', 'p6-card');

    const hdr = _el('div', 'p6-card-hdr');
    hdr.appendChild(_el('span', 'p6-card-title', 'Grid Scenarios — SIL Injection'));
    card.appendChild(hdr);

    const grid = _el('div', 'p6-sil-grid');

    const scenarios = [
      { icon: '⚡', label: 'Normal Grid',   cmd: 'normal_grid' },
      { icon: '🏭', label: 'Motor Start',   cmd: 'motor_start' },
      { icon: '⏹',  label: 'Motor Stop',    cmd: 'motor_stop'  },
      { icon: '💡', label: 'Flicker ON',    cmd: 'flicker_on'  },
      { icon: '🔇', label: 'Flicker OFF',   cmd: 'flicker_off' },
      { icon: '📉', label: 'Voltage Sag',   cmd: 'sag', params: { depth: 0.5, duration: 2.0 } },
      { icon: '📈', label: 'Voltage Swell', cmd: 'swell', params: { height: 0.15, duration: 2.0 } },
      { icon: '🛑', label: 'Disable SIL',   cmd: 'disable' },
    ];

    this._silButtons = [];

    for (const s of scenarios) {
      const btn = _el('button', 'p6-sil-btn');
      btn.setAttribute('data-sil-cmd', s.cmd);
      btn.innerHTML = `<span class="sil-icon">${s.icon}</span>${s.label}`;

      btn.addEventListener('click', async () => {
        const body = { cmd: s.cmd };
        if (s.params) Object.assign(body, s.params);

        btn.style.opacity = '0.5';
        btn.style.pointerEvents = 'none';
        this._setSilStatus(`Sending ${s.label}…`, 'var(--text-muted)');

        try {
          const resp = await this._apiPost('/api/inject', body);
          if (resp && resp._ok) {
            this._setSilStatus(`✓ ${resp.status || s.label + ' applied'}`, 'var(--health-excellent)');
            this._silButtons.forEach(b => b.classList.remove('sil-active'));
            if (s.cmd !== 'disable') btn.classList.add('sil-active');
            this._setSilActive(s.cmd !== 'disable');
          } else {
            this._setSilStatus(`✗ ${resp?.error || 'Request failed'}`, 'var(--fault-active)');
          }
        } catch (err) {
          this._setSilStatus(`✗ ${err.message}`, 'var(--fault-active)');
        } finally {
          btn.style.opacity = '';
          btn.style.pointerEvents = '';
        }
      });

      grid.appendChild(btn);
      this._silButtons.push(btn);
    }

    card.appendChild(grid);

    this._silStatusEl = _el('div', 'p6-sil-status', 'Ready');
    card.appendChild(this._silStatusEl);

    parent.appendChild(card);
  }

  _setSilStatus(msg, color) {
    if (!this._silStatusEl) return;
    this._silStatusEl.textContent = msg;
    this._silStatusEl.style.color = color || '';
    clearTimeout(this._silStatusTimer);
    this._silStatusTimer = setTimeout(() => {
      if (this._silStatusEl) {
        this._silStatusEl.textContent = 'Ready';
        this._silStatusEl.style.color = 'var(--text-faint)';
      }
    }, 4000);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Row 4 — Voltage Sag / Swell Events
  // ══════════════════════════════════════════════════════════════════════════

  _buildVoltageEventsCard(parent) {
    const card = _el('div', 'p6-card');

    const hdr = _el('div', 'p6-card-hdr');
    hdr.appendChild(_el('span', 'p6-card-title', 'Voltage Events'));
    card.appendChild(hdr);

    const grid = _el('div', 'p6-events-grid');

    // Sag column
    const sagCol = _el('div', 'p6-event-col');
    const sagTitle = _el('div', 'p6-event-title', '⬇ Voltage Sag');
    sagTitle.style.color = 'var(--state-fault)';
    sagCol.appendChild(sagTitle);

    this._sliders.sagDepth = this._buildRangeSlider(sagCol, 'Depth', 0.1, 0.9, 0.05, 0.3, 2);
    this._sliders.sagDur   = this._buildRangeSlider(sagCol, 'Duration (s)', 0.1, 10, 0.1, 2.0, 1);

    const sagBtn = _el('button', 'p6-btn p6-btn--red', '⬇ Trigger Sag');
    sagBtn.style.width = '100%';
    sagBtn.addEventListener('click', () => {
      this._apiPost('/api/inject', {
        cmd: 'sag',
        depth: parseFloat(this._sliders.sagDepth.input.value),
        duration: parseFloat(this._sliders.sagDur.input.value),
      });
    });
    sagCol.appendChild(sagBtn);

    // Swell column
    const swellCol = _el('div', 'p6-event-col');
    const swellTitle = _el('div', 'p6-event-title', '⬆ Voltage Swell');
    swellTitle.style.color = 'var(--state-boot)';
    swellCol.appendChild(swellTitle);

    this._sliders.swellHt  = this._buildRangeSlider(swellCol, 'Height', 0.1, 0.8, 0.05, 0.2, 2);
    this._sliders.swellDur = this._buildRangeSlider(swellCol, 'Duration (s)', 0.1, 10, 0.1, 2.0, 1);

    const swellBtn = _el('button', 'p6-btn p6-btn--violet', '⬆ Trigger Swell');
    swellBtn.style.width = '100%';
    swellBtn.addEventListener('click', () => {
      this._apiPost('/api/inject', {
        cmd: 'swell',
        height: parseFloat(this._sliders.swellHt.input.value),
        duration: parseFloat(this._sliders.swellDur.input.value),
      });
    });
    swellCol.appendChild(swellBtn);

    grid.appendChild(sagCol);
    grid.appendChild(swellCol);
    card.appendChild(grid);
    parent.appendChild(card);
  }

  _buildRangeSlider(parent, label, min, max, step, value, decimals) {
    const group = _el('div', 'p6-range-group');
    const header = _el('div', 'p6-range-header');
    header.appendChild(_el('span', 'p6-field-label', label));
    const valSpan = _el('span', 'p6-range-val', parseFloat(value).toFixed(decimals));
    header.appendChild(valSpan);
    group.appendChild(header);

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'p6-range';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = value;
    input.addEventListener('input', () => {
      valSpan.textContent = parseFloat(input.value).toFixed(decimals);
    });
    group.appendChild(input);
    parent.appendChild(group);

    return { input, valSpan };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Row 5 — Custom Injection + Cheat Sheet
  // ══════════════════════════════════════════════════════════════════════════

  _buildBottomGrid(parent) {
    const grid = _el('div', 'p6-bottom-grid');

    // Custom inject card
    const injectCard = _el('div', 'p6-card');
    const injectHdr = _el('div', 'p6-card-hdr');
    injectHdr.appendChild(_el('span', 'p6-card-title', 'Custom Injection'));
    const manualBadge = _el('span', 'p6-card-badge', 'Manual');
    manualBadge.style.background = 'color-mix(in srgb, var(--state-warning) 15%, transparent)';
    manualBadge.style.borderColor = 'color-mix(in srgb, var(--state-warning) 35%, transparent)';
    manualBadge.style.color = 'var(--state-warning)';
    injectHdr.appendChild(manualBadge);
    injectCard.appendChild(injectHdr);

    const fields = _el('div', 'p6-inject-fields');

    // Voltage input
    const vField = _el('div', 'p6-field');
    vField.appendChild(_el('label', 'p6-field-label', 'Voltage (V RMS)'));
    this._customV = _el('input', 'p6-input');
    this._customV.type = 'number';
    this._customV.value = '230';
    this._customV.min = '0';
    this._customV.max = '400';
    this._customV.step = '1';
    vField.appendChild(this._customV);
    fields.appendChild(vField);

    // Current input
    const iField = _el('div', 'p6-field');
    iField.appendChild(_el('label', 'p6-field-label', 'Current (A RMS)'));
    this._customI = _el('input', 'p6-input');
    this._customI.type = 'number';
    this._customI.value = '5';
    this._customI.min = '0';
    this._customI.max = '30';
    this._customI.step = '0.5';
    iField.appendChild(this._customI);
    fields.appendChild(iField);

    // Duration input
    const durField = _el('div', 'p6-field');
    durField.appendChild(_el('label', 'p6-field-label', 'Hold Duration (s)'));
    this._customDur = _el('input', 'p6-input');
    this._customDur.type = 'number';
    this._customDur.value = '10';
    this._customDur.min = '1';
    this._customDur.max = '300';
    this._customDur.step = '1';
    durField.appendChild(this._customDur);
    fields.appendChild(durField);

    const injectBtn = _el('button', 'p6-btn p6-btn--amber', '🎯 Inject Custom Load');
    injectBtn.style.width = '100%';
    injectBtn.addEventListener('click', () => this._doCustomInject());
    fields.appendChild(injectBtn);

    const hint = _el('div', '', 'Sets the SIL physics engine to output the specified steady-state V/I for the given duration.');
    hint.style.cssText = 'font-size:10px;color:var(--text-faint);line-height:1.5;margin-top:4px;';
    fields.appendChild(hint);

    injectCard.appendChild(fields);
    grid.appendChild(injectCard);

    // Cheat sheet card
    const cheatCard = _el('div', 'p6-card');
    const cheatHdr = _el('div', 'p6-card-hdr');
    cheatHdr.appendChild(_el('span', 'p6-card-title', 'Scenario Cheat Sheet'));
    cheatCard.appendChild(cheatHdr);

    const cheatGrid = _el('div', 'p6-cheat-grid');

    const cheatData = [
      { label: '⚡ Normal Grid',               value: '230 V | 5.0 A',  color: 'var(--health-excellent)' },
      { label: '🏭 Motor Start (Inrush)',       value: '230 V | 90 A',   color: 'var(--state-fault)' },
      { label: '⏹ Motor Running',              value: '230 V | 10.0 A', color: 'var(--text-primary)' },
      { label: '🛑 Zero Load / SIL Off',        value: '0 V | 0.0 A',   color: 'var(--state-boot)' },
    ];

    for (const item of cheatData) {
      const labelEl = _el('div', 'p6-cheat-label', item.label);
      labelEl.style.color = item.color;
      cheatGrid.appendChild(labelEl);
      cheatGrid.appendChild(_el('div', 'p6-cheat-value', item.value));
    }

    cheatCard.appendChild(cheatGrid);
    grid.appendChild(cheatCard);

    parent.appendChild(grid);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Row 6 — System Controls
  // ══════════════════════════════════════════════════════════════════════════

  _buildSystemControls(parent) {
    const card = _el('div', 'p6-card');

    const hdr = _el('div', 'p6-card-hdr');
    hdr.appendChild(_el('span', 'p6-card-title', 'System Controls'));
    card.appendChild(hdr);

    const grid = _el('div', 'p6-sys-grid');

    const controls = [
      { label: '🔄 Reset FSM',  cls: 'p6-btn--violet', action: () => this._apiPost('/api/reset',  { cmd: 'reset' }) },
      { label: '♻️ Reboot ESP', cls: 'p6-btn--red',    action: () => { if (confirm('Reboot the ESP32?')) this._apiPost('/api/reboot', {}); } },
      { label: '🟢 Relay ON',   cls: 'p6-btn--green',  action: () => this._apiPost('/api/relay',  { state: true }) },
      { label: '🔴 Relay OFF',  cls: 'p6-btn--slate',  action: () => this._apiPost('/api/relay',  { state: false }) },
    ];

    for (const c of controls) {
      const btn = _el('button', `p6-btn ${c.cls}`, c.label);
      btn.addEventListener('click', c.action);
      grid.appendChild(btn);
    }

    card.appendChild(grid);
    parent.appendChild(card);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Row 7 — Command Log
  // ══════════════════════════════════════════════════════════════════════════

  _buildLogCard(parent) {
    const card = _el('div', 'p6-card');

    const hdr = _el('div', 'p6-card-hdr');
    hdr.appendChild(_el('span', 'p6-card-title', 'Command Log'));
    const clearBtn = _el('button', 'p6-btn p6-btn--slate', 'Clear');
    clearBtn.style.cssText = 'padding:4px 12px;font-size:10px;';
    clearBtn.addEventListener('click', () => {
      if (this._logBox) {
        this._logBox.innerHTML = '';
        this._log('Log cleared');
      }
    });
    hdr.appendChild(clearBtn);
    card.appendChild(hdr);

    this._toast = _el('div', 'p6-toast', 'Ready — enter IP and connect.');
    card.appendChild(this._toast);

    this._logBox = _el('div', 'p6-log-box');
    this._log('Phantom Grid initialized');
    card.appendChild(this._logBox);

    parent.appendChild(card);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Logging & Toast
  // ══════════════════════════════════════════════════════════════════════════

  _log(msg, cls = '') {
    if (!this._logBox) return;
    const now = new Date().toLocaleTimeString('en-GB');
    const div = document.createElement('div');
    div.className = 'p6-log-entry';
    div.innerHTML = `<span class="p6-log-ts">[${now}]</span> <span class="${cls}">${msg}</span>`;
    this._logBox.appendChild(div);
    this._logBox.scrollTop = this._logBox.scrollHeight;
  }

  _showToast(msg, type = '') {
    if (!this._toast) return;
    this._toast.textContent = msg;
    this._toast.className = 'p6-toast' + (type ? ' ' + type : '');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // API Helpers (direct to ESP32 IP)
  // ══════════════════════════════════════════════════════════════════════════

  async _apiPost(endpoint, body) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      json._ok = res.ok;

      if (res.ok) {
        const msg = json.status || json.ok || 'OK';
        this._showToast(msg, 'ok');
        this._log(`POST ${endpoint} → ${msg}`, 'p6-log-ok');
      } else {
        const msg = json.error || `HTTP ${res.status}`;
        this._showToast(msg, 'err');
        this._log(`POST ${endpoint} → ${msg}`, 'p6-log-err');
      }
      return json;
    } catch (err) {
      this._showToast('Request failed: ' + err.message, 'err');
      this._log(`POST ${endpoint} FAILED: ${err.message}`, 'p6-log-err');
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Custom V/I Injection
  // ══════════════════════════════════════════════════════════════════════════

  async _doCustomInject() {
    const targetV = parseFloat(this._customV?.value);
    const targetI = parseFloat(this._customI?.value);
    const dur     = parseFloat(this._customDur?.value);

    if (isNaN(targetV) || isNaN(targetI) || isNaN(dur)) {
      this._showToast('Enter valid numbers', 'warn');
      return;
    }

    this._log(`Injecting custom load: ${targetV}V, ${targetI}A for ${dur}s`, 'p6-log-ok');
    await this._apiPost('/api/inject', { voltage: targetV, current: targetI });
    this._showToast(`Injecting ${targetV}V / ${targetI}A for ${dur}s`, 'ok');

    // Revert to baseline after duration
    setTimeout(() => {
      this._log('Reverting custom load back to baseline...', 'p6-log-ok');
      this._apiPost('/api/inject', { voltage: 230.0, current: 5.0 });
    }, dur * 1000);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WebSocket Connection
  // ══════════════════════════════════════════════════════════════════════════



  _setSilActive(active) {
    if (!this._silBadge) return;
    if (active) {
      this._silBadge.textContent = 'SIL Active';
      this._silBadge.classList.add('sil-on');
    } else {
      this._silBadge.textContent = 'SIL Inactive';
      this._silBadge.classList.remove('sil-on');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Update meters from main telemetry poller (when no direct WS)
  // ══════════════════════════════════════════════════════════════════════════

  _updateMetersFromTelemetry(data) {
    if (!data) return;

    // Voltage — Prioritise window extremes to capture transients
    let v = data.v;
    if (data.v_min !== undefined && data.v_max !== undefined) {
      // Determine if we should show the peak or the average
      // If there's a significant deviation in the window, show the peak
      const dev_min = Math.abs(data.v - data.v_min);
      const dev_max = Math.abs(data.v - data.v_max);
      if (dev_min > 5 || dev_max > 5) {
        v = (dev_min > dev_max) ? data.v_min : data.v_max; 
      }
    }
    if (v != null && this._dispV) this._dispV.textContent = parseFloat(v).toFixed(1);

    // Current — Show window peak
    let i = data.i;
    if (data.i_max !== undefined && data.i_max > data.i * 1.1) {
      i = data.i_max;
    }
    if (i != null && this._dispI) this._dispI.textContent = parseFloat(i).toFixed(2);

    // FSM State
    const state = data.state ?? null;
    if (state != null && this._dispState) this._dispState.textContent = state;

    // Fault
    const fault = data.faults?.active ?? data.fault ?? data.active_fault ?? null;
    if (fault != null && this._dispFault) {
      this._dispFault.textContent = (fault === 'NONE' || fault === 0) ? 'CLEAR' : fault;
      if (this._meterFault) this._meterFault.classList.toggle('active', fault !== 'NONE' && fault !== 0);
    }
  }
}
