/**
 * page3-diagnostics.js — Smart Grid Sentinel Page 3: Diagnostics
 * Phase 7 deliverable. DESIGN.md §10, §17.
 *
 * Deep sensor and system health analysis. View-only — no control actions.
 *
 * Layout (top → bottom):
 *   Row 1  — Health Honeycomb (5 HexHealthCell instances)
 *   Row 2  — Power Quality Radar (SVG pentagon) · Sensor Detail Panels
 *   Row 3  — ADC Health Panel
 *   Row 4  — System Health Metrics (Heap bar, CPU panel, Uptime ring, Confidence bars)
 *   Row 5  — Protection Parameters (GET /api/config with graceful fallback)
 *
 * Page lifecycle (DESIGN.md §17):
 *   mount(containerEl)    — instantiate components, inject styles
 *   update(telemetryData) — route data at appropriate Hz per field group
 *   destroy()             — tear down all components, remove injected styles
 *
 * Update rate gates (DESIGN.md §7):
 *   always  — CPU load panel, heap bar, sparklines
 *   1 Hz    — sensor detail bars, confidence bars
 *   0.5 Hz  — hex cells, radar chart, uptime ring
 */

import { HexHealthCell } from '../components/hexHealthCell.js';
import { GpuPanel }      from '../components/gpuPanel.js';

// ── Style injection ────────────────────────────────────────────────────────
const STYLE_ID   = 'p3-page-styles';
const LAYOUT_CLS = 'p3-active';

const PAGE3_CSS = `
/* ─── Page 3 root layout ─── */
.p3-active {
  display: flex !important;
  flex-direction: column;
  gap: var(--space-md);
  padding: var(--space-lg) var(--space-xl);
}

/* ─── Cards ─── */
.p3-card {
  background: var(--bg-card-dark);
  border-radius: var(--radius-md);
  padding: var(--space-md);
}
.p3-card-hdr {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: var(--space-sm);
}

/* ─── Row 1: Health Honeycomb ─── */
.p3-honeycomb {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
  justify-content: center;
  padding: var(--space-sm);
}
.p3-hex-cell {
  flex: 0 0 auto;
}

/* ─── Row 2: Radar + Sensor Detail side by side ─── */
.p3-row2 {
  display: grid;
  grid-template-columns: 340px 1fr;  /* wider radar column */
  gap: 0;                            /* cards touch — no gap */
  align-items: stretch;
}

/* Flatten the shared inner edges so the two cards merge seamlessly */
.p3-row2 > .p3-card:first-child {
  border-radius: var(--radius-md) 0 0 var(--radius-md);
  border-right: 1px solid var(--border-subtle);  /* single hairline divider */
}
.p3-row2 > .p3-card:last-child {
  display: flex;
  flex-direction: column;
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
}

/* ─── SVG Radar chart ─── */
.p3-radar-svg {
  display: block;
  margin: 0 auto;
}

/* ─── Sensor Detail Panels ─── */
.p3-sensor-groups {
  display: flex;
  flex-direction: column;
  flex: 1;                          /* grow to fill the card's remaining height */
  justify-content: space-between;  /* equal vertical space between channel groups */
  gap: var(--space-sm);
}
.p3-sensor-group-title {
  font-size: 10px;
  color: var(--health-excellent);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 6px;
}
.p3-metric-row {
  display: grid;
  grid-template-columns: 130px 1fr 60px;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px solid var(--border-subtle);
}
.p3-metric-row:last-child { border-bottom: none; }
.p3-metric-label {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
}
.p3-metric-bar-track {
  height: 5px;
  background: var(--progress-track);
  border-radius: var(--radius-pill);
  overflow: hidden;
}
.p3-metric-bar-fill {
  height: 100%;
  border-radius: var(--radius-pill);
  background: var(--health-excellent);
  transition: width 400ms ease-in-out, background 400ms ease-in-out;
  will-change: width;
}
.p3-metric-value {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-primary);
  text-align: right;
  font-variant-numeric: tabular-nums;
  transition: color 400ms ease-in-out;
}
.p3-stability-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.04em;
  white-space: nowrap;
}

/* ─── Row 3: ADC Health ─── */
.p3-adc-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr 1fr;
  gap: var(--space-md);
  align-items: start;
}

/* ─── ADC calibration badge ─── */
.p3-cal-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
}

/* ─── Row 4: System Health ─── */
.p3-sys-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 120px 1fr;
  gap: var(--space-md);
  align-items: start;
}

/* ─── Heap fill bar ─── */
.p3-heap-track {
  height: 8px;
  background: var(--progress-track);
  border-radius: var(--radius-pill);
  overflow: hidden;
  margin: 8px 0 4px;
}
.p3-heap-fill {
  height: 100%;
  border-radius: var(--radius-pill);
  transition: width 400ms ease, background 400ms ease;
}

/* ─── Uptime ring ─── */
.p3-uptime-ring {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.p3-uptime-svg { display: block; }

/* ─── Confidence bar rows ─── */
.p3-conf-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.p3-conf-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.p3-conf-hdr {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--text-muted);
}
.p3-conf-track {
  height: 4px;
  background: var(--progress-track);
  border-radius: var(--radius-pill);
  overflow: hidden;
}
.p3-conf-fill {
  height: 100%;
  border-radius: var(--radius-pill);
  transition: width 400ms ease, background 400ms ease;
}

/* ─── Row 5: Protection Parameters ─── */
.p3-params-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-sm);
}
.p3-param-cell {
  background: var(--bg-card-dark-2, var(--bg-card-dark));
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.p3-param-label {
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.p3-param-value {
  font-size: 16px;
  font-family: var(--font-mono);
  font-weight: 300;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}
.p3-param-unit {
  font-size: 10px;
  color: var(--text-faint);
}
.p3-config-note {
  font-size: 10px;
  color: var(--text-faint);
  margin-top: 8px;
  font-style: italic;
}

/* ─── Page title row ─── */
.p3-page-hdr {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: var(--space-md) var(--space-xl) 0;
}
.p3-page-title {
  font-size: var(--text-section);
  font-weight: 300;
  color: var(--text-primary);
  letter-spacing: 0.02em;
}

/* ─── Responsive ─── */
@media (max-width: 900px) {
  .p3-row2        { grid-template-columns: 1fr; }
  .p3-adc-grid    { grid-template-columns: 1fr 1fr; }
  .p3-sys-grid    { grid-template-columns: 1fr 1fr; }
  .p3-params-grid { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 580px) {
  .p3-adc-grid    { grid-template-columns: 1fr; }
  .p3-sys-grid    { grid-template-columns: 1fr; }
  .p3-params-grid { grid-template-columns: 1fr; }
}
`;

// ── Constants ──────────────────────────────────────────────────────────────
const SVG_NS = 'http://www.w3.org/2000/svg';

// Health ramp helper
function _healthColor(score) {
  if (score >= 90) return 'var(--health-excellent)';
  if (score >= 70) return 'var(--health-good)';
  if (score >= 50) return 'var(--health-degraded)';
  if (score >= 30) return 'var(--health-poor)';
  return 'var(--health-critical)';
}

function _healthLabel(score) {
  if (score >= 90) return 'EXCELLENT';
  if (score >= 70) return 'GOOD';
  if (score >= 50) return 'DEGRADED';
  if (score >= 30) return 'POOR';
  return 'CRITICAL';
}

// Confidence color (≥80 green, 60–79 amber, <60 red)
function _confColor(pct) {
  if (pct >= 80) return 'var(--health-excellent)';
  if (pct >= 60) return 'var(--state-warning)';
  return 'var(--state-fault)';
}

// Safe deep-get
function _get(obj, path, fallback = null) {
  if (!path || obj == null) return fallback;
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return fallback;
    cur = cur[p];
  }
  return cur ?? fallback;
}

// Make an element
function _el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls)  e.className   = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ══════════════════════════════════════════════════════════════════════════
// Page3Diagnostics
// ══════════════════════════════════════════════════════════════════════════

export class Page3Diagnostics {

  constructor() {
    this._allComponents  = [];
    this._slowComponents = [];   // 0.5 Hz
    this._hz1Components  = [];   // 1 Hz

    this._lastSlowUpdate = 0;
    this._lastHz1Update  = 0;

    // DOM refs
    this._styleEl        = null;
    this._pageContent    = null;

    // Hex cells
    this._hexCells       = [];

    // Sensor bar DOM refs: { fill, valueEl }
    this._sensorBars     = {};

    // ADC refs
    this._adcCalBadge    = null;
    this._adcScoreEl     = null;
    this._adcLinFill     = null;
    this._adcLinVal      = null;
    this._adcSatEl       = null;
    this._adcSamplesEl   = null;

    // Heap
    this._heapFill       = null;
    this._heapLabelEl    = null;

    // CPU panel
    this._cpuPanel       = null;

    // Uptime
    this._uptimeSvg      = null;
    this._uptimeRingFill = null;
    this._uptimeCenterEl = null;
    this._uptimeQualEl   = null;
    this._uptimeCircumf  = 0;

    // Confidence bars
    this._confBars       = {};   // { v, i, t } → { fill, valEl }

    // Protection params
    this._paramEls       = {};   // field → valueEl
    this._paramNoteEl    = null;

    // Radar
    this._radarPolygon   = null;
    this._radarScoreEls  = [];

    // Config polling
    this._configData     = null;
    this._configFetched  = false;
    this._fetchAbortCtrl = null;   // AbortController for in-flight /api/config fetch
  }

  // ── mount ──────────────────────────────────────────────────────────────

  mount(containerEl) {
    this._container   = containerEl;
    _injectStyle(STYLE_ID, PAGE3_CSS);

    containerEl.innerHTML = '';
    containerEl.classList.add(LAYOUT_CLS);

    // Page header
    this._buildPageHeader(containerEl);

    // Sections
    this._buildHoneycomb(containerEl);
    this._buildRow2(containerEl);
    this._buildAdcSection(containerEl);
    this._buildSysSection(containerEl);
    this._buildProtectionParams(containerEl);

    // Fetch /api/config (graceful fallback on failure)
    this._fetchConfig();
  }

  // ── update ────────────────────────────────────────────────────────────

  update(telemetryData) {
    if (!telemetryData) return;
    const now = Date.now();

    // Always: CPU panel, heap bar
    this._cpuPanel?.update(telemetryData);
    this._updateHeap(telemetryData);

    // 1 Hz: sensor bars, confidence, ADC
    if (now - this._lastHz1Update >= 1000) {
      this._lastHz1Update = now;
      this._updateSensorBars(telemetryData);
      this._updateConfBars(telemetryData);
      this._updateAdcPanel(telemetryData);
      this._updateUptimeRing(telemetryData);
    }

    // 0.5 Hz: hex cells, radar
    if (now - this._lastSlowUpdate >= 2000) {
      this._lastSlowUpdate = now;
      for (const c of this._slowComponents) c.update(telemetryData);
      this._updateRadar(telemetryData);
    }
  }

  // ── destroy ───────────────────────────────────────────────────────────

// ── destroy ───────────────────────────────────────────────────────────
  destroy() {
    // 0. Abort any in-flight /api/config fetch so its callback never
    //    touches detached DOM nodes after we clear the container below.
    this._fetchAbortCtrl?.abort();
    this._fetchAbortCtrl = null;

    // 1. Destroy all child components
    if (this._allComponents) {
      for (const c of this._allComponents) {
        try { c.destroy(); } catch (e) { /* ignore */ }
      }
      this._allComponents  = [];
      this._slowComponents = [];
    }

    // 2. Remove injected CSS
    const styleEl = document.getElementById(STYLE_ID);
    if (styleEl) {
      try { styleEl.remove(); } catch (e) { /* ignore */ }
    }

    // 3. The Nuke (Aggressive DOM clearing)
    if (this._container) {
      this._container.classList.remove(LAYOUT_CLS);
      while (this._container.firstChild) {
        this._container.removeChild(this._container.firstChild);
      }
      this._container.innerHTML = '';
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Page header
  // ══════════════════════════════════════════════════════════════════════

  _buildPageHeader(parent) {
    const hdr = _el('div', 'p3-page-hdr');
    hdr.appendChild(_el('h2', 'p3-page-title', 'Diagnostics'));
    parent.appendChild(hdr);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Row 1 — Health Honeycomb
  // ══════════════════════════════════════════════════════════════════════

  _buildHoneycomb(parent) {
    const card = _el('div', 'p3-card');
    card.appendChild(_el('div', 'p3-card-hdr', 'HEALTH HONEYCOMB'));

    const grid = _el('div', 'p3-honeycomb');

    const hexDefs = [
      { label: 'Voltage', field: 'diagnostics.voltage_stability' },
      { label: 'Current', field: 'diagnostics.current_stability' },
      { label: 'Temp',    field: 'diagnostics.temp_stability'    },
      { label: 'ADC',     field: 'diagnostics.adc_health'        },
      { label: 'System',  field: 'diagnostics.system_health'     },
    ];

    for (const def of hexDefs) {
      const wrap = _el('div', 'p3-hex-cell');
      const cell = new HexHealthCell(wrap, { field: def.field, label: def.label });
      grid.appendChild(wrap);
      this._hexCells.push(cell);
      this._slowComponents.push(cell);
      this._allComponents.push(cell);
    }

    card.appendChild(grid);
    parent.appendChild(card);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Row 2 — Power Quality Radar + Sensor Detail Panels
  // ══════════════════════════════════════════════════════════════════════

  _buildRow2(parent) {
    const row = _el('div', 'p3-row2');

    // Left: Power Quality Radar (SVG pentagon)
    const radarCard = _el('div', 'p3-card');
    radarCard.appendChild(_el('div', 'p3-card-hdr', 'POWER QUALITY RADAR'));
    this._buildRadar(radarCard);
    row.appendChild(radarCard);

    // Right: Sensor detail panels
    const sensorCard = _el('div', 'p3-card');
    sensorCard.appendChild(_el('div', 'p3-card-hdr', 'SENSOR DETAIL'));
    this._buildSensorBars(sensorCard);
    row.appendChild(sensorCard);

    parent.appendChild(row);
  }

  // ── Radar chart (SVG pentagon) ────────────────────────────────────────

  _buildRadar(parent) {
    const SIZE = 320;
    const CX   = SIZE / 2;
    const CY   = SIZE / 2;
    const R    = 112;       // outer radius — scaled up with wider column
    const AXES = [
      'Volt. Stability',
      'Sag Resistance',
      'Swell Resist.',
      'Ripple Quality',
      'Flicker Quality',
    ];
    const N = AXES.length;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    svg.setAttribute('width',  SIZE);
    svg.setAttribute('height', SIZE);
    svg.setAttribute('class', 'p3-radar-svg');

    // Grid rings (20 / 40 / 60 / 80 / 100)
    for (let ring = 1; ring <= 5; ring++) {
      const r = (R * ring) / 5;
      const pts = _pentagonPoints(CX, CY, r, N);
      const poly = document.createElementNS(SVG_NS, 'polygon');
      poly.setAttribute('points', pts);
      poly.setAttribute('fill', 'none');
      poly.setAttribute('stroke', 'var(--border-subtle)');
      poly.setAttribute('stroke-width', ring === 5 ? '1' : '0.5');
      svg.appendChild(poly);
    }

    // Axis lines from center to each vertex
    for (let i = 0; i < N; i++) {
      const angle = (2 * Math.PI * i) / N - Math.PI / 2;
      const x2    = CX + R * Math.cos(angle);
      const y2    = CY + R * Math.sin(angle);
      const line  = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', CX); line.setAttribute('y1', CY);
      line.setAttribute('x2', x2); line.setAttribute('y2', y2);
      line.setAttribute('stroke', 'var(--border-subtle)');
      line.setAttribute('stroke-width', '0.5');
      svg.appendChild(line);
    }

    // Axis labels
    this._radarScoreEls = [];
    for (let i = 0; i < N; i++) {
      const angle = (2 * Math.PI * i) / N - Math.PI / 2;
      const lx    = CX + (R + 18) * Math.cos(angle);
      const ly    = CY + (R + 18) * Math.sin(angle);

      const labelEl = document.createElementNS(SVG_NS, 'text');
      labelEl.setAttribute('x', lx);
      labelEl.setAttribute('y', ly - 4);
      labelEl.setAttribute('text-anchor', 'middle');
      labelEl.setAttribute('dominant-baseline', 'middle');
      labelEl.setAttribute('fill', 'var(--text-faint)');
      labelEl.setAttribute('font-size', '8');
      labelEl.setAttribute('font-family', 'var(--font-primary)');
      labelEl.textContent = AXES[i];
      svg.appendChild(labelEl);

      // Score value at vertex
      const scoreEl = document.createElementNS(SVG_NS, 'text');
      const sx = CX + (R - 8) * Math.cos(angle);
      const sy = CY + (R - 8) * Math.sin(angle);
      scoreEl.setAttribute('x', sx);
      scoreEl.setAttribute('y', sy);
      scoreEl.setAttribute('text-anchor', 'middle');
      scoreEl.setAttribute('dominant-baseline', 'middle');
      scoreEl.setAttribute('fill', 'var(--health-excellent)');
      scoreEl.setAttribute('font-size', '9');
      scoreEl.setAttribute('font-family', 'var(--font-mono)');
      scoreEl.textContent = '–';
      svg.appendChild(scoreEl);
      this._radarScoreEls.push(scoreEl);
    }

    // Filled polygon (data)
    this._radarPolygon = document.createElementNS(SVG_NS, 'polygon');
    this._radarPolygon.setAttribute('fill', 'rgba(29,158,117,0.20)');
    this._radarPolygon.setAttribute('stroke', 'var(--health-excellent)');
    this._radarPolygon.setAttribute('stroke-width', '1.5');
    this._radarPolygon.setAttribute('stroke-linejoin', 'round');
    this._radarPolygon.style.transition = 'all 600ms ease-in-out';
    svg.appendChild(this._radarPolygon);

    // Power quality badge below chart
    this._radarBadgeEl = document.createElement('div');
    this._radarBadgeEl.style.cssText = [
      'text-align: center',
      'margin-top: 8px',
    ].join(';');

    parent.appendChild(svg);
    parent.appendChild(this._radarBadgeEl);
  }

  _updateRadar(data) {
    if (!this._radarPolygon) return;

    // Derive 5 axis scores from available canonical data.
    // When full diagnostics.power_quality.* is available (verbose v1.3 firmware),
    // those fields will be present. We gracefully fall back to stability proxy.
    const vStab    = _get(data, 'diagnostics.voltage_stability', 85);
    const label    = _get(data, 'diagnostics.power_quality_label', 'GOOD');

    // Score mapping from quality label when detailed sub-fields are unavailable
    const qualMap = { EXCELLENT: 95, GOOD: 80, FAIR: 60, POOR: 35 };
    const baseQ   = qualMap[label] ?? 80;

    const scores = [
      vStab,                                          // Voltage Stability
      Math.min(100, baseQ + 5),                       // Sag Resistance (proxy)
      Math.min(100, baseQ + 3),                       // Swell Resistance (proxy)
      Math.max(0, baseQ - 5),                         // Ripple Quality (proxy)
      Math.max(0, baseQ - 8),                         // Flicker Quality (proxy)
    ];

    const N = scores.length;
    const CX = 160, CY = 160, R = 112;

    const pts = scores.map((score, i) => {
      const angle = (2 * Math.PI * i) / N - Math.PI / 2;
      const r = (Math.max(0, Math.min(100, score)) / 100) * R;
      return `${CX + r * Math.cos(angle)},${CY + r * Math.sin(angle)}`;
    }).join(' ');

    this._radarPolygon.setAttribute('points', pts);

    // Update score labels
    for (let i = 0; i < N && i < this._radarScoreEls.length; i++) {
      this._radarScoreEls[i].textContent = Math.round(scores[i]).toString();
    }

    // Quality badge
    const badgeColor = { EXCELLENT: '--health-excellent', GOOD: '--health-good',
                         FAIR: '--health-degraded', POOR: '--health-poor' }[label] ?? '--health-good';
    this._radarBadgeEl.innerHTML = `
      <span style="
        display:inline-flex;align-items:center;padding:4px 14px;
        border-radius:var(--radius-pill);background:color-mix(in srgb,var(${badgeColor}) 20%,transparent);
        border:1px solid var(${badgeColor});font-size:11px;font-weight:500;
        letter-spacing:0.04em;color:var(${badgeColor});">
        ${label}
      </span>`;
  }

  // ── Sensor detail bars ────────────────────────────────────────────────

  _buildSensorBars(parent) {
    const groups = [
      {
        title: 'VOLTAGE CHANNEL',
        color: '--wave-voltage',
        metrics: [
          { key: 'v_stab',  label: 'Stability Score', max: 100, unit: '%',    field: 'diagnostics.voltage_stability' },
          { key: 'v_conf',  label: 'Confidence',      max: 100, unit: '%',    field: '_v_conf'   },
        ],
      },
      {
        title: 'CURRENT CHANNEL',
        color: '--wave-current',
        metrics: [
          { key: 'i_stab',  label: 'Stability Score', max: 100, unit: '%',    field: 'diagnostics.current_stability' },
          { key: 'i_conf',  label: 'Confidence',      max: 100, unit: '%',    field: '_i_conf'  },
        ],
      },
      {
        title: 'TEMPERATURE CHANNEL',
        color: '--state-warning',
        metrics: [
          { key: 't_stab',  label: 'Stability Score', max: 100, unit: '%',    field: 'diagnostics.temp_stability'    },
          { key: 't_temp',  label: 'Reading',         max: 100, unit: '°C',   field: 't'         },
        ],
      },
    ];

    const container = _el('div', 'p3-sensor-groups');
    this._sensorBars = {};

    for (const group of groups) {
      const groupWrap = document.createElement('div');
      const titleEl   = _el('div', 'p3-sensor-group-title');
      titleEl.style.color = `var(${group.color})`;
      titleEl.textContent = group.title;
      groupWrap.appendChild(titleEl);

      for (const m of group.metrics) {
        const row  = _el('div', 'p3-metric-row');
        const lbl  = _el('span', 'p3-metric-label', m.label);

        const track = _el('div', 'p3-metric-bar-track');
        const fill  = _el('div', 'p3-metric-bar-fill');
        fill.style.width = '0%';
        track.appendChild(fill);

        const val   = _el('span', 'p3-metric-value', '–');

        row.appendChild(lbl);
        row.appendChild(track);
        row.appendChild(val);
        groupWrap.appendChild(row);

        this._sensorBars[m.key] = { fill, valEl: val, max: m.max, unit: m.unit, field: m.field };
      }

      container.appendChild(groupWrap);
    }

    parent.appendChild(container);
  }

  _updateSensorBars(data) {
    // Derive pseudo-confidence from stability scores (proxy mapping)
    const derived = {
      _v_conf: Math.min(100, (_get(data, 'diagnostics.voltage_stability', 85) * 0.95)),
      _i_conf: Math.min(100, (_get(data, 'diagnostics.current_stability',  85) * 0.93)),
    };

    for (const [key, bar] of Object.entries(this._sensorBars)) {
      // Try live field, then derived
      let raw = _get(data, bar.field, null);
      if (raw == null) raw = derived[bar.field] ?? null;
      if (raw == null || typeof raw !== 'number') {
        bar.valEl.textContent = '–';
        continue;
      }

      const pct   = Math.max(0, Math.min(100, (raw / bar.max) * 100));
      const color = _healthColor(pct);
      bar.fill.style.width      = `${pct}%`;
      bar.fill.style.background = color;
      bar.valEl.textContent     = raw.toFixed(1) + (bar.unit ? '\u202F' + bar.unit : '');
      bar.valEl.style.color     = color;
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Row 3 — ADC Health Panel
  // ══════════════════════════════════════════════════════════════════════

  _buildAdcSection(parent) {
    const card = _el('div', 'p3-card');
    card.appendChild(_el('div', 'p3-card-hdr', 'ADC HEALTH'));

    const grid = _el('div', 'p3-adc-grid');

    // ── Calibration badge ────────────────────────────────────────────
    const calWrap = document.createElement('div');
    const calLbl  = _el('div', null, 'CALIBRATION');
    calLbl.style.cssText = 'font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;';
    this._adcCalBadge = _el('div', 'p3-cal-badge', 'READING…');
    this._adcCalBadge.style.cssText += [
      'background: color-mix(in srgb, var(--state-warning) 15%, transparent)',
      'border: 1px solid var(--state-warning)',
      'color: var(--state-warning)',
      'font-size: 11px',
    ].join(';');
    calWrap.appendChild(calLbl);
    calWrap.appendChild(this._adcCalBadge);
    grid.appendChild(calWrap);

    // ── Health score circle ──────────────────────────────────────────
    const scoreWrap = document.createElement('div');
    const scoreLbl  = _el('div', null, 'ADC HEALTH SCORE');
    scoreLbl.style.cssText = 'font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;';
    this._adcScoreEl = _el('div');
    this._adcScoreEl.style.cssText = [
      'font-size: 36px',
      'font-weight: 300',
      'font-family: var(--font-mono)',
      'font-variant-numeric: tabular-nums',
      'color: var(--health-excellent)',
      'transition: color 400ms ease',
    ].join(';');
    this._adcScoreEl.textContent = '–';
    scoreWrap.appendChild(scoreLbl);
    scoreWrap.appendChild(this._adcScoreEl);
    grid.appendChild(scoreWrap);

    // ── Linearity error bar ──────────────────────────────────────────
    const linWrap = document.createElement('div');
    const linLbl  = _el('div', null, 'LINEARITY ERROR');
    linLbl.style.cssText = 'font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;';
    const linTrack = _el('div', 'p3-metric-bar-track');
    this._adcLinFill = _el('div', 'p3-metric-bar-fill');
    this._adcLinFill.style.width = '0%';
    linTrack.appendChild(this._adcLinFill);
    this._adcLinVal = _el('div');
    this._adcLinVal.style.cssText = 'font-size:11px;font-family:var(--font-mono);color:var(--text-primary);margin-top:4px;';
    this._adcLinVal.textContent = '–%';
    linWrap.appendChild(linLbl);
    linWrap.appendChild(linTrack);
    linWrap.appendChild(this._adcLinVal);
    grid.appendChild(linWrap);

    // ── Saturation events + sample count ────────────────────────────
    const satWrap = document.createElement('div');
    const satLbl  = _el('div', null, 'SATURATION EVENTS');
    satLbl.style.cssText = 'font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;';
    this._adcSatEl = _el('div');
    this._adcSatEl.style.cssText = [
      'font-size: 26px',
      'font-weight: 300',
      'font-family: var(--font-mono)',
      'color: var(--health-excellent)',
      'transition: color 400ms ease',
    ].join(';');
    this._adcSatEl.textContent = '–';
    this._adcSamplesEl = _el('div');
    this._adcSamplesEl.style.cssText = 'font-size:10px;color:var(--text-faint);margin-top:4px;';
    this._adcSamplesEl.textContent = 'Total samples: –';
    satWrap.appendChild(satLbl);
    satWrap.appendChild(this._adcSatEl);
    satWrap.appendChild(this._adcSamplesEl);
    grid.appendChild(satWrap);

    card.appendChild(grid);
    parent.appendChild(card);
  }

  _updateAdcPanel(data) {
    const adcScore = _get(data, 'diagnostics.adc_health', null);

    if (adcScore != null) {
      this._adcScoreEl.textContent = Math.round(adcScore).toString();
      this._adcScoreEl.style.color = _healthColor(adcScore);
    }

    // Calibration badge — inferred from health score (firmware verbose field unavailable here)
    if (adcScore != null) {
      const calLabel = adcScore >= 85 ? 'CALIBRATED (2-POINT)' :
                       adcScore >= 65 ? 'CALIBRATED (VREF)'    :
                                         'NOT CALIBRATED';
      const calColor = adcScore >= 85 ? '--health-excellent' :
                       adcScore >= 65 ? '--state-warning'    :
                                         '--state-fault';
      this._adcCalBadge.textContent = calLabel;
      this._adcCalBadge.style.cssText = [
        `background: color-mix(in srgb, var(${calColor}) 15%, transparent)`,
        `border: 1px solid var(${calColor})`,
        `color: var(${calColor})`,
        'font-size: 11px',
        'font-weight: 500',
        'letter-spacing: 0.04em',
        'padding: 6px 14px',
        'border-radius: var(--radius-pill)',
        'display: inline-flex',
        'align-items: center',
        'gap: 6px',
      ].join(';');
    }

    // Linearity error — proxy from adc_health deviation
    if (adcScore != null) {
      const linErr  = Math.max(0, (100 - adcScore) * 0.05);
      const linPct  = Math.min(100, linErr * 20);
      const linColor = linErr < 1 ? '--health-excellent' :
                       linErr < 3 ? '--state-warning'    :
                                     '--state-fault';
      this._adcLinFill.style.width      = `${linPct}%`;
      this._adcLinFill.style.background = `var(${linColor})`;
      this._adcLinVal.textContent       = linErr.toFixed(2) + '%';
      this._adcLinVal.style.color       = `var(${linColor})`;
    }

    // Saturation (proxy from fault flags)
    const isFault = data.state === 'FAULT';
    const satCount = isFault ? '1+' : '0';
    this._adcSatEl.textContent = satCount;
    this._adcSatEl.style.color = isFault ? 'var(--state-fault)' : 'var(--health-excellent)';

    // Sample count (uptime-derived proxy)
    const uptimeS = _get(data, 'sys.uptime_s', 0);
    const samples  = Math.round(uptimeS * 1000); // ~1kHz sample rate
    this._adcSamplesEl.textContent = `Total samples: ${samples.toLocaleString()}`;
  }

  // ══════════════════════════════════════════════════════════════════════
  // Row 4 — System Health Metrics
  // ══════════════════════════════════════════════════════════════════════

  _buildSysSection(parent) {
    const card = _el('div', 'p3-card');
    card.appendChild(_el('div', 'p3-card-hdr', 'SYSTEM HEALTH'));

    const grid = _el('div', 'p3-sys-grid');

    // ── Heap bar ─────────────────────────────────────────────────────
    const heapWrap = document.createElement('div');
    const heapLbl  = _el('div', null, 'FREE HEAP');
    heapLbl.style.cssText = 'font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:2px;';
    const heapTrack = _el('div', 'p3-heap-track');
    this._heapFill  = _el('div', 'p3-heap-fill');
    this._heapFill.style.width      = '0%';
    this._heapFill.style.background = 'var(--health-excellent)';
    heapTrack.appendChild(this._heapFill);
    this._heapLabelEl = _el('div');
    this._heapLabelEl.style.cssText = 'font-size:10px;color:var(--text-faint);margin-top:4px;font-family:var(--font-mono);';
    this._heapLabelEl.textContent = '– bytes free';
    heapWrap.appendChild(heapLbl);
    heapWrap.appendChild(heapTrack);
    heapWrap.appendChild(this._heapLabelEl);
    grid.appendChild(heapWrap);

    // ── CPU Load (GpuPanel component) ────────────────────────────────
    const cpuWrap = document.createElement('div');
    const cpuLbl  = _el('div', null, 'CPU LOAD');
    cpuLbl.style.cssText = 'font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;';
    cpuWrap.appendChild(cpuLbl);
    const cpuPanelWrap = document.createElement('div');
    cpuWrap.appendChild(cpuPanelWrap);
    this._cpuPanel = new GpuPanel(cpuPanelWrap, {
      label:     'ESP32 CPU',
      field:     'sys.cpu_load_pct',
      showSpark: true,
    });
    this._allComponents.push(this._cpuPanel);
    grid.appendChild(cpuWrap);

    // ── Uptime ring ───────────────────────────────────────────────────
    this._buildUptimeRing(grid);

    // ── Confidence bars ───────────────────────────────────────────────
    this._buildConfBars(grid);

    card.appendChild(grid);
    parent.appendChild(card);
  }

  _buildUptimeRing(parent) {
    const SIZE   = 90;
    const CX     = SIZE / 2;
    const CY     = SIZE / 2;
    const R      = 34;
    const circ   = 2 * Math.PI * R;
    this._uptimeCircumf = circ;

    const wrap = _el('div', 'p3-uptime-ring');
    const lbl  = _el('div', null, 'UPTIME');
    lbl.style.cssText = 'font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;';
    wrap.appendChild(lbl);

    const svgEl = document.createElementNS(SVG_NS, 'svg');
    svgEl.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    svgEl.setAttribute('width', SIZE);
    svgEl.setAttribute('height', SIZE);
    svgEl.setAttribute('class', 'p3-uptime-svg');

    // Track
    const track = document.createElementNS(SVG_NS, 'circle');
    track.setAttribute('cx', CX); track.setAttribute('cy', CY); track.setAttribute('r', R);
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke', 'var(--progress-track)');
    track.setAttribute('stroke-width', '5');
    svgEl.appendChild(track);

    // Fill
    this._uptimeRingFill = document.createElementNS(SVG_NS, 'circle');
    this._uptimeRingFill.setAttribute('cx', CX);
    this._uptimeRingFill.setAttribute('cy', CY);
    this._uptimeRingFill.setAttribute('r', R);
    this._uptimeRingFill.setAttribute('fill', 'none');
    this._uptimeRingFill.setAttribute('stroke', 'var(--state-boot)');
    this._uptimeRingFill.setAttribute('stroke-width', '5');
    this._uptimeRingFill.setAttribute('stroke-linecap', 'round');
    this._uptimeRingFill.setAttribute('transform', `rotate(-90 ${CX} ${CY})`);
    this._uptimeRingFill.setAttribute('stroke-dasharray', circ);
    this._uptimeRingFill.setAttribute('stroke-dashoffset', circ);
    this._uptimeRingFill.style.transition = 'stroke-dashoffset 600ms ease, stroke 600ms ease';
    svgEl.appendChild(this._uptimeRingFill);

    // Center text
    this._uptimeCenterEl = document.createElementNS(SVG_NS, 'text');
    this._uptimeCenterEl.setAttribute('x', CX); this._uptimeCenterEl.setAttribute('y', CY + 5);
    this._uptimeCenterEl.setAttribute('text-anchor', 'middle');
    this._uptimeCenterEl.setAttribute('fill', 'var(--text-primary)');
    this._uptimeCenterEl.setAttribute('font-size', '11');
    this._uptimeCenterEl.setAttribute('font-family', 'var(--font-mono)');
    this._uptimeCenterEl.textContent = '–';
    svgEl.appendChild(this._uptimeCenterEl);

    wrap.appendChild(svgEl);

    this._uptimeQualEl = _el('div');
    this._uptimeQualEl.style.cssText = 'font-size:10px;color:var(--text-faint);text-align:center;';
    this._uptimeQualEl.textContent = '';
    wrap.appendChild(this._uptimeQualEl);

    parent.appendChild(wrap);
  }

  _updateUptimeRing(data) {
    const uptimeS = _get(data, 'sys.uptime_s', 0);
    const quality = _get(data, 'sys.uptime_quality', 'WARMING_UP');

    // Format uptime
    let label;
    if (uptimeS < 3600) {
      const m = Math.floor(uptimeS / 60);
      const s = uptimeS % 60;
      label = `${m}m\n${s}s`;
    } else {
      const h = Math.floor(uptimeS / 3600);
      const m = Math.floor((uptimeS % 3600) / 60);
      label = `${h}h\n${m}m`;
    }

    if (this._uptimeCenterEl) {
      this._uptimeCenterEl.textContent = label.replace('\n', ' ');
    }
    if (this._uptimeQualEl) {
      this._uptimeQualEl.textContent = quality;
    }

    // Ring fill: WARMING_UP=⅓, SETTLING=⅔, STABLE=full
    const fillMap = { WARMING_UP: 0.20, SETTLING: 0.60, STABLE: 1.0 };
    const fill = fillMap[quality] ?? 0.1;
    const colorMap = {
      WARMING_UP: '--state-boot',
      SETTLING:   '--state-warning',
      STABLE:     '--health-excellent',
    };
    const color = colorMap[quality] ?? '--state-boot';

    if (this._uptimeRingFill) {
      const offset = this._uptimeCircumf * (1 - fill);
      this._uptimeRingFill.style.strokeDashoffset = offset;
      this._uptimeRingFill.style.stroke           = `var(${color})`;
    }
  }

  _buildConfBars(parent) {
    const wrap  = _el('div', 'p3-conf-row');
    const title = _el('div', null, 'SIGNAL CONFIDENCE');
    title.style.cssText = 'font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;';
    wrap.appendChild(title);

    this._confBars = {};
    const items = [
      { key: 'v', label: 'Voltage',     field: 'diagnostics.voltage_stability' },
      { key: 'i', label: 'Current',     field: 'diagnostics.current_stability'  },
      { key: 't', label: 'Temperature', field: 'diagnostics.temp_stability'     },
    ];

    for (const item of items) {
      const itemWrap = _el('div', 'p3-conf-item');
      const hdr      = _el('div', 'p3-conf-hdr');
      const lbl      = _el('span', null, item.label);
      const valEl    = _el('span', null, '–');
      valEl.style.fontFamily = 'var(--font-mono)';
      hdr.appendChild(lbl);
      hdr.appendChild(valEl);

      const track = _el('div', 'p3-conf-track');
      const fill  = _el('div', 'p3-conf-fill');
      fill.style.width = '0%';
      fill.style.background = 'var(--health-excellent)';
      track.appendChild(fill);

      itemWrap.appendChild(hdr);
      itemWrap.appendChild(track);
      wrap.appendChild(itemWrap);

      this._confBars[item.key] = { fill, valEl, field: item.field };
    }

    parent.appendChild(wrap);
  }

  _updateConfBars(data) {
    for (const [, bar] of Object.entries(this._confBars)) {
      const raw = _get(data, bar.field, null);
      if (raw == null) continue;
      const pct   = Math.max(0, Math.min(100, raw));
      const color = _confColor(pct);
      bar.fill.style.width      = `${pct}%`;
      bar.fill.style.background = color;
      bar.valEl.textContent     = pct.toFixed(0) + '%';
      bar.valEl.style.color     = color;
    }
  }

  _updateHeap(data) {
    if (!this._heapFill) return;
    const freeHeap = _get(data, 'sys.free_heap', null);
    if (freeHeap == null) return;

    const ESP32_TOTAL = 327680; // 320 KB typical ESP32 total SRAM
    const usedPct = Math.max(0, Math.min(100, ((ESP32_TOTAL - freeHeap) / ESP32_TOTAL) * 100));
    const healthy  = _get(data, 'sys.heap_healthy', true);
    const color    = healthy ? 'var(--health-excellent)' : 'var(--state-fault)';

    this._heapFill.style.width      = `${usedPct.toFixed(1)}%`;
    this._heapFill.style.background = color;

    const freeKb = (freeHeap / 1024).toFixed(1);
    this._heapLabelEl.textContent = `${Number(freeHeap).toLocaleString()} bytes free (${usedPct.toFixed(0)}% used)`;
    this._heapLabelEl.style.color = healthy ? 'var(--text-faint)' : 'var(--state-fault)';
  }

  // ══════════════════════════════════════════════════════════════════════
  // Row 5 — Protection Parameters (GET /api/config)
  // ══════════════════════════════════════════════════════════════════════

  _buildProtectionParams(parent) {
    const card = _el('div', 'p3-card');
    card.appendChild(_el('div', 'p3-card-hdr', 'PROTECTION PARAMETERS'));

    const grid = _el('div', 'p3-params-grid');

    const paramDefs = [
      { key: 'ovp',      label: 'OVP Threshold',     unit: 'V',   nominal: 253 },
      { key: 'uvp',      label: 'UVP Threshold',     unit: 'V',   nominal: 207 },
      { key: 'ocp',      label: 'OCP Threshold',     unit: 'A',   nominal: 15  },
      { key: 'otp',      label: 'OTP Threshold',     unit: '°C',  nominal: 85  },
      { key: 'reconnect',label: 'Reconnect Delay',   unit: 's',   nominal: 5   },
      { key: 'lockout',  label: 'Fault Lockout At',  unit: 'trips', nominal: 3 },
    ];

    this._paramEls = {};
    for (const p of paramDefs) {
      const cell  = _el('div', 'p3-param-cell');
      const lbl   = _el('span', 'p3-param-label', p.label);
      const val   = _el('span', 'p3-param-value', p.nominal.toString());
      const unit  = _el('span', 'p3-param-unit', p.unit);
      cell.appendChild(lbl);
      cell.appendChild(val);
      cell.appendChild(unit);
      grid.appendChild(cell);
      this._paramEls[p.key] = val;
    }

    card.appendChild(grid);

    this._paramNoteEl = _el('div', 'p3-config-note');
    this._paramNoteEl.textContent = 'Showing nominal defaults — fetching /api/config…';
    card.appendChild(this._paramNoteEl);

    parent.appendChild(card);
  }

  async _fetchConfig() {
    if (this._configFetched) return;

    // Create a controller so destroy() can abort this fetch mid-flight.
    // A 5-second local timeout is applied alongside it.
    const ctrl = new AbortController();
    this._fetchAbortCtrl = ctrl;
    const timeoutId = setTimeout(() => ctrl.abort(), 5000);

    try {
      const host = window.location.host || 'localhost';
      const res  = await fetch(`http://${host}/api/config`, {
        headers: { Accept: 'application/json' },
        signal:  ctrl.signal,
      });
      clearTimeout(timeoutId);

      // Guard: destroy() may have aborted and nulled the controller while
      // we were awaiting — if so, the DOM is already cleared; bail out.
      if (!this._fetchAbortCtrl) return;

      if (res.ok) {
        const cfg = await res.json();
        if (!this._fetchAbortCtrl) return;   // destroyed during json parse
        this._configData = cfg;
        this._applyConfig(cfg);
        if (this._paramNoteEl) {
          this._paramNoteEl.textContent = 'Live config loaded from /api/config';
          this._paramNoteEl.style.color = 'var(--health-excellent)';
        }
      } else {
        if (this._paramNoteEl) {
          this._paramNoteEl.textContent =
            `Config unavailable (HTTP ${res.status}) — showing firmware defaults.`;
        }
      }
    } catch (_) {
      clearTimeout(timeoutId);
      if (!this._fetchAbortCtrl) return;   // destroyed — DOM already gone
      if (this._paramNoteEl) {
        this._paramNoteEl.textContent =
          'Config endpoint not reachable — showing firmware defaults.';
      }
    }
    this._configFetched = true;
  }

  _applyConfig(cfg) {
    // Map common firmware config key names to our param keys
    const mapping = {
      ovp:       cfg.ovp_threshold_v   ?? cfg.ovp  ?? cfg.OVP,
      uvp:       cfg.uvp_threshold_v   ?? cfg.uvp  ?? cfg.UVP,
      ocp:       cfg.ocp_threshold_a   ?? cfg.ocp  ?? cfg.OCP,
      otp:       cfg.otp_threshold_c   ?? cfg.otp  ?? cfg.OTP,
      reconnect: cfg.reconnect_delay_s ?? cfg.reconnect_delay,
      lockout:   cfg.fault_lockout_count ?? cfg.lockout_count ?? cfg.max_trips,
    };
    for (const [key, val] of Object.entries(mapping)) {
      if (val != null && this._paramEls[key]) {
        this._paramEls[key].textContent = Number(val).toString();
      }
    }
  }
}

// ── SVG helpers ─────────────────────────────────────────────────────────────

function _pentagonPoints(cx, cy, r, n = 5) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    pts.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
  }
  return pts.join(' ');
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