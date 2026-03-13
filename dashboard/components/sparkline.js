/**
 * sparkline.js — Smart Grid Sentinel Sparkline Bar Chart Component
 * Phase 3 deliverable. DESIGN.md §5.8, §17, §18.
 *
 * Canvas sparkline bar chart. Reads from telemetryBuffer.getSparkline(field).
 * Updated at 1 Hz by the page (called from update()) — NOT from animationLoop.
 * This matches the sparkline buffer's 0.5–1 Hz effective update rate.
 *
 * Rendering: ALL canvas draw calls via canvasEngine.drawSparkline() — zero ctx.*.
 *
 * Component interface (DESIGN.md §17):
 *   constructor(containerEl, options)
 *   update(telemetryData)
 *   destroy()
 *
 * Options:
 *   field    {string}  — buffer field to read ('v', 'i', 't', 'p')
 *   label    {string}  — display label
 *   unit     {string}  — unit string
 *   min      {number}  — Y-axis min (optional — auto if omitted)
 *   max      {number}  — Y-axis max (optional — auto if omitted)
 */

import { setupCanvas, clearCanvas, drawSparkline } from '../rendering/canvasEngine.js';
import { getSparkline }                            from '../telemetry/telemetryBuffer.js';

export class Sparkline {
  /**
   * @param {HTMLElement} containerEl
   * @param {object}      options
   */
  constructor(containerEl, options = {}) {
    this._container = containerEl;
    this._opts = {
      field: options.field ?? 'v',
      label: options.label ?? 'value',
      unit:  options.unit  ?? '',
      min:   options.min,    // undefined → auto
      max:   options.max,    // undefined → auto
    };

    this._ctx = null;
    this._buildDOM();

    // Resize observer keeps canvas DPR-correct
    this._resizeObserver = new ResizeObserver(() => this._setupCanvas());
    this._resizeObserver.observe(this._container);
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  _buildDOM() {
    // Label row above the chart
    const header = document.createElement('div');
    header.style.cssText = [
      'display: flex',
      'justify-content: space-between',
      'align-items: baseline',
      'margin-bottom: 6px',
    ].join(';');

    this._labelEl = document.createElement('span');
    this._labelEl.style.cssText = [
      'font-size: var(--text-label)',
      'color: var(--text-muted)',
      'text-transform: uppercase',
      'letter-spacing: 0.06em',
    ].join(';');
    this._labelEl.textContent = this._opts.label;

    this._valueEl = document.createElement('span');
    this._valueEl.style.cssText = [
      'font-size: var(--text-label)',
      'color: var(--text-primary)',
      'font-variant-numeric: tabular-nums',
    ].join(';');
    this._valueEl.textContent = '–';

    header.appendChild(this._labelEl);
    header.appendChild(this._valueEl);

    // Canvas for the bar chart
    this._canvas = document.createElement('canvas');
    this._canvas.style.cssText = [
      'display: block',
      'width: 100%',
      'height: 40px',
    ].join(';');

    // Unit label below
    const unitEl = document.createElement('span');
    unitEl.style.cssText = [
      'display: block',
      'font-size: var(--text-micro)',
      'color: var(--text-faint)',
      'margin-top: 4px',
    ].join(';');
    unitEl.textContent = this._opts.unit;
    this._unitEl = unitEl;

    this._container.appendChild(header);
    this._container.appendChild(this._canvas);
    this._container.appendChild(unitEl);

    requestAnimationFrame(() => this._setupCanvas());
  }

  _setupCanvas() {
    if (!this._container.offsetWidth) return;
    this._ctx = setupCanvas(this._canvas, this._canvas);
    // Force a redraw immediately after resize
    this._draw();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Called by the page at 1 Hz.
   * @param {object} telemetryData — canonical telemetry object (not directly used for bars,
   *                                 but used to update the live value label)
   */
  update(telemetryData) {
    // Update the latest value display
    const fieldMap = { v: 'v', i: 'i', t: 't', p: 'p' };
    const raw = telemetryData?.[fieldMap[this._opts.field]];
    if (raw != null) {
      const decimals = this._opts.field === 'p' ? 0 : 1;
      this._valueEl.textContent = Number(raw).toFixed(decimals) + ' ' + this._opts.unit;
    }

    // Redraw bars from buffer
    this._draw();
  }

  /**
   * No animationLoop subscription — cleanup only needs to disconnect ResizeObserver.
   */
  destroy() {
    this._resizeObserver.disconnect();
  }

  // ── Internal draw ─────────────────────────────────────────────────────────

  _draw() {
    if (!this._ctx) return;

    const data = getSparkline(this._opts.field);
    clearCanvas(this._ctx);

    if (data.length === 0) return;

    drawSparkline(this._ctx, data, {
      activeColor:   '--bar-active',
      inactiveColor: '--bar-inactive',
      barWidth:      3,
      barGap:        2,
      min:           this._opts.min,
      max:           this._opts.max,
      activeCount:   1,
    });
  }
}
