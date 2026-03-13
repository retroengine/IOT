/**
 * page5-analytics.js — Smart Grid Sentinel Analytics Page
 * Phase 5 deliverable. DESIGN.md §12.
 *
 * Historical trend analysis page. All data comes from historyPoller (not the
 * live telemetryBuffer) so that the rendered time range is always coherent.
 *
 * Charts rendered:
 *   1. Voltage over time       — drawLineChart,  --wave-voltage
 *   2. Current over time       — drawLineChart,  --wave-current
 *   3. Temperature over time   — drawLineChart,  --state-warning
 *   4. Power over time         — drawAreaChart,  --health-excellent
 *   5. Power Factor bars       — drawPowerFactorBar
 *   6. Fault event timeline    — drawFaultTimeline
 *
 * Features:
 *   - Time range pill selectors: 1H · 6H · 24H · 7D · 30D + custom range
 *   - Hover tooltips on all time-series charts (exact value + formatted ts)
 *   - Lazy load: only fetches when Page Visibility API reports tab visible
 *   - CSV export for each individual chart's current data
 *
 * Page interface (DESIGN.md §17):
 *   mount(containerEl)   — build DOM, fetch initial data (1H default)
 *   update(telemetryData) — no-op (analytics page is not live-updating)
 *   destroy()            — cancel pending fetches, remove event listeners
 */

import { fetchHistoryMulti } from '../telemetry/historyPoller.js';
import {
  setupCanvas,
  clearCanvas,
  drawLineChart,
  drawAreaChart,
  drawBarChart,
  drawPowerFactorBar,
  drawFaultTimeline,
  hitTestTimeSeries,
  drawNoData,
} from '../rendering/canvasEngine.js';

// ── Time range definitions ────────────────────────────────────────────────
const TIME_RANGES = [
  { label: '1H',   ms: 3_600_000 },
  { label: '6H',   ms: 21_600_000 },
  { label: '24H',  ms: 86_400_000 },
  { label: '7D',   ms: 604_800_000 },
  { label: '30D',  ms: 2_592_000_000 },
];

// Resolution: target number of data points per chart
const RESOLUTION = 200;

// ── Tooltip formatting ────────────────────────────────────────────────────

function _formatTs(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month:  'short', day: 'numeric',
    hour:   '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function _fmtValue(value, unit) {
  if (typeof value !== 'number') return '–';
  const dp = (unit === 'W' || unit === 'Wh') ? 0 : 2;
  return value.toFixed(dp) + (unit ? ` ${unit}` : '');
}

// ── CSV export ────────────────────────────────────────────────────────────

/**
 * Trigger a browser download of historical data as UTF-8 CSV.
 * Format: timestamp,field,value
 *
 * @param {Array<{ts: number, value: number}>} data
 * @param {string} field
 * @param {string} unit
 */
function _downloadCSV(data, field, unit) {
  if (!data || data.length === 0) return;

  const rows = ['timestamp,field,value'];
  for (const { ts, value } of data) {
    rows.push(`${new Date(ts).toISOString()},${field},${value}`);
  }

  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `sgs_${field}_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ══════════════════════════════════════════════════════════════════════════
// ChartPanel — reusable canvas panel with header, canvas, tooltip, export
// ══════════════════════════════════════════════════════════════════════════

/**
 * Self-contained chart panel: header + canvas + tooltip overlay.
 * The rendering function is passed in so each chart is independently typed.
 *
 * Lifecycle:
 *   panel.setData(data)   — provide data, triggers redraw
 *   panel.destroy()       — remove listeners, disconnect ResizeObserver
 */
class ChartPanel {
  /**
   * @param {HTMLElement} containerEl
   * @param {object} opts
   * @param {string}   opts.title       — card header title
   * @param {string}   opts.field       — field key (for CSV export label)
   * @param {string}   opts.unit        — unit suffix for tooltip
   * @param {string}   [opts.chartType] — 'line' | 'area' | 'bar' | 'pf' | 'fault'
   * @param {object}   [opts.drawOpts]  — passed to the draw function
   * @param {number}   [opts.height]    — canvas height in px (default 180)
   */
  constructor(containerEl, opts) {
    this._container = containerEl;
    this._title     = opts.title;
    this._field     = opts.field;
    this._unit      = opts.unit     || '';
    this._chartType = opts.chartType || 'line';
    this._drawOpts  = opts.drawOpts  || {};
    this._height    = opts.height    || 180;

    this._data       = null;
    this._ctx        = null;
    this._tooltipIdx = null;  // active hover data index

    this._buildDOM();

    this._resizeObserver = new ResizeObserver(() => this._setupCanvas());
    this._resizeObserver.observe(this._canvasEl);
  }

  _buildDOM() {
    // Card wrapper
    this._card = document.createElement('div');
    this._card.style.cssText = [
      'background: var(--bg-card-dark)',
      'border-radius: var(--radius-md)',
      'padding: var(--space-md)',
      'display: flex',
      'flex-direction: column',
      'gap: 10px',
      'position: relative',
    ].join(';');

    // Header row
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';

    const titleEl = document.createElement('span');
    titleEl.style.cssText = [
      'font-size: var(--text-label)',
      'color: var(--text-muted)',
      'text-transform: uppercase',
      'letter-spacing: 0.06em',
    ].join(';');
    titleEl.textContent = this._title;

    // Export CSV button
    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'CSV ↓';
    exportBtn.style.cssText = [
      'background: var(--bg-week-pill)',
      'border: 1px solid var(--border-pill)',
      'border-radius: var(--radius-pill)',
      'color: var(--text-muted)',
      'font-size: var(--text-micro)',
      'padding: 3px 10px',
      'cursor: pointer',
      'transition: color 150ms ease',
    ].join(';');
    exportBtn.addEventListener('mouseenter', () => { exportBtn.style.color = 'var(--text-primary)'; });
    exportBtn.addEventListener('mouseleave', () => { exportBtn.style.color = 'var(--text-muted)'; });
    exportBtn.addEventListener('click', () => _downloadCSV(this._data, this._field, this._unit));

    header.appendChild(titleEl);
    header.appendChild(exportBtn);

    // Canvas wrapper for relative positioning of tooltip
    this._canvasWrapper = document.createElement('div');
    this._canvasWrapper.style.cssText = `position:relative;height:${this._height}px;`;

    // Canvas element
    this._canvasEl = document.createElement('canvas');
    this._canvasEl.className = 'waveform-grid';
    this._canvasEl.style.cssText = [
      'display: block',
      'width: 100%',
      `height: ${this._height}px`,
      'border-radius: var(--radius-sm)',
      'cursor: crosshair',
    ].join(';');

    // Tooltip overlay
    this._tooltipEl = document.createElement('div');
    this._tooltipEl.style.cssText = [
      'position: absolute',
      'background: var(--bg-card-dark-2)',
      'border: 1px solid var(--border-subtle)',
      'border-radius: var(--radius-sm)',
      'padding: 6px 10px',
      'font-size: var(--text-micro)',
      'color: var(--text-primary)',
      'pointer-events: none',
      'white-space: nowrap',
      'z-index: 10',
      'opacity: 0',
      'transition: opacity 150ms ease',
      'font-variant-numeric: tabular-nums',
    ].join(';');

    // Loading overlay
    this._loadingEl = document.createElement('div');
    this._loadingEl.style.cssText = [
      'position: absolute',
      'inset: 0',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'color: var(--text-faint)',
      'font-size: var(--text-micro)',
      'background: var(--bg-card-dark)',
      'border-radius: var(--radius-sm)',
      'letter-spacing: 0.04em',
    ].join(';');
    this._loadingEl.textContent = 'LOADING…';

    this._canvasWrapper.appendChild(this._canvasEl);
    this._canvasWrapper.appendChild(this._tooltipEl);
    this._canvasWrapper.appendChild(this._loadingEl);

    this._card.appendChild(header);
    this._card.appendChild(this._canvasWrapper);
    this._container.appendChild(this._card);

    // Mouse events for tooltip
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseLeave = this._onMouseLeave.bind(this);
    this._canvasEl.addEventListener('mousemove', this._onMouseMove);
    this._canvasEl.addEventListener('mouseleave', this._onMouseLeave);

    // Perform initial canvas setup after layout
    requestAnimationFrame(() => this._setupCanvas());
  }

  _setupCanvas() {
    if (!this._canvasWrapper.offsetWidth) return;
    this._ctx = setupCanvas(this._canvasEl, this._canvasWrapper);
    this._redraw();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  setData(data) {
    this._data = data;
    this._loadingEl.style.display = 'none';
    this._redraw();
  }

  setLoading(isLoading) {
    this._loadingEl.style.display = isLoading ? 'flex' : 'none';
  }

  destroy() {
    this._resizeObserver.disconnect();
    this._canvasEl.removeEventListener('mousemove', this._onMouseMove);
    this._canvasEl.removeEventListener('mouseleave', this._onMouseLeave);
  }

  // ── Internal ────────────────────────────────────────────────────────────

  _redraw() {
    if (!this._ctx) return;
    clearCanvas(this._ctx);

    if (!this._data || this._data.length === 0) {
      this._drawNoData();
      return;
    }

    const tooltipInfo = this._tooltipIdx !== null
      ? { dataIndex: this._tooltipIdx }
      : null;

    switch (this._chartType) {
      case 'line':
        drawLineChart(this._ctx, this._data, { ...this._drawOpts, tooltip: tooltipInfo });
        break;
      case 'area':
        drawAreaChart(this._ctx, this._data, { ...this._drawOpts, tooltip: tooltipInfo });
        break;
      case 'bar':
        drawBarChart(this._ctx, this._data, { ...this._drawOpts });
        break;
      case 'pf':
        drawPowerFactorBar(this._ctx, this._data, { ...this._drawOpts });
        break;
      case 'fault':
        drawFaultTimeline(this._ctx, this._data, { ...this._drawOpts });
        break;
    }
  }

  _drawNoData() {
    if (!this._ctx) return;
    clearCanvas(this._ctx);
    drawNoData(this._ctx);
  }

  _onMouseMove(event) {
    if (!this._data || this._data.length === 0) return;
    if (this._chartType !== 'line' && this._chartType !== 'area') return;

    const dpr = window.devicePixelRatio || 1;
    const w   = this._canvasEl.width / dpr;
    const timestamps = this._data.map(d => d.ts);
    const hit = hitTestTimeSeries(event, timestamps, w);

    if (!hit) {
      this._clearTooltip();
      return;
    }

    if (this._tooltipIdx !== hit.dataIndex) {
      this._tooltipIdx = hit.dataIndex;
      this._redraw();
    }

    const point = this._data[hit.dataIndex];
    this._showTooltip(event, point);
  }

  _onMouseLeave() {
    this._clearTooltip();
  }

  _showTooltip(event, point) {
    const rect   = this._canvasWrapper.getBoundingClientRect();
    let   left   = event.clientX - rect.left + 12;
    let   top    = event.clientY - rect.top  - 24;

    // Keep tooltip inside card
    const ttW = 160;
    if (left + ttW > rect.width - 8) left = left - ttW - 24;
    if (top < 0) top = 4;

    this._tooltipEl.style.left    = `${left}px`;
    this._tooltipEl.style.top     = `${top}px`;
    this._tooltipEl.style.opacity = '1';
    this._tooltipEl.innerHTML = [
      `<span style="color:var(--text-muted)">${_formatTs(point.ts)}</span>`,
      `<br><strong>${_fmtValue(point.value, this._unit)}</strong>`,
    ].join('');
  }

  _clearTooltip() {
    if (this._tooltipIdx === null) return;
    this._tooltipIdx = null;
    this._tooltipEl.style.opacity = '0';
    this._redraw();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Page5Analytics — main page class
// ══════════════════════════════════════════════════════════════════════════

export class Page5Analytics {
  // ── Page lifecycle ────────────────────────────────────────────────────────

  mount(containerEl) {
    this._container = containerEl;
    this._panels    = [];        // ChartPanel instances — for cleanup
    this._listeners = [];        // [element, type, handler] tuples — for cleanup
    this._abortCtrl = null;      // AbortController for pending fetch group

    // State
    this._activeRange  = TIME_RANGES[0];   // default: 1H
    this._customFrom   = null;
    this._customTo     = null;
    this._historyData  = {};               // { v, i, t, p } from last fetch

    // Page Visibility guard — skip fetch if tab is hidden
    this._onVisibilityChange = this._onVisibilityChange.bind(this);
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    this._listeners.push([document, 'visibilitychange', this._onVisibilityChange]);

    this._buildDOM();

    // Initial data load
    if (!document.hidden) {
      this._loadData();
    }
  }

  /**
   * No-op. Analytics page does not consume live telemetry.
   * @param {object} _telemetryData
   */
  update(_telemetryData) {
    // Intentionally empty — analytics page is decoupled from the live feed.
  }

  destroy() {
    // Cancel any in-flight fetch
    if (this._abortCtrl) {
      this._abortCtrl.abort();
      this._abortCtrl = null;
    }

    // Destroy all ChartPanels (cleans up their ResizeObservers + listeners)
    for (const panel of this._panels) {
      panel.destroy();
    }
    this._panels = [];

    // Remove page-level event listeners
    for (const [el, type, handler] of this._listeners) {
      el.removeEventListener(type, handler);
    }
    this._listeners = [];
  }

  // ── DOM construction ───────────────────────────────────────────────────────

  _buildDOM() {
    this._container.style.cssText = [
      'padding: var(--space-lg)',
      'display: flex',
      'flex-direction: column',
      'gap: var(--space-md)',
      'overflow-y: auto',
    ].join(';');

    this._buildHeader();
    this._buildTimeRangeBar();
    this._buildChartGrid();
  }

  _buildHeader() {
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;';

    const titleEl = document.createElement('h2');
    titleEl.style.cssText = [
      'font-size: var(--text-section)',
      'color: var(--text-primary)',
      'font-weight: 400',
      'margin: 0',
    ].join(';');
    titleEl.textContent = 'Analytics';

    // Status chip — shows "Live" / "Backend offline – buffer data" / "Fetching…"
    this._statusChip = document.createElement('span');
    this._statusChip.style.cssText = [
      'font-size: var(--text-micro)',
      'color: var(--text-faint)',
      'letter-spacing: 0.04em',
    ].join(';');
    this._statusChip.textContent = 'Initialising…';

    header.appendChild(titleEl);
    header.appendChild(this._statusChip);
    this._container.appendChild(header);
  }

  _buildTimeRangeBar() {
    const bar = document.createElement('div');
    bar.style.cssText = [
      'display: flex',
      'align-items: center',
      'gap: var(--space-sm)',
      'flex-wrap: wrap',
    ].join(';');

    // ── Pill selectors ─────────────────────────────────────────────────
    this._pillEls = {};

    for (const range of TIME_RANGES) {
      const pill = document.createElement('button');
      pill.textContent = range.label;
      pill.dataset.range = range.label;
      this._stylePill(pill, range === this._activeRange);

      const handler = () => this._onRangeSelect(range);
      pill.addEventListener('click', handler);
      this._listeners.push([pill, 'click', handler]);

      this._pillEls[range.label] = pill;
      bar.appendChild(pill);
    }

    // ── Separator ─────────────────────────────────────────────────────
    const sep = document.createElement('span');
    sep.style.cssText = 'color:var(--border-subtle);font-size:14px;padding:0 4px;';
    sep.textContent   = '|';
    bar.appendChild(sep);

    // ── Custom range ───────────────────────────────────────────────────
    const customLabel = document.createElement('span');
    customLabel.style.cssText = 'font-size:var(--text-micro);color:var(--text-faint);white-space:nowrap;';
    customLabel.textContent   = 'Custom:';

    this._fromInput = this._makeDateTimeInput();
    this._toInput   = this._makeDateTimeInput();

    const applyBtn = document.createElement('button');
    applyBtn.textContent = 'Apply';
    this._stylePill(applyBtn, false);
    applyBtn.style.color = 'var(--health-excellent)';

    const applyHandler = () => this._onCustomApply();
    applyBtn.addEventListener('click', applyHandler);
    this._listeners.push([applyBtn, 'click', applyHandler]);

    bar.appendChild(customLabel);
    bar.appendChild(this._fromInput);
    bar.appendChild(this._toInput);
    bar.appendChild(applyBtn);

    this._container.appendChild(bar);
  }

  _buildChartGrid() {
    // Main grid: two columns for wide charts, side-by-side for narrower ones
    const grid = document.createElement('div');
    grid.style.cssText = [
      'display: grid',
      'grid-template-columns: 1fr 1fr',
      'gap: var(--space-md)',
    ].join(';');

    // Wide charts span both columns
    const wideStyle = 'grid-column: 1 / -1;';

    // ── 1. Voltage over time (full width) ──────────────────────────────
    const vWrap = document.createElement('div');
    vWrap.style.cssText = wideStyle;
    grid.appendChild(vWrap);
    const voltagePanel = new ChartPanel(vWrap, {
      title:     'Voltage History',
      field:     'v',
      unit:      'V',
      chartType: 'line',
      height:    180,
      drawOpts:  { color: '--wave-voltage', unit: 'V' },
    });
    this._panels.push(voltagePanel);
    this._voltagePanel = voltagePanel;

    // ── 2. Current over time (full width) ─────────────────────────────
    const iWrap = document.createElement('div');
    iWrap.style.cssText = wideStyle;
    grid.appendChild(iWrap);
    const currentPanel = new ChartPanel(iWrap, {
      title:     'Current History',
      field:     'i',
      unit:      'A',
      chartType: 'line',
      height:    160,
      drawOpts:  { color: '--wave-current', unit: 'A' },
    });
    this._panels.push(currentPanel);
    this._currentPanel = currentPanel;

    // ── 3. Temperature over time ───────────────────────────────────────
    const tWrap = document.createElement('div');
    grid.appendChild(tWrap);
    const tempPanel = new ChartPanel(tWrap, {
      title:     'Temperature History',
      field:     't',
      unit:      '°C',
      chartType: 'line',
      height:    160,
      drawOpts:  { color: '--state-warning', unit: '°C' },
    });
    this._panels.push(tempPanel);
    this._tempPanel = tempPanel;

    // ── 4. Power over time ─────────────────────────────────────────────
    const pWrap = document.createElement('div');
    grid.appendChild(pWrap);
    const powerPanel = new ChartPanel(pWrap, {
      title:     'Power History',
      field:     'p',
      unit:      'W',
      chartType: 'area',
      height:    160,
      drawOpts:  { color: '--health-excellent', unit: 'W' },
    });
    this._panels.push(powerPanel);
    this._powerPanel = powerPanel;

    // ── 5. Power Factor bar chart ──────────────────────────────────────
    const pfWrap = document.createElement('div');
    grid.appendChild(pfWrap);
    const pfPanel = new ChartPanel(pfWrap, {
      title:     'Power Factor Distribution',
      field:     'pf',
      unit:      '',
      chartType: 'pf',
      height:    130,
      drawOpts:  {},
    });
    this._panels.push(pfPanel);
    this._pfPanel = pfPanel;

    // ── 6. Fault event timeline ────────────────────────────────────────
    const ftWrap = document.createElement('div');
    grid.appendChild(ftWrap);
    const faultPanel = new ChartPanel(ftWrap, {
      title:     'Fault Events',
      field:     'fault',
      unit:      '',
      chartType: 'fault',
      height:    130,
      drawOpts:  { dotColor: '--fault-active' },
    });
    this._panels.push(faultPanel);
    this._faultPanel = faultPanel;

    this._container.appendChild(grid);
  }

  // ── Time range controls ────────────────────────────────────────────────────

  _onRangeSelect(range) {
    this._activeRange = range;
    this._customFrom  = null;
    this._customTo    = null;

    // Update pill active states
    for (const [label, el] of Object.entries(this._pillEls)) {
      this._stylePill(el, label === range.label);
    }

    this._loadData();
  }

  _onCustomApply() {
    const fromVal = this._fromInput.value;
    const toVal   = this._toInput.value;

    if (!fromVal || !toVal) {
      this._setStatus('Select both start and end dates.', true);
      return;
    }

    const from = new Date(fromVal);
    const to   = new Date(toVal);

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      this._setStatus('Invalid date values.', true);
      return;
    }
    if (from >= to) {
      this._setStatus('Start must be before end.', true);
      return;
    }

    this._customFrom  = from;
    this._customTo    = to;
    this._activeRange = null;

    // Deactivate all preset pills
    for (const el of Object.values(this._pillEls)) {
      this._stylePill(el, false);
    }

    this._loadData();
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  async _loadData() {
    // Lazy: skip while tab is hidden
    if (document.hidden) return;

    // Compute time range
    let fromDate, toDate;
    if (this._customFrom && this._customTo) {
      fromDate = this._customFrom;
      toDate   = this._customTo;
    } else {
      toDate   = new Date();
      fromDate = new Date(toDate.getTime() - (this._activeRange?.ms ?? 3_600_000));
    }

    // Cancel previous fetch group
    if (this._abortCtrl) this._abortCtrl.abort();
    this._abortCtrl = new AbortController();

    // Show loading state on all time-series panels
    this._setStatus('Fetching…');
    for (const panel of this._panels) panel.setLoading(true);

    try {
      // Fetch all primary telemetry fields concurrently
      const historyData = await fetchHistoryMulti(
        ['v', 'i', 't', 'p'],
        fromDate,
        toDate,
        RESOLUTION
      );
      this._historyData = historyData;

      // Determine if we're using real backend data or buffer fallback
      const usingBackend = Object.values(historyData).some(d => d.length > 60);
      this._setStatus(
        usingBackend
          ? `${Object.values(historyData)[0]?.length ?? 0} data points`
          : 'Buffer data — connect analytics backend for full history'
      );

      // Feed panels
      this._voltagePanel.setData(historyData.v);
      this._currentPanel.setData(historyData.i);
      this._tempPanel.setData(historyData.t);
      this._powerPanel.setData(historyData.p);

      // Synthesise Power Factor distribution from power + current + voltage data
      const pfData = this._synthPFData(historyData);
      this._pfPanel.setData(pfData);

      // Synthesise fault event timeline from state transitions in data
      const faultEvents = this._synthFaultEvents(historyData, fromDate, toDate);
      const ftOpts = {
        ...this._faultPanel._drawOpts,
        fromTs: fromDate.getTime(),
        toTs:   toDate.getTime(),
      };
      // Update faultPanel drawOpts with the range timestamps
      this._faultPanel._drawOpts = ftOpts;
      this._faultPanel.setData(faultEvents);

    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('[page5-analytics] loadData error:', err);
        this._setStatus('Fetch error — check console', true);
        for (const panel of this._panels) panel.setLoading(false);
      }
    }
  }

  _onVisibilityChange() {
    // Resume fetch when tab becomes visible, if data is stale
    if (!document.hidden && !this._historyData?.v) {
      this._loadData();
    }
  }

  // ── Data synthesis helpers ─────────────────────────────────────────────────

  /**
   * Build Power Factor distribution data for the PF bar chart.
   * Groups PF estimates (P / (V*I)) from the historical data into 5 buckets.
   *
   * @param {{ v: Array, i: Array, p: Array }} historyData
   * @returns {Array<{label: string, value: number}>}
   */
  _synthPFData(historyData) {
    const { v: vData, i: iData, p: pData } = historyData;
    if (!vData?.length || !iData?.length || !pData?.length) return [];

    // Align by timestamp (use pData as the primary series)
    const aligned = pData.map((pPoint, idx) => {
      const vPoint = vData[Math.min(idx, vData.length - 1)];
      const iPoint = iData[Math.min(idx, iData.length - 1)];
      const apparent = (vPoint?.value ?? 230) * (iPoint?.value ?? 12);
      if (apparent === 0) return null;
      return Math.min(1, Math.max(0, pPoint.value / apparent));
    }).filter(Boolean);

    if (aligned.length === 0) return [];

    // Bucket into 5 ranges: <0.80, 0.80-0.85, 0.85-0.90, 0.90-0.95, >0.95
    const BUCKETS = [
      { label: '<0.80', min: 0,    max: 0.80 },
      { label: '0.80–',  min: 0.80, max: 0.85 },
      { label: '0.85–',  min: 0.85, max: 0.90 },
      { label: '0.90–',  min: 0.90, max: 0.95 },
      { label: '>0.95',  min: 0.95, max: 1.01 },
    ];

    return BUCKETS.map(({ label, min, max }) => {
      const count = aligned.filter(pf => pf >= min && pf < max).length;
      const color = min >= 0.90
        ? '--health-excellent'
        : min >= 0.80
          ? '--state-warning'
          : '--state-fault';
      return { label, value: count, color };
    });
  }

  /**
   * Synthesise fault events by detecting significant voltage deviations.
   * Until a real fault event API is available, this provides meaningful
   * timeline data from the voltage series.
   *
   * @param {{ v: Array }} historyData
   * @param {Date} fromDate
   * @param {Date} toDate
   * @returns {Array<{ts: number, label: string, color: string}>}
   */
  _synthFaultEvents(historyData, fromDate, toDate) {
    const vData = historyData?.v;
    if (!vData || vData.length === 0) return [];

    const events   = [];
    const OV_LIMIT = 240;   // Over voltage threshold (V)
    const UV_LIMIT = 220;   // Under voltage threshold (V)
    let   lastFaultTs = 0;
    const DEBOUNCE_MS = 30_000;  // don't cluster events closer than 30s

    for (const { ts, value } of vData) {
      if (ts - lastFaultTs < DEBOUNCE_MS) continue;

      if (value > OV_LIMIT) {
        events.push({ ts, label: 'OV', color: '--state-fault' });
        lastFaultTs = ts;
      } else if (value < UV_LIMIT) {
        events.push({ ts, label: 'UV', color: '--state-warning' });
        lastFaultTs = ts;
      }
    }

    return events;
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────

  _setStatus(text, isError = false) {
    if (!this._statusChip) return;
    this._statusChip.textContent = text;
    this._statusChip.style.color = isError
      ? 'var(--state-fault)'
      : 'var(--text-faint)';
  }

  _stylePill(el, isActive) {
    el.style.cssText = [
      'border: 1px solid var(--border-pill)',
      'border-radius: var(--radius-pill)',
      'padding: 5px 14px',
      'font-size: var(--text-micro)',
      'cursor: pointer',
      'transition: background-color 150ms ease, color 150ms ease',
      isActive
        ? 'background: var(--health-excellent); color: var(--bg-dashboard);'
        : 'background: var(--bg-week-pill); color: var(--text-primary);',
    ].join(';');
  }

  _makeDateTimeInput() {
    const el = document.createElement('input');
    el.type  = 'datetime-local';
    el.style.cssText = [
      'background: var(--bg-week-pill)',
      'border: 1px solid var(--border-pill)',
      'border-radius: var(--radius-pill)',
      'color: var(--text-primary)',
      'font-size: var(--text-micro)',
      'padding: 4px 10px',
      'cursor: pointer',
      'outline: none',
      // Chromium colourscheme
      'color-scheme: dark',
    ].join(';');
    return el;
  }
}
