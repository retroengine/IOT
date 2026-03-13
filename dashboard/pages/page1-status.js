/**
 * page1-status.js — Smart Grid Sentinel Page 1: Status
 * Phase 4 deliverable. DESIGN.md §4, §5, §8, §17.
 *
 * Primary live-monitoring view. All five zones populated with live telemetry.
 *
 * Zone map:
 *   Zone 1  (#zone-system-status)  — FSM badge · uptime · health · relay · WiFi
 *   Zone 2  (#zone-main-metrics)   — Waveform · hero numbers · PF gauge · frequency
 *   Zone 3A (#zone-charts)         — Temperature / Frequency / PF sparklines
 *   Zone 3B (#zone-health-grid)    — Hex health cells · overall ArcGauge · signal paths
 *   Zone 4  (#zone-sidebar)        — Energy flow map · relay toggle · kWh · fault list
 *
 * Page lifecycle (DESIGN.md §17):
 *   mount(containerEl)    — instantiate components, inject styles
 *   update(telemetryData) — route data at appropriate Hz per field group
 *   destroy()             — destroy all components, clean up DOM / styles
 *
 * Update rate gates (DESIGN.md §7 Data Update Frequency):
 *   always    — hero numbers (direct DOM), waveform, arc gauges, energy flow, relay
 *   1 Hz      — sparklines (canvas redraw)
 *   0.5 Hz    — state badge, hex health cells, fault indicators
 */

import { ArcGauge }       from '../components/arcGauge.js';
import { WaveformCard }   from '../components/waveformCard.js';
import { Sparkline }      from '../components/sparkline.js';
import { HexHealthCell }  from '../components/hexHealthCell.js';
import { StateBadge }     from '../components/stateBadge.js';
import { RelayToggle }    from '../components/relayToggle.js';
import { EnergyFlowMap }  from '../components/energyFlowMap.js';
import { FaultIndicator } from '../components/faultIndicator.js';
import { SignalPath }      from '../components/signalPath.js';
import { setupCanvas, clearCanvas, drawSparkline }  from '../rendering/canvasEngine.js';
import { createOverlaySvg }                         from '../rendering/svgEngine.js';

// ── Injected style sheet ID (tracked for removal in destroy()) ────────────
const STYLE_ID   = 'p1-page-styles';
const LAYOUT_CLS = 'p1-active';

// ── Page 1 CSS ────────────────────────────────────────────────────────────
// All values reference tokens.css variables — zero hardcoded hex.
const PAGE1_CSS = `
/* ─── Page 1 Status: two-column grid layout ─── */
.p1-active {
  display: grid !important;
  grid-template-columns: 1fr 320px;
  grid-template-areas:
    "z2  z3b"
    "z3a z4";
  gap: var(--space-md);
  padding: var(--space-lg) var(--space-xl);
}
.p1-active #zone-main-metrics { grid-area: z2;  min-height: 0; padding: 0; }
.p1-active #zone-charts       { grid-area: z3a; min-height: 0; padding: 0; }
.p1-active #zone-health-grid  { grid-area: z3b; min-height: 0; padding: 0; }
.p1-active #zone-sidebar      { grid-area: z4;  min-height: 0; padding: 0; }

/* ─── Card base ─── */
.p1-card {
  background: var(--bg-card-dark);
  border-radius: var(--radius-md);
  padding: var(--space-md);
}
.p1-card-hdr {
  font-size: var(--text-micro);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: var(--space-sm);
}

/* ─── Zone 1: status bar items ─── */
.p1-z1-uptime {
  font-family: var(--font-mono);
  font-size: var(--text-label);
  color: var(--text-muted);
  letter-spacing: 0.04em;
  white-space: nowrap;
}
.p1-z1-health {
  display: flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}
.p1-z1-health-score {
  font-size: 20px;
  font-weight: 300;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  transition: color 600ms ease-in-out;
}
.p1-z1-health-lbl {
  font-size: var(--text-micro);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.p1-z1-relay {
  display: flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}
.p1-z1-relay-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  transition: background-color 300ms ease;
}
.p1-z1-relay-lbl {
  font-size: var(--text-micro);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.p1-z1-relay-state {
  font-size: var(--text-micro);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  transition: color 300ms ease;
}
.p1-z1-wifi {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 14px;
  flex-shrink: 0;
}
.p1-z1-wifi-bar {
  width: 4px;
  border-radius: 1px 1px 0 0;
  transition: background-color 300ms ease;
}
.p1-z1-sep {
  width: 1px;
  height: 20px;
  background: var(--border-subtle);
  flex-shrink: 0;
}
.p1-z1-spacer { flex: 1 1 0; }
.p1-z1-conn {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--text-micro);
  color: var(--text-faint);
  white-space: nowrap;
}
.p1-z1-conn-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  transition: background-color 300ms ease;
}

/* ─── Zone 2: Main Metrics ─── */
.p1-z2-grid {
  display: grid;
  grid-template-columns: 1fr 172px;
  grid-template-rows: 150px auto;
  gap: var(--space-sm);
}
.p1-z2-waveform {
  grid-column: 1;
  grid-row: 1;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--bg-card-dark);
}
.p1-z2-right {
  grid-column: 2;
  grid-row: 1 / 3;
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}
.p1-z2-heroes {
  grid-column: 1;
  grid-row: 2;
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: var(--space-sm);
}
.p1-hero {
  background: var(--bg-card-dark);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.p1-hero-lbl {
  font-size: var(--text-micro);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.p1-hero-val {
  font-size: clamp(22px, 3vw, 38px);
  font-family: var(--font-mono);
  font-weight: 300;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  line-height: 1;
  letter-spacing: -0.02em;
}
.p1-hero-unit {
  font-size: var(--text-label);
  color: var(--text-muted);
}
.p1-freq-card {
  background: var(--bg-card-dark);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  flex-shrink: 0;
}
.p1-freq-lbl {
  display: block;
  font-size: var(--text-micro);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 4px;
}
.p1-freq-row {
  display: flex;
  align-items: baseline;
  gap: 4px;
  margin-bottom: 6px;
}
.p1-freq-val {
  font-size: 20px;
  font-family: var(--font-mono);
  font-weight: 300;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.p1-freq-hz {
  font-size: var(--text-label);
  color: var(--text-muted);
}
.p1-freq-tol {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-micro);
  color: var(--text-faint);
}
.p1-freq-tol-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex-shrink: 0;
  transition: background-color 300ms ease;
}
.p1-pf-wrap {
  flex: 1 1 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-card-dark);
  border-radius: var(--radius-md);
  overflow: hidden;
}

/* ─── Zone 3A: Charts ─── */
.p1-z3a-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: var(--space-sm);
}
.p1-spark-cell {
  background: var(--bg-card-dark);
  border-radius: var(--radius-md);
  padding: var(--space-sm) var(--space-md);
}
.p1-spark-hdr {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 4px;
}
.p1-spark-lbl {
  font-size: var(--text-micro);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.p1-spark-val {
  font-size: var(--text-label);
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
}
.p1-spark-unit {
  display: block;
  font-size: 10px;
  color: var(--text-faint);
  margin-top: 3px;
}

/* ─── Zone 3B: Health Grid ─── */
.p1-z3b-inner {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  position: relative;
}
.p1-z3b-top {
  background: var(--bg-card-dark);
  border-radius: var(--radius-md);
  padding: var(--space-sm);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.p1-z3b-gauge-hdr {
  font-size: var(--text-micro);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  align-self: flex-start;
  width: 100%;
}
.p1-z3b-gauge-wrap {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
}
.p1-hex-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  justify-items: center;
}
.p1-hex-cell {
  width: 100%;
  display: flex;
  justify-content: center;
}

/* ─── Zone 4: Sidebar ─── */
.p1-z4-stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}
.p1-relay-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-sm);
  align-items: start;
}
.p1-relay-card {
  background: var(--bg-card-dark);
  border-radius: var(--radius-md);
  padding: var(--space-sm) var(--space-md);
}
.p1-energy-card {
  background: var(--bg-card-green);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.p1-energy-lbl {
  font-size: var(--text-micro);
  color: var(--health-excellent);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  opacity: 0.8;
}
.p1-energy-val {
  font-size: clamp(18px, 2vw, 24px);
  font-weight: 300;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
  line-height: 1.1;
}
.p1-energy-unit {
  font-size: var(--text-label);
  color: var(--health-excellent);
  opacity: 0.7;
}
.p1-fault-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px;
}

/* ─── Mobile: single-column stack ─── */
@media (max-width: 767px) {
  .p1-active {
    display: flex !important;
    flex-direction: column;
    padding: var(--space-sm);
  }
  .p1-z2-grid {
    grid-template-columns: 1fr;
    grid-template-rows: auto auto;
  }
  .p1-z2-right { grid-column: 1; grid-row: auto; flex-direction: row; flex-wrap: wrap; }
  .p1-z2-heroes { grid-column: 1; grid-row: auto; }
  .p1-z3a-grid { grid-template-columns: 1fr; }
  .p1-hex-grid  { grid-template-columns: repeat(2, 1fr); }
  .p1-relay-row { grid-template-columns: 1fr; }
}
`;

// ══════════════════════════════════════════════════════════════════════════
// _MiniSparkline — internal-only sparkline for fields not tracked by
// telemetryBuffer (freq, pf). Maintains its own 60-value ring buffer.
// Uses canvasEngine for rendering to comply with the zero-ctx-direct rule.
// ══════════════════════════════════════════════════════════════════════════

class _MiniSparkline {
  /**
   * @param {HTMLElement} containerEl
   * @param {object}      opts
   * @param {string}      opts.label   — display label
   * @param {string}      opts.unit    — unit string (e.g. 'Hz')
   * @param {string}      opts.field   — top-level telemetry key to read
   * @param {number}      [opts.min]   — sparkline Y floor (auto if omitted)
   * @param {number}      [opts.max]   — sparkline Y ceiling (auto if omitted)
   * @param {number}      [opts.decimals=2] — decimal places for value display
   */
  constructor(containerEl, opts = {}) {
    this._container = containerEl;
    this._field     = opts.field    ?? 'freq';
    this._label     = opts.label    ?? '';
    this._unit      = opts.unit     ?? '';
    this._min       = opts.min;
    this._max       = opts.max;
    this._decimals  = opts.decimals ?? 2;
    this._buf       = [];           // max 60 values
    this._ctx       = null;

    this._build();
    this._ro = new ResizeObserver(() => this._setup());
    this._ro.observe(this._container);
  }

  _build() {
    // Header: label on left, live value on right
    const hdr = document.createElement('div');
    hdr.className = 'p1-spark-hdr';

    this._lblEl = document.createElement('span');
    this._lblEl.className = 'p1-spark-lbl';
    this._lblEl.textContent = this._label;

    this._valEl = document.createElement('span');
    this._valEl.className = 'p1-spark-val';
    this._valEl.textContent = '–';

    hdr.appendChild(this._lblEl);
    hdr.appendChild(this._valEl);

    // Canvas
    this._canvas        = document.createElement('canvas');
    this._canvas.style.cssText = 'display:block;width:100%;height:36px;';

    // Unit label
    this._unitEl = document.createElement('span');
    this._unitEl.className = 'p1-spark-unit';
    this._unitEl.textContent = this._unit;

    this._container.appendChild(hdr);
    this._container.appendChild(this._canvas);
    this._container.appendChild(this._unitEl);

    requestAnimationFrame(() => this._setup());
  }

  _setup() {
    if (!this._container.offsetWidth) return;
    this._ctx = setupCanvas(this._canvas, this._canvas);
    this._draw();
  }

  /** Push one value into the ring buffer. */
  _push(value) {
    this._buf.push(value);
    if (this._buf.length > 60) this._buf.shift();
  }

  /** Called by page at 1 Hz. Reads field from telemetryData, redraws. */
  update(telemetryData) {
    const raw = telemetryData?.[this._field];
    if (raw != null && typeof raw === 'number') {
      this._push(raw);
      this._valEl.textContent = raw.toFixed(this._decimals) + '\u202F' + this._unit;
    }
    this._draw();
  }

  _draw() {
    if (!this._ctx || this._buf.length === 0) return;
    clearCanvas(this._ctx);
    drawSparkline(this._ctx, this._buf, {
      activeColor:   '--bar-active',
      inactiveColor: '--bar-inactive',
      barWidth:      3,
      barGap:        2,
      min:           this._min,
      max:           this._max,
      activeCount:   1,
    });
  }

  destroy() {
    this._ro.disconnect();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Utility helpers
// ══════════════════════════════════════════════════════════════════════════

/** Format seconds as HH:MM:SS */
function _fmtUptime(s) {
  const sec = s | 0;
  const h   = (sec / 3600 | 0);
  const m   = ((sec % 3600) / 60 | 0);
  const ss  = sec % 60;
  return [h, m, ss].map(n => String(n).padStart(2, '0')).join(':');
}

/** Map health score (0–100) to CSS variable name */
function _healthColor(score) {
  if (score >= 90) return 'var(--health-excellent)';
  if (score >= 70) return 'var(--health-good)';
  if (score >= 50) return 'var(--health-degraded)';
  if (score >= 30) return 'var(--health-poor)';
  return 'var(--health-critical)';
}

/**
 * Map RSSI dBm to filled bar count 0–4.
 * Thresholds per DESIGN.md §1.11 Infographic.
 */
function _rssiBars(rssi) {
  if (rssi == null || rssi < -120) return 0;
  if (rssi >= -50) return 4;
  if (rssi >= -65) return 3;
  if (rssi >= -75) return 2;
  return 1;
}

/**
 * Map RSSI to a 0–100 health score for the Grid HexHealthCell.
 * -40 dBm (excellent) → 100, -100 dBm (dead) → 0
 */
function _rssiToHealth(rssi) {
  if (rssi == null) return 0;
  const clamped = Math.max(-100, Math.min(-40, rssi));
  return Math.round(((clamped + 100) / 60) * 100);
}

/** Make an el with class + optional text */
function _el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls)  e.className   = cls;
  if (text) e.textContent = text;
  return e;
}

// Color ramp for power factor arc gauge (low PF = bad, high PF = good)
const PF_COLOR_RAMP = [
  { threshold:  0, color: '--health-critical' },
  { threshold: 70, color: '--health-poor'     },
  { threshold: 85, color: '--health-good'     },
  { threshold: 95, color: '--health-excellent'},
];

// Color ramp for overall health arc gauge
const HEALTH_COLOR_RAMP = [
  { threshold:  0, color: '--health-critical' },
  { threshold: 30, color: '--health-poor'     },
  { threshold: 50, color: '--health-degraded' },
  { threshold: 70, color: '--health-good'     },
  { threshold: 90, color: '--health-excellent'},
];

// ══════════════════════════════════════════════════════════════════════════
// Page1Status
// ══════════════════════════════════════════════════════════════════════════

export class Page1Status {

  constructor() {
    // Component buckets
    this._allComponents       = [];  // every component — for destroy() loop
    this._sparklineComponents = [];  // updated at 1 Hz
    this._slowComponents      = [];  // updated at 0.5 Hz

    // Rates
    this._lastSparklineUpdate = 0;
    this._lastSlowUpdate      = 0;

    // Uptime clock
    this._uptimeInterval  = null;
    this._lastUptimeS     = 0;
    this._lastUptimeAt    = 0;

    // DOM refs
    this._uptimeEl        = null;
    this._healthScoreEl   = null;
    this._relayDotEl      = null;
    this._relayStateEl    = null;
    this._wifiBarEls      = [];
    this._connDotEl       = null;
    this._connLblEl       = null;
    this._heroVEl         = null;
    this._heroAEl         = null;
    this._heroWEl         = null;
    this._freqValEl       = null;
    this._freqTolDotEl    = null;
    this._energyValEl     = null;
    this._hexContainers   = [];       // container divs for signal paths
    this._overallGaugeCon = null;     // ArcGauge container for signal path toEl
    this._signalPaths     = [];
    this._sharedOverlaySvg= null;

    // Injected style element
    this._styleEl         = null;
  }

  // ── mount ──────────────────────────────────────────────────────────────

  /**
   * Instantiate all components and inject into page zones.
   * @param {HTMLElement} containerEl — the #page-status <main> element
   */
  mount(containerEl) {
    this._container = containerEl;

    // Inject page-specific styles
    this._injectStyles();

    // Apply grid layout class to .page-content
    this._pageContent = containerEl.querySelector('.page-content');
    if (this._pageContent) this._pageContent.classList.add(LAYOUT_CLS);

    // Query zone sections
    this._zoneStatus  = containerEl.querySelector('#zone-system-status');
    this._zoneMetrics = containerEl.querySelector('#zone-main-metrics');
    this._zoneCharts  = containerEl.querySelector('#zone-charts');
    this._zoneHealth  = containerEl.querySelector('#zone-health-grid');
    this._zoneSidebar = containerEl.querySelector('#zone-sidebar');

    // Build each zone
    this._buildZone1();
    this._buildZone2();
    this._buildZone3A();
    this._buildZone3B();
    this._buildZone4();

    // Start local uptime clock
    this._startUptimeClock();

    // Signal paths need post-layout coordinates — double-rAF ensures layout
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this._buildSignalPaths();
      });
    });
  }

  // ── update ─────────────────────────────────────────────────────────────

  /**
   * Route incoming telemetry to components at the correct Hz.
   * Called by main.js on every poller tick.
   * @param {object} telemetryData — canonical telemetry from poller/mock
   */
  update(telemetryData) {
    if (!telemetryData) return;
    const now = Date.now();

    // Extend data with derived fields not present in canonical schema
    const data = {
      ...telemetryData,
      // Power health: proxy via power factor (0–1 → 0–100)
      _power_health: Math.min(100, Math.max(0, Math.round((telemetryData.pf ?? 0.9) * 100))),
      // Grid health: WiFi RSSI mapped to 0–100
      _grid_health: _rssiToHealth(telemetryData.wifi?.rssi ?? null),
    };

    // ── Always: hero numbers + live indicators (direct DOM) ───────────
    this._updateNavBadge(data);
    this._updateUptimeBase(data);
    this._updateZone1Live(data);
    this._updateHeroNumbers(data);
    this._updateEnergyKwh(data);
    this._updateFrequencyDisplay(data);

    // ── Always: animated components (self-rate-limit via animationLoop) ─
    this._waveformCard?.update(data);
    this._arcGaugePF?.update(data);
    this._energyFlowMap?.update(data);
    this._relayToggle?.update(data);
    for (const sp of this._signalPaths) sp.update(data);

    // ── 1 Hz: sparklines ──────────────────────────────────────────────
    if (now - this._lastSparklineUpdate >= 1000) {
      this._lastSparklineUpdate = now;
      for (const c of this._sparklineComponents) c.update(data);
    }

    // ── 0.5 Hz: state badge, hex cells, fault indicators, health gauge ─
    if (now - this._lastSlowUpdate >= 2000) {
      this._lastSlowUpdate = now;
      for (const c of this._slowComponents) c.update(data);
    }
  }

  // ── destroy ────────────────────────────────────────────────────────────

  /**
   * Destroy all components, remove injected styles, reset layout class.
   * Must leave zero orphaned animationLoop subscribers.
   */
  destroy() {
    // Stop uptime clock
    this._stopUptimeClock();

    // Destroy all components
    for (const c of this._allComponents) {
      try { c.destroy(); } catch (e) { console.error('[page1] component destroy error:', e); }
    }
    this._allComponents       = [];
    this._sparklineComponents = [];
    this._slowComponents      = [];
    this._signalPaths         = [];

    // Remove shared SVG overlay
    if (this._sharedOverlaySvg?.parentNode) {
      this._sharedOverlaySvg.remove();
    }
    this._sharedOverlaySvg = null;

    // Remove grid layout class
    if (this._pageContent) this._pageContent.classList.remove(LAYOUT_CLS);

    // Clear zone content
    const zones = [
      this._zoneStatus, this._zoneMetrics, this._zoneCharts,
      this._zoneHealth, this._zoneSidebar,
    ];
    for (const z of zones) {
      if (z) z.innerHTML = '';
    }

    // Remove injected styles
    this._styleEl?.remove();
    this._styleEl = null;

    // Restore nav badge to boot state (it will be re-updated on remount)
    const navBadge = document.getElementById('fsm-state-badge');
    if (navBadge) {
      navBadge.textContent = 'BOOT';
      navBadge.dataset.state = 'BOOT';
      navBadge.style.backgroundColor = 'var(--state-boot)';
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Style injection
  // ══════════════════════════════════════════════════════════════════════

  _injectStyles() {
    if (document.getElementById(STYLE_ID)) return; // already injected
    this._styleEl = document.createElement('style');
    this._styleEl.id = STYLE_ID;
    this._styleEl.textContent = PAGE1_CSS;
    document.head.appendChild(this._styleEl);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Zone 1 — System Status Bar
  // ══════════════════════════════════════════════════════════════════════

  _buildZone1() {
    const z = this._zoneStatus;
    if (!z) return;
    z.innerHTML = '';  // clear placeholder

    // ── StateBadge ──────────────────────────────────────────────────
    const badgeWrap = _el('div', 'p1-z1-badge-wrap');
    const badge = new StateBadge(badgeWrap, { statusBarEl: z });
    z.appendChild(badgeWrap);
    this._stateBadge = badge;
    this._slowComponents.push(badge);
    this._allComponents.push(badge);

    // ── Separator ───────────────────────────────────────────────────
    z.appendChild(_el('span', 'p1-z1-sep'));

    // ── Uptime counter ──────────────────────────────────────────────
    const uptimeWrap = _el('div', 'p1-z1-uptime');
    this._uptimeEl = _el('span', null, '00:00:00');
    uptimeWrap.append(_el('span', 'p1-z1-health-lbl', 'UPTIME\u2002'), this._uptimeEl);
    z.appendChild(uptimeWrap);

    // ── Separator ───────────────────────────────────────────────────
    z.appendChild(_el('span', 'p1-z1-sep'));

    // ── Health score ────────────────────────────────────────────────
    const healthWrap = _el('div', 'p1-z1-health');
    this._healthScoreEl = _el('span', 'p1-z1-health-score', '–');
    healthWrap.append(this._healthScoreEl, _el('span', 'p1-z1-health-lbl', 'HEALTH'));
    z.appendChild(healthWrap);

    // ── Separator ───────────────────────────────────────────────────
    z.appendChild(_el('span', 'p1-z1-sep'));

    // ── Relay indicator ─────────────────────────────────────────────
    const relayWrap = _el('div', 'p1-z1-relay');
    this._relayDotEl   = _el('span', 'p1-z1-relay-dot');
    this._relayStateEl = _el('span', 'p1-z1-relay-state', '–');
    relayWrap.append(this._relayDotEl, _el('span', 'p1-z1-relay-lbl', 'RELAY\u2002'), this._relayStateEl);
    z.appendChild(relayWrap);

    // ── Separator ───────────────────────────────────────────────────
    z.appendChild(_el('span', 'p1-z1-sep'));

    // ── WiFi RSSI bars ──────────────────────────────────────────────
    const wifiWrap = _el('div', 'p1-z1-wifi');
    wifiWrap.setAttribute('aria-label', 'WiFi signal strength');
    const barHeights = [4, 7, 10, 14]; // px heights: 4 bars increasing
    this._wifiBarEls = barHeights.map(h => {
      const bar = _el('span', 'p1-z1-wifi-bar');
      bar.style.height = h + 'px';
      bar.style.backgroundColor = 'var(--text-faint)';
      wifiWrap.appendChild(bar);
      return bar;
    });
    z.appendChild(wifiWrap);

    // ── Spacer (pushes connection info to the right) ─────────────────
    z.appendChild(_el('span', 'p1-z1-spacer'));

    // ── Connection indicator ─────────────────────────────────────────
    const connWrap = _el('div', 'p1-z1-conn');
    this._connDotEl  = _el('span', 'p1-z1-conn-dot');
    this._connDotEl.style.backgroundColor = 'var(--text-faint)';
    this._connLblEl  = _el('span', null, 'CONNECTING');
    connWrap.append(this._connDotEl, this._connLblEl);
    z.appendChild(connWrap);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Zone 2 — Main Metrics
  // ══════════════════════════════════════════════════════════════════════

  _buildZone2() {
    const z = this._zoneMetrics;
    if (!z) return;
    z.innerHTML = '';

    const grid = _el('div', 'p1-z2-grid');

    // ── Waveform card ────────────────────────────────────────────────
    const waveWrap = _el('div', 'p1-z2-waveform');
    const waveCard = new WaveformCard(waveWrap, {
      showVoltage: true,
      showCurrent: true,
      vMin: 210, vMax: 250,
      iMin: 0,   iMax: 25,
    });
    grid.appendChild(waveWrap);
    this._waveformCard = waveCard;
    this._allComponents.push(waveCard);

    // ── Right column: PF gauge + frequency ───────────────────────────
    const rightCol = _el('div', 'p1-z2-right');

    // Power Factor ArcGauge
    const pfWrap = _el('div', 'p1-pf-wrap');
    const arcPF = new ArcGauge(pfWrap, {
      field:     'pf',
      min:       0,
      max:       1,
      unit:      'PF',
      label:     'Power Factor',
      size:      148,
      colorRamp: PF_COLOR_RAMP,
    });
    rightCol.appendChild(pfWrap);
    this._arcGaugePF = arcPF;
    this._allComponents.push(arcPF);

    // Frequency card
    const freqCard = _el('div', 'p1-freq-card');
    const freqLbl  = _el('span', 'p1-freq-lbl', 'FREQUENCY');
    const freqRow  = _el('div', 'p1-freq-row');
    this._freqValEl    = _el('span', 'p1-freq-val', '–');
    freqRow.append(this._freqValEl, _el('span', 'p1-freq-hz', 'Hz'));
    const tolRow  = _el('div', 'p1-freq-tol');
    this._freqTolDotEl = _el('span', 'p1-freq-tol-dot');
    this._freqTolDotEl.style.backgroundColor = 'var(--text-faint)';
    const tolTxt  = _el('span', null, '\u00B10.02\u202FHz');
    tolRow.append(this._freqTolDotEl, tolTxt);
    freqCard.append(freqLbl, freqRow, tolRow);
    rightCol.appendChild(freqCard);
    grid.appendChild(rightCol);

    // ── Hero numbers row ─────────────────────────────────────────────
    const heroRow = _el('div', 'p1-z2-heroes');

    const heroes = [
      { id: 'v', label: 'VOLTAGE', unit: 'V',  ref: '_heroVEl' },
      { id: 'i', label: 'CURRENT', unit: 'A',  ref: '_heroAEl' },
      { id: 'p', label: 'POWER',   unit: 'W',  ref: '_heroWEl' },
    ];
    for (const { label, unit, ref } of heroes) {
      const card = _el('div', 'p1-hero');
      const lbl  = _el('span', 'p1-hero-lbl', label);
      const val  = _el('span', 'p1-hero-val', '–');
      const un   = _el('span', 'p1-hero-unit', unit);
      card.append(lbl, val, un);
      heroRow.appendChild(card);
      this[ref] = val;  // store DOM ref for direct update
    }
    grid.appendChild(heroRow);

    z.appendChild(grid);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Zone 3A — Charts Panel
  // ══════════════════════════════════════════════════════════════════════

  _buildZone3A() {
    const z = this._zoneCharts;
    if (!z) return;
    z.innerHTML = '';

    const grid = _el('div', 'p1-z3a-grid');

    // Temperature — uses telemetryBuffer.getSparkline('t') via Sparkline component
    const tempCell = _el('div', 'p1-spark-cell');
    const sparkTemp = new Sparkline(tempCell, {
      field: 't',
      label: 'Temperature',
      unit:  '°C',
      min:   25,
      max:   65,
    });
    grid.appendChild(tempCell);
    this._sparklineComponents.push(sparkTemp);
    this._allComponents.push(sparkTemp);

    // Frequency — _MiniSparkline (not tracked in telemetryBuffer)
    const freqCell = _el('div', 'p1-spark-cell');
    const sparkFreq = new _MiniSparkline(freqCell, {
      field:    'freq',
      label:    'Frequency',
      unit:     'Hz',
      min:      49.8,
      max:      50.2,
      decimals: 2,
    });
    grid.appendChild(freqCell);
    this._sparklineComponents.push(sparkFreq);
    this._allComponents.push(sparkFreq);

    // Power Factor — _MiniSparkline
    const pfCell = _el('div', 'p1-spark-cell');
    const sparkPF = new _MiniSparkline(pfCell, {
      field:    'pf',
      label:    'Power Factor',
      unit:     '',
      min:      0.80,
      max:      1.00,
      decimals: 3,
    });
    grid.appendChild(pfCell);
    this._sparklineComponents.push(sparkPF);
    this._allComponents.push(sparkPF);

    z.appendChild(grid);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Zone 3B — Health Grid
  // ══════════════════════════════════════════════════════════════════════

  _buildZone3B() {
    const z = this._zoneHealth;
    if (!z) return;
    z.innerHTML = '';
    z.style.position = 'relative';

    const inner = _el('div', 'p1-z3b-inner');

    // ── Top card: header + overall health ArcGauge ───────────────────
    const topCard = _el('div', 'p1-z3b-top');
    topCard.appendChild(_el('div', 'p1-z3b-gauge-hdr', 'SYSTEM HEALTH'));

    const gaugeWrap = _el('div', 'p1-z3b-gauge-wrap');
    const arcHealth = new ArcGauge(gaugeWrap, {
      field:     'health',
      min:       0,
      max:       100,
      unit:      '%',
      label:     'Overall',
      size:      130,
      colorRamp: HEALTH_COLOR_RAMP,
    });
    gaugeWrap.id = 'p1-overall-gauge';
    this._overallGaugeCon = gaugeWrap;
    topCard.appendChild(gaugeWrap);
    inner.appendChild(topCard);
    this._arcGaugeHealth = arcHealth;
    this._slowComponents.push(arcHealth);
    this._allComponents.push(arcHealth);

    // ── Hex cell grid ────────────────────────────────────────────────
    const hexGrid = _el('div', 'p1-hex-grid');

    // Each entry: { label, field, description }
    // _power_health and _grid_health are injected by update() onto ext data
    const hexDefs = [
      { label: 'Voltage', field: 'diagnostics.voltage_stability' },
      { label: 'Current', field: 'diagnostics.current_stability' },
      { label: 'Thermal', field: 'diagnostics.temp_stability'    },
      { label: 'ADC',     field: 'diagnostics.adc_health'        },
      { label: 'Power',   field: '_power_health'                 },
      { label: 'Grid',    field: '_grid_health'                  },
    ];

    this._hexContainers = [];

    for (const def of hexDefs) {
      const cellWrap = _el('div', 'p1-hex-cell');
      const cell = new HexHealthCell(cellWrap, {
        field: def.field,
        label: def.label,
      });
      hexGrid.appendChild(cellWrap);
      this._hexContainers.push(cellWrap);
      this._slowComponents.push(cell);
      this._allComponents.push(cell);
    }

    inner.appendChild(hexGrid);
    z.appendChild(inner);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Zone 4 — Sidebar
  // ══════════════════════════════════════════════════════════════════════

  _buildZone4() {
    const z = this._zoneSidebar;
    if (!z) return;
    z.innerHTML = '';

    const stack = _el('div', 'p1-z4-stack');

    // ── Energy Flow Map ──────────────────────────────────────────────
    const efmCard = _el('div', 'p1-card');
    efmCard.appendChild(_el('div', 'p1-card-hdr', 'ENERGY FLOW'));
    const efmContainer = _el('div');
    efmCard.appendChild(efmContainer);
    const efm = new EnergyFlowMap(efmContainer, { showValueOverlay: true });
    stack.appendChild(efmCard);
    this._energyFlowMap = efm;
    this._allComponents.push(efm);

    // ── Relay toggle + Energy kWh ────────────────────────────────────
    const relayEnergyRow = _el('div', 'p1-relay-row');

    // Relay toggle card
    const relayCard = _el('div', 'p1-relay-card');
    relayCard.appendChild(_el('div', 'p1-card-hdr', 'RELAY'));
    const relay = new RelayToggle(relayCard, {
      label:   'Relay 1',
      apiPath: '/api/relay',
    });
    relayEnergyRow.appendChild(relayCard);
    this._relayToggle = relay;
    this._allComponents.push(relay);

    // Energy kWh card
    const energyCard = _el('div', 'p1-energy-card');
    energyCard.appendChild(_el('span', 'p1-energy-lbl', 'ENERGY'));
    this._energyValEl = _el('span', 'p1-energy-val', '0.000');
    energyCard.appendChild(this._energyValEl);
    energyCard.appendChild(_el('span', 'p1-energy-unit', 'kWh'));
    relayEnergyRow.appendChild(energyCard);
    stack.appendChild(relayEnergyRow);

    // ── Fault indicators ─────────────────────────────────────────────
    const faultCard = _el('div', 'p1-card');
    faultCard.appendChild(_el('div', 'p1-card-hdr', 'FAULT FLAGS'));
    const faultGrid = _el('div', 'p1-fault-grid');

    // Hard fault flags
    const faultDefs = [
      { key: 'faults.over_voltage',  label: 'Over Voltage',  warn: false },
      { key: 'faults.over_current',  label: 'Over Current',  warn: false },
      { key: 'faults.over_temp',     label: 'Over Temp',     warn: false },
      { key: 'faults.short_circuit', label: 'Short Circuit', warn: false },
      { key: 'faults.inrush',        label: 'Inrush',        warn: false },
      // Warning flags
      { key: 'faults.warnings.ov',          label: 'Warn: OV',       warn: true },
      { key: 'faults.warnings.uv',          label: 'Warn: UV',       warn: true },
      { key: 'faults.warnings.oc',          label: 'Warn: OC',       warn: true },
      { key: 'faults.warnings.thermal',     label: 'Warn: Thermal',  warn: true },
      { key: 'faults.warnings.curr_rising', label: 'Warn: Rising I', warn: true },
    ];

    for (const def of faultDefs) {
      const cell = _el('div');
      const fi = new FaultIndicator(cell, {
        faultKey:    def.key,
        label:       def.label,
        warningMode: def.warn,
      });
      faultGrid.appendChild(cell);
      this._slowComponents.push(fi);
      this._allComponents.push(fi);
    }

    faultCard.appendChild(faultGrid);
    stack.appendChild(faultCard);

    z.appendChild(stack);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Signal paths (Zone 3B — built post-layout)
  // ══════════════════════════════════════════════════════════════════════

  _buildSignalPaths() {
    const z = this._zoneHealth;
    const gaugeEl = this._overallGaugeCon;
    if (!z || !gaugeEl || !gaugeEl.isConnected) return;

    // Create one shared SVG overlay for all paths within Zone 3B
    const svg = createOverlaySvg();
    z.appendChild(svg);
    this._sharedOverlaySvg = svg;

    // Connect every hex cell to the overall health gauge
    // Use alternating voltage/current dot colors for visual interest
    const dotClasses = ['signal-dot--voltage', 'signal-dot--current'];
    for (let i = 0; i < this._hexContainers.length; i++) {
      const cellEl = this._hexContainers[i];
      if (!cellEl.isConnected) continue;

      try {
        const sp = new SignalPath(z, {
          fromEl:   cellEl,
          toEl:     gaugeEl,
          dotClass: dotClasses[i % 2],
          svgEl:    svg,
        });
        this._signalPaths.push(sp);
        this._allComponents.push(sp);
      } catch (err) {
        console.warn('[page1] signal path error:', err);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Update helpers
  // ══════════════════════════════════════════════════════════════════════

  /** Update the nav-bar FSM badge (#fsm-state-badge) on every tick. */
  _updateNavBadge(data) {
    const badge = document.getElementById('fsm-state-badge');
    if (!badge) return;
    const state = data.state ?? 'BOOT';
    badge.textContent    = state;
    badge.dataset.state  = state;
    badge.setAttribute('aria-label', `System state: ${state}`);

    const stateVars = {
      BOOT:     '--state-boot',
      NORMAL:   '--state-normal',
      WARNING:  '--state-warning',
      FAULT:    '--state-fault',
      RECOVERY: '--state-recovery',
      LOCKOUT:  '--state-lockout',
    };
    badge.style.backgroundColor = `var(${stateVars[state] ?? '--state-boot'})`;
    badge.style.color = state === 'WARNING' ? 'var(--text-on-light)' : 'var(--text-primary)';
  }

  /** Record new uptime base so the clock can interpolate between ticks. */
  _updateUptimeBase(data) {
    if (data.uptime != null) {
      this._lastUptimeS  = data.uptime;
      this._lastUptimeAt = Date.now();
    }
  }

  /** Update all always-on Zone 1 live indicators (excluding uptime clock). */
  _updateZone1Live(data) {
    // Health score + color
    if (this._healthScoreEl) {
      const score = data.health ?? 0;
      this._healthScoreEl.textContent = score.toString();
      this._healthScoreEl.style.color = _healthColor(score);
    }

    // Relay dot + state label
    if (this._relayDotEl && this._relayStateEl) {
      const closed = data.relay ?? false;
      this._relayDotEl.style.backgroundColor = closed
        ? 'var(--health-excellent)'
        : 'var(--state-fault)';
      this._relayStateEl.textContent = closed ? 'CLOSED' : 'OPEN';
      this._relayStateEl.style.color = closed
        ? 'var(--health-excellent)'
        : 'var(--state-fault)';
    }

    // WiFi RSSI bars (DESIGN.md §1.11 thresholds)
    if (this._wifiBarEls.length === 4) {
      const rssi = data.wifi?.rssi ?? null;
      const lit  = _rssiBars(rssi);
      this._wifiBarEls.forEach((bar, i) => {
        bar.style.backgroundColor = i < lit
          ? (lit <= 1 ? 'var(--state-fault)'   :
             lit <= 2 ? 'var(--state-warning)'  :
                        'var(--health-excellent)')
          : 'var(--text-faint)';
      });
    }

    // Connection dot
    if (this._connDotEl && this._connLblEl) {
      const connected = data.wifi?.connected ?? false;
      this._connDotEl.style.backgroundColor = connected
        ? 'var(--health-excellent)'
        : 'var(--state-fault)';
      this._connLblEl.textContent = connected ? 'CONNECTED' : 'OFFLINE';
    }
  }

  /** Update Zone 2 hero number DOM elements directly (10 Hz, no canvas). */
  _updateHeroNumbers(data) {
    if (this._heroVEl) this._heroVEl.textContent = (data.v ?? 0).toFixed(1);
    if (this._heroAEl) this._heroAEl.textContent = (data.i ?? 0).toFixed(2);
    if (this._heroWEl) this._heroWEl.textContent = (data.p ?? 0).toFixed(0);
  }

  /** Update frequency value + ±0.02 Hz tolerance indicator. */
  _updateFrequencyDisplay(data) {
    if (!this._freqValEl) return;
    const freq    = data.freq ?? 50;
    const nominal = 50;                // EU/Asia nominal (firmware is 50 Hz)
    const withinTol = Math.abs(freq - nominal) <= 0.02;

    this._freqValEl.textContent = freq.toFixed(2);

    if (this._freqTolDotEl) {
      this._freqTolDotEl.style.backgroundColor = withinTol
        ? 'var(--health-excellent)'
        : 'var(--state-warning)';
      this._freqTolDotEl.title = withinTol
        ? 'Within ±0.02 Hz tolerance'
        : 'Outside ±0.02 Hz tolerance';
    }
  }

  /** Update energy kWh display in Zone 4. */
  _updateEnergyKwh(data) {
    if (!this._energyValEl) return;
    const wh  = data.e ?? 0;
    const kwh = wh / 1000;
    // Adaptive precision
    const decimals = kwh < 0.1 ? 4 : kwh < 10 ? 3 : 2;
    this._energyValEl.textContent = kwh.toFixed(decimals);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Uptime clock
  // ══════════════════════════════════════════════════════════════════════

  _startUptimeClock() {
    this._lastUptimeS  = 0;
    this._lastUptimeAt = Date.now();

    this._uptimeInterval = setInterval(() => {
      if (!this._uptimeEl) return;
      const elapsed  = Math.floor((Date.now() - this._lastUptimeAt) / 1000);
      const uptimeSec = this._lastUptimeS + elapsed;
      this._uptimeEl.textContent = _fmtUptime(uptimeSec);
    }, 1000);
  }

  _stopUptimeClock() {
    clearInterval(this._uptimeInterval);
    this._uptimeInterval = null;
  }
}
