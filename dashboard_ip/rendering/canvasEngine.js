/**
 * canvasEngine.js — Smart Grid Sentinel Canvas Rendering Engine
 * Source of truth: DESIGN.md v3.3, Section 18
 * FROZEN after Phase 1. Extend only — never rewrite.
 *
 * Provides shared canvas drawing helpers for all components.
 * Components NEVER call ctx.* directly — all draw calls go through here.
 * devicePixelRatio (DPR) scaling is handled once in this module.
 *
 * Public API:
 *   setupCanvas(canvas, containerEl)           — must call before any draw
 *   clearCanvas(ctx)                           — clear before each frame
 *   drawWaveform(ctx, data, opts)              — oscilloscope waveform
 *   drawSparkline(ctx, data, opts)             — sparkline bar chart
 */

// ── Computed CSS variable reader ──────────────────────────────────────────
// Reads a CSS variable from the document root at call time.
// Components pass variable names (e.g. '--wave-voltage') rather than hex values.
function cssVar(name) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

// ── DPR scaling ───────────────────────────────────────────────────────────

/**
 * Set up a canvas element for DPR-aware rendering.
 * Must be called once per canvas before any draw operations, and again
 * on window resize (components are responsible for calling on resize).
 *
 * After this call:
 *   canvas.width  = containerEl.offsetWidth  * dpr  (physical pixels)
 *   canvas.height = containerEl.offsetHeight * dpr  (physical pixels)
 *   ctx.scale(dpr, dpr) is applied so coordinates remain in CSS pixels.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} containerEl - the element whose dimensions to match
 * @returns {CanvasRenderingContext2D}
 */
export function setupCanvas(canvas, containerEl) {
  const dpr = window.devicePixelRatio || 1;
  const w   = containerEl.offsetWidth;
  const h   = containerEl.offsetHeight;

  // Physical pixel dimensions (DESIGN.md quality check requirement)
  canvas.width  = w * dpr;
  canvas.height = h * dpr;

  // CSS display size matches container exactly
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return ctx;
}

// ── clearCanvas ───────────────────────────────────────────────────────────

/**
 * Clear the entire canvas, preserving the DPR transform.
 * Components call this at the start of each animation frame.
 *
 * @param {CanvasRenderingContext2D} ctx
 */
export function clearCanvas(ctx) {
  // Save/restore ensures we don't clobber the DPR scale transform.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

// ── drawWaveform ──────────────────────────────────────────────────────────

/**
 * Draw an oscilloscope-style waveform on the canvas.
 * Suitable for voltage and current traces (Zone 4).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{value: number, timestamp: number}>} data
 *   Array of { value, timestamp } from telemetryBuffer.getWaveform(field).
 *   Length should equal WAVEFORM_BUFFER_SIZE (120 samples).
 * @param {object} opts
 *   @param {string}  [opts.color='--wave-voltage']    CSS variable name for line color
 *   @param {number}  [opts.min]                       Y-axis minimum (auto if omitted)
 *   @param {number}  [opts.max]                       Y-axis maximum (auto if omitted)
 *   @param {number}  [opts.lineWidth=1.5]             Stroke width in CSS pixels
 *   @param {number}  [opts.opacity=1]                 Global alpha
 *   @param {boolean} [opts.filled=false]              Fill area below the line
 *   @param {string}  [opts.fillColor]                 CSS variable name for fill (defaults to color at 15% opacity)
 */
export function drawWaveform(ctx, data, opts = {}) {
  if (!data || data.length < 2) return;

  const canvas  = ctx.canvas;
  const dpr     = window.devicePixelRatio || 1;
  const w       = canvas.width  / dpr;  // CSS pixel width
  const h       = canvas.height / dpr;  // CSS pixel height
  const padding = { top: 8, bottom: 8, left: 0, right: 0 };
  const drawH   = h - padding.top - padding.bottom;

  // Resolve options
  const colorVar  = opts.color     || '--wave-voltage';
  const lineColor = cssVar(colorVar);
  const lineWidth = opts.lineWidth ?? 1.5;
  const alpha     = opts.opacity   ?? 1;
  const filled    = opts.filled    ?? false;

  // Auto-scale Y axis if not provided
  const values = data.map(d => (typeof d === 'object' ? d.value : d));
  const dataMin = opts.min ?? Math.min(...values);
  const dataMax = opts.max ?? Math.max(...values);
  const range   = dataMax - dataMin || 1; // guard zero-range

  /**
   * Map a data value to canvas Y coordinate (CSS pixels).
   * Y=0 is top of canvas; higher values render higher up.
   */
  function yOf(v) {
    return padding.top + drawH - ((v - dataMin) / range) * drawH;
  }

  /**
   * Map a sample index to canvas X coordinate (CSS pixels).
   */
  function xOf(i) {
    return padding.left + (i / (data.length - 1)) * (w - padding.left - padding.right);
  }

  ctx.save();
  ctx.globalAlpha = alpha;

  // Build the waveform path
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = xOf(i);
    const y = yOf(values[i]);
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }

  // Stroke the line
  ctx.strokeStyle = lineColor;
  ctx.lineWidth   = lineWidth;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';
  ctx.stroke();

  // Optional area fill below the line
  if (filled) {
    const fillVar   = opts.fillColor || colorVar;
    const fillColor = cssVar(fillVar);

    // Close the path at the bottom baseline
    ctx.lineTo(xOf(data.length - 1), h - padding.bottom);
    ctx.lineTo(xOf(0),               h - padding.bottom);
    ctx.closePath();

    ctx.fillStyle   = fillColor;
    ctx.globalAlpha = alpha * 0.15; // subtle area fill
    ctx.fill();
  }

  ctx.restore();
}

// ── drawSparkline ─────────────────────────────────────────────────────────

/**
 * Draw a sparkline bar chart (Section 5.8 — Mini Sparkline Bar Chart).
 * Used for Zone 3B GPU-style panels and trend displays.
 *
 * Bars are rendered left-to-right, oldest to newest.
 * The rightmost (latest) bar is highlighted as "active".
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number[]} data
 *   Plain array of numbers from telemetryBuffer.getSparkline(field).
 *   Length should equal SPARKLINE_BUFFER_SIZE (60 samples).
 * @param {object} opts
 *   @param {string}  [opts.activeColor='--bar-active']    CSS variable for active/latest bar
 *   @param {string}  [opts.inactiveColor='--bar-inactive'] CSS variable for all other bars
 *   @param {number}  [opts.barWidth=3]                    Bar width in CSS pixels (--bar-width)
 *   @param {number}  [opts.barGap=2]                      Gap between bars (--bar-gap)
 *   @param {number}  [opts.min]                           Y floor (auto if omitted)
 *   @param {number}  [opts.max]                           Y ceiling (auto if omitted)
 *   @param {number}  [opts.activeCount=1]                 How many rightmost bars are "active"
 */
export function drawSparkline(ctx, data, opts = {}) {
  if (!data || data.length === 0) return;

  const canvas  = ctx.canvas;
  const dpr     = window.devicePixelRatio || 1;
  const w       = canvas.width  / dpr;
  const h       = canvas.height / dpr;

  // Resolve options using token defaults
  const activeColor   = cssVar(opts.activeColor   || '--bar-active');
  const inactiveColor = cssVar(opts.inactiveColor || '--bar-inactive');
  const barWidth      = opts.barWidth  ?? 3;
  const barGap        = opts.barGap    ?? 2;
  const activeCount   = opts.activeCount ?? 1;

  // How many bars fit, starting from the right edge
  const step      = barWidth + barGap;
  const maxBars   = Math.floor(w / step);
  const barsToUse = Math.min(data.length, maxBars);
  const slice     = data.slice(-barsToUse); // most recent N samples

  // Y-axis scaling
  const dataMin = opts.min ?? Math.min(...slice);
  const dataMax = opts.max ?? Math.max(...slice);
  const range   = dataMax - dataMin || 1;
  const minBarH = 2; // always show a minimum 2px bar so empty data is visible

  ctx.save();

  for (let i = 0; i < slice.length; i++) {
    const barH  = minBarH + ((slice[i] - dataMin) / range) * (h - minBarH);
    const x     = i * step;
    const y     = h - barH;
    const isActive = i >= slice.length - activeCount;

    ctx.fillStyle = isActive ? activeColor : inactiveColor;
    ctx.beginPath();
    // Rounded top corners (Section 5.8 — subtle refinement)
    const r = Math.min(barWidth / 2, 1.5);
    ctx.roundRect(x, y, barWidth, barH, [r, r, 0, 0]);
    ctx.fill();
  }

  ctx.restore();
}

// ══════════════════════════════════════════════════════════════════════════
// Phase 5 Extension — Analytics Chart Helpers
// Extend only — the functions above are frozen.
// All helpers follow the same contract:
//   - Accept ctx, data, opts
//   - Read colors via cssVar()
//   - Never call ctx.* outside this module
//   - Never exceed canvas bounds
// ══════════════════════════════════════════════════════════════════════════

// ── Shared layout constants ───────────────────────────────────────────────
const AXIS_PAD_LEFT   = 52;   // room for Y-axis labels
const AXIS_PAD_RIGHT  = 16;
const AXIS_PAD_TOP    = 16;
const AXIS_PAD_BOTTOM = 36;   // room for X-axis labels

// ── Y-axis nice-number helpers ────────────────────────────────────────────

/**
 * Compute a "nice" axis range with the requested number of ticks.
 * Adds 10% headroom above the data max per spec.
 *
 * @param {number} dataMin
 * @param {number} dataMax
 * @param {number} [ticks=5]
 * @returns {{ axisMin: number, axisMax: number, step: number }}
 */
function _niceRange(dataMin, dataMax, ticks = 5) {
  const headroom = (dataMax - dataMin) * 0.10 || 1;
  const raw      = dataMax + headroom;
  const range    = raw - dataMin || 1;
  const roughStep = range / ticks;
  // Round step to a "nice" magnitude
  const mag   = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const step  = Math.ceil(roughStep / mag) * mag;
  const axisMin = Math.floor(dataMin / step) * step;
  const axisMax = axisMin + step * Math.ceil((raw - axisMin) / step);
  return { axisMin, axisMax, step };
}

/**
 * Format an axis tick value sensibly.
 * @param {number} v
 * @param {number} step   — the tick step size (used to decide decimal precision)
 * @returns {string}
 */
function _fmtTick(v, step) {
  if (step >= 1000) return (v / 1000).toFixed(1) + 'k';
  if (step >= 1)    return Math.round(v).toString();
  return v.toFixed(1);
}

// ── Time axis helpers ─────────────────────────────────────────────────────

/**
 * Derive an appropriate time label formatter for a data range.
 * @param {number} spanMs — total time span in milliseconds
 * @returns {function(ts: number): string}
 */
function _timeLabelFormatter(spanMs) {
  const hour  = 3_600_000;
  const day   = 86_400_000;

  if (spanMs <= 2 * hour) {
    // 1H–2H: show HH:MM
    return ts => {
      const d = new Date(ts);
      return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    };
  }
  if (spanMs <= 7 * day) {
    // 6H–7D: show Day HH:MM
    return ts => {
      const d = new Date(ts);
      const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      return `${days[d.getDay()]} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    };
  }
  // 30D+: show MMM DD
  return ts => {
    const d = new Date(ts);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[d.getMonth()]} ${d.getDate()}`;
  };
}

/**
 * Choose approximately N evenly-spaced tick indices into a data array.
 * @param {number} dataLen
 * @param {number} maxTicks
 * @returns {number[]}  — array of indices
 */
function _tickIndices(dataLen, maxTicks) {
  if (dataLen <= maxTicks) return Array.from({ length: dataLen }, (_, i) => i);
  const step = Math.floor(dataLen / maxTicks);
  const out  = [];
  for (let i = 0; i < dataLen; i += step) out.push(i);
  // Always include the last index
  if (out[out.length - 1] !== dataLen - 1) out.push(dataLen - 1);
  return out;
}

// ── drawAxisFrame ─────────────────────────────────────────────────────────

/**
 * Draw the grid, X-axis time labels, and Y-axis value labels for a chart.
 * Called internally by drawLineChart and drawAreaChart before drawing data.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number}   w         — canvas CSS pixel width
 * @param {number}   h         — canvas CSS pixel height
 * @param {number[]} timestamps — epoch-ms X values
 * @param {number}   axisMin
 * @param {number}   axisMax
 * @param {number}   step
 * @param {string}   [yUnit]   — unit suffix for Y-axis labels
 */
function _drawAxisFrame(ctx, w, h, timestamps, axisMin, axisMax, step, yUnit = '') {
  const spanMs   = timestamps[timestamps.length - 1] - timestamps[0] || 1;
  const formatTs = _timeLabelFormatter(spanMs);

  const drawW = w - AXIS_PAD_LEFT - AXIS_PAD_RIGHT;
  const drawH = h - AXIS_PAD_TOP  - AXIS_PAD_BOTTOM;

  const gridColor  = cssVar('--border-subtle') || 'rgba(255,255,255,0.08)';
  const labelColor = cssVar('--text-faint')    || '#5a5e5a';
  const font       = `10px ${cssVar('--font-primary') || 'system-ui'}`;

  ctx.save();
  ctx.font      = font;
  ctx.fillStyle = labelColor;
  ctx.textAlign = 'right';

  // ── Y-axis grid lines and labels ─────────────────────────────────────
  const range = axisMax - axisMin || 1;
  for (let v = axisMin; v <= axisMax + step * 0.01; v += step) {
    const y = AXIS_PAD_TOP + drawH - ((v - axisMin) / range) * drawH;
    if (y < AXIS_PAD_TOP - 2 || y > AXIS_PAD_TOP + drawH + 2) continue;

    // Grid line
    ctx.strokeStyle = gridColor;
    ctx.lineWidth   = 0.5;
    ctx.beginPath();
    ctx.moveTo(AXIS_PAD_LEFT, y);
    ctx.lineTo(AXIS_PAD_LEFT + drawW, y);
    ctx.stroke();

    // Y label
    const label = _fmtTick(v, step) + (yUnit ? ` ${yUnit}` : '');
    ctx.fillText(label, AXIS_PAD_LEFT - 6, y + 3.5);
  }

  // ── X-axis time labels ───────────────────────────────────────────────
  ctx.textAlign  = 'center';
  const maxXTicks = Math.min(6, timestamps.length);
  const xIndices  = _tickIndices(timestamps.length, maxXTicks);

  for (const idx of xIndices) {
    const ts = timestamps[idx];
    const x  = AXIS_PAD_LEFT + (idx / Math.max(timestamps.length - 1, 1)) * drawW;
    const y  = AXIS_PAD_TOP + drawH + 14;
    ctx.fillStyle = labelColor;
    ctx.fillText(formatTs(ts), x, y);

    // Tick mark
    ctx.strokeStyle = gridColor;
    ctx.lineWidth   = 0.5;
    ctx.beginPath();
    ctx.moveTo(x, AXIS_PAD_TOP + drawH);
    ctx.lineTo(x, AXIS_PAD_TOP + drawH + 4);
    ctx.stroke();
  }

  // Axis border (left + bottom)
  ctx.strokeStyle = cssVar('--border-subtle') || 'rgba(255,255,255,0.08)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(AXIS_PAD_LEFT, AXIS_PAD_TOP);
  ctx.lineTo(AXIS_PAD_LEFT, AXIS_PAD_TOP + drawH);
  ctx.lineTo(AXIS_PAD_LEFT + drawW, AXIS_PAD_TOP + drawH);
  ctx.stroke();

  ctx.restore();
}

// ── drawLineChart ─────────────────────────────────────────────────────────

/**
 * Draw a time-series line chart (no area fill).
 * Used for voltage, current, temperature over time.
 *
 * Phase 5 — Analytics charts.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{ts: number, value: number}>} data — sorted chronologically
 * @param {object} opts
 *   @param {string}  [opts.color='--wave-voltage']   CSS variable for line color
 *   @param {number}  [opts.min]                      Y-axis min (auto if omitted)
 *   @param {number}  [opts.max]                      Y-axis max (auto if omitted)
 *   @param {number}  [opts.lineWidth=1.5]
 *   @param {string}  [opts.unit='']                  Y-axis unit label
 *   @param {object|null} [opts.tooltip]              { dataIndex, x, y } if hovering
 */
export function drawLineChart(ctx, data, opts = {}) {
  if (!data || data.length < 2) return;

  const canvas = ctx.canvas;
  const dpr    = window.devicePixelRatio || 1;
  const w      = canvas.width  / dpr;
  const h      = canvas.height / dpr;
  const drawW  = w - AXIS_PAD_LEFT - AXIS_PAD_RIGHT;
  const drawH  = h - AXIS_PAD_TOP  - AXIS_PAD_BOTTOM;

  const colorVar  = opts.color || '--wave-voltage';
  const lineColor = cssVar(colorVar);
  const lineWidth = opts.lineWidth ?? 1.5;

  const values     = data.map(d => d.value);
  const timestamps = data.map(d => d.ts);
  const dataMin    = opts.min ?? Math.min(...values);
  const dataMax    = opts.max ?? Math.max(...values);
  const { axisMin, axisMax, step } = _niceRange(dataMin, dataMax);
  const range = axisMax - axisMin || 1;

  _drawAxisFrame(ctx, w, h, timestamps, axisMin, axisMax, step, opts.unit || '');

  // ── Line path ────────────────────────────────────────────────────────
  const tsSpan = timestamps[timestamps.length - 1] - timestamps[0] || 1;

  function xOf(ts) {
    return AXIS_PAD_LEFT + ((ts - timestamps[0]) / tsSpan) * drawW;
  }
  function yOf(v) {
    return AXIS_PAD_TOP + drawH - ((v - axisMin) / range) * drawH;
  }

  ctx.save();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth   = lineWidth;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';

  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = xOf(data[i].ts);
    const y = yOf(data[i].value);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // ── Tooltip dot ───────────────────────────────────────────────────────
  if (opts.tooltip) {
    const { dataIndex } = opts.tooltip;
    const point = data[dataIndex];
    if (point) {
      const tx = xOf(point.ts);
      const ty = yOf(point.value);
      ctx.beginPath();
      ctx.arc(tx, ty, 4, 0, Math.PI * 2);
      ctx.fillStyle   = lineColor;
      ctx.fill();
      ctx.strokeStyle = cssVar('--bg-card-dark');
      ctx.lineWidth   = 2;
      ctx.stroke();
    }
  }

  ctx.restore();
}

// ── drawAreaChart ─────────────────────────────────────────────────────────

/**
 * Draw a time-series area chart (line + filled area below).
 * Used for power over time. Supports optional dual-series overlay.
 *
 * Phase 5 — Analytics charts.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{ts: number, value: number}>} data
 * @param {object} opts
 *   @param {string}  [opts.color='--health-excellent']  line + fill color CSS var
 *   @param {number}  [opts.min]
 *   @param {number}  [opts.max]
 *   @param {number}  [opts.lineWidth=1.5]
 *   @param {number}  [opts.fillOpacity=0.18]
 *   @param {string}  [opts.unit='']
 *   @param {object|null} [opts.tooltip]
 */
export function drawAreaChart(ctx, data, opts = {}) {
  if (!data || data.length < 2) return;

  const canvas = ctx.canvas;
  const dpr    = window.devicePixelRatio || 1;
  const w      = canvas.width  / dpr;
  const h      = canvas.height / dpr;
  const drawW  = w - AXIS_PAD_LEFT - AXIS_PAD_RIGHT;
  const drawH  = h - AXIS_PAD_TOP  - AXIS_PAD_BOTTOM;

  const colorVar   = opts.color || '--health-excellent';
  const lineColor  = cssVar(colorVar);
  const lineWidth  = opts.lineWidth ?? 1.5;
  const fillAlpha  = opts.fillOpacity ?? 0.18;

  const values     = data.map(d => d.value);
  const timestamps = data.map(d => d.ts);
  const dataMin    = opts.min ?? Math.min(...values);
  const dataMax    = opts.max ?? Math.max(...values);
  const { axisMin, axisMax, step } = _niceRange(dataMin, dataMax);
  const range = axisMax - axisMin || 1;

  _drawAxisFrame(ctx, w, h, timestamps, axisMin, axisMax, step, opts.unit || '');

  const tsSpan = timestamps[timestamps.length - 1] - timestamps[0] || 1;
  const baseY  = AXIS_PAD_TOP + drawH;

  function xOf(ts) {
    return AXIS_PAD_LEFT + ((ts - timestamps[0]) / tsSpan) * drawW;
  }
  function yOf(v) {
    return AXIS_PAD_TOP + drawH - ((v - axisMin) / range) * drawH;
  }

  ctx.save();

  // ── Fill area ─────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(xOf(data[0].ts), baseY);
  for (let i = 0; i < data.length; i++) {
    ctx.lineTo(xOf(data[i].ts), yOf(data[i].value));
  }
  ctx.lineTo(xOf(data[data.length - 1].ts), baseY);
  ctx.closePath();
  ctx.fillStyle   = lineColor;
  ctx.globalAlpha = fillAlpha;
  ctx.fill();
  ctx.globalAlpha = 1;

  // ── Line on top ───────────────────────────────────────────────────────
  ctx.strokeStyle = lineColor;
  ctx.lineWidth   = lineWidth;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';

  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = xOf(data[i].ts);
    const y = yOf(data[i].value);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // ── Tooltip dot ───────────────────────────────────────────────────────
  if (opts.tooltip) {
    const { dataIndex } = opts.tooltip;
    const point = data[dataIndex];
    if (point) {
      const tx = xOf(point.ts);
      const ty = yOf(point.value);
      ctx.beginPath();
      ctx.arc(tx, ty, 4, 0, Math.PI * 2);
      ctx.fillStyle   = lineColor;
      ctx.globalAlpha = 1;
      ctx.fill();
      ctx.strokeStyle = cssVar('--bg-card-dark');
      ctx.lineWidth   = 2;
      ctx.stroke();
    }
  }

  ctx.restore();
}

// ── drawBarChart ──────────────────────────────────────────────────────────

/**
 * Draw a vertical bar chart for discrete time buckets (e.g. daily energy).
 * Bars are evenly spaced. Each bar can have an individual color.
 *
 * Phase 5 — Analytics charts.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{label: string, value: number, color?: string}>} data
 *   Each entry has a display label (X-axis) and a numeric value (Y-axis).
 *   Optional color CSS variable per bar — falls back to opts.color.
 * @param {object} opts
 *   @param {string} [opts.color='--bar-active']   default bar color CSS var
 *   @param {number} [opts.min=0]                  Y-axis min
 *   @param {number} [opts.max]                    Y-axis max (auto if omitted)
 *   @param {string} [opts.unit='']                Y-axis unit label
 *   @param {number} [opts.barGap=0.25]            gap ratio (0–1) between bars
 *   @param {number|null} [opts.highlightIndex]    index of highlighted bar
 */
export function drawBarChart(ctx, data, opts = {}) {
  if (!data || data.length === 0) return;

  const canvas = ctx.canvas;
  const dpr    = window.devicePixelRatio || 1;
  const w      = canvas.width  / dpr;
  const h      = canvas.height / dpr;
  const drawW  = w - AXIS_PAD_LEFT - AXIS_PAD_RIGHT;
  const drawH  = h - AXIS_PAD_TOP  - AXIS_PAD_BOTTOM;

  const defaultColor = cssVar(opts.color || '--bar-active');
  const labelColor   = cssVar('--text-faint') || '#5a5e5a';
  const gridColor    = cssVar('--border-subtle') || 'rgba(255,255,255,0.08)';
  const font         = `10px ${cssVar('--font-primary') || 'system-ui'}`;

  const values  = data.map(d => d.value);
  const dataMax = opts.max ?? Math.max(...values);
  const dataMin = opts.min ?? 0;
  const { axisMin, axisMax, step } = _niceRange(dataMin, dataMax);
  const range   = axisMax - axisMin || 1;
  const gapRatio = opts.barGap ?? 0.25;

  ctx.save();
  ctx.font = font;

  // ── Y-axis grid lines and labels ──────────────────────────────────────
  for (let v = axisMin; v <= axisMax + step * 0.01; v += step) {
    const y = AXIS_PAD_TOP + drawH - ((v - axisMin) / range) * drawH;
    if (y < AXIS_PAD_TOP - 2 || y > AXIS_PAD_TOP + drawH + 2) continue;

    ctx.strokeStyle = gridColor;
    ctx.lineWidth   = 0.5;
    ctx.beginPath();
    ctx.moveTo(AXIS_PAD_LEFT, y);
    ctx.lineTo(AXIS_PAD_LEFT + drawW, y);
    ctx.stroke();

    ctx.fillStyle = labelColor;
    ctx.textAlign = 'right';
    ctx.fillText(_fmtTick(v, step) + (opts.unit ? ` ${opts.unit}` : ''), AXIS_PAD_LEFT - 6, y + 3.5);
  }

  // ── Bars ───────────────────────────────────────────────────────────────
  const slotW  = drawW / data.length;
  const barW   = slotW * (1 - gapRatio);
  const barOff = slotW * (gapRatio / 2);

  for (let i = 0; i < data.length; i++) {
    const barColor  = data[i].color ? cssVar(data[i].color) : defaultColor;
    const barH      = Math.max(2, ((data[i].value - axisMin) / range) * drawH);
    const x         = AXIS_PAD_LEFT + i * slotW + barOff;
    const y         = AXIS_PAD_TOP + drawH - barH;
    const highlighted = opts.highlightIndex === i;

    ctx.globalAlpha = highlighted ? 1.0 : 0.80;
    ctx.fillStyle   = barColor;

    const rr = Math.min(barW / 2, 3);
    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, [rr, rr, 0, 0]);
    ctx.fill();

    // ── X-axis label ─────────────────────────────────────────────────
    ctx.globalAlpha = 1;
    ctx.fillStyle   = labelColor;
    ctx.textAlign   = 'center';
    ctx.fillText(data[i].label, x + barW / 2, AXIS_PAD_TOP + drawH + 14);
  }

  // Axis border
  ctx.strokeStyle = gridColor;
  ctx.lineWidth   = 1;
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.moveTo(AXIS_PAD_LEFT, AXIS_PAD_TOP);
  ctx.lineTo(AXIS_PAD_LEFT, AXIS_PAD_TOP + drawH);
  ctx.lineTo(AXIS_PAD_LEFT + drawW, AXIS_PAD_TOP + drawH);
  ctx.stroke();

  ctx.restore();
}

// ── drawPowerFactorBar ─────────────────────────────────────────────────────

/**
 * Draw a Power Factor bar chart (horizontal orientation).
 * Bars run left-to-right with labels on the Y axis.
 *
 * Phase 5 — Analytics charts.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{label: string, value: number}>} data  — value in 0–1 range (PF)
 * @param {object} opts
 *   @param {string} [opts.goodColor='--health-excellent']
 *   @param {string} [opts.warnColor='--state-warning']
 *   @param {string} [opts.badColor='--state-fault']
 *   @param {number} [opts.goodThreshold=0.90]
 *   @param {number} [opts.warnThreshold=0.80]
 */
export function drawPowerFactorBar(ctx, data, opts = {}) {
  if (!data || data.length === 0) return;

  const canvas = ctx.canvas;
  const dpr    = window.devicePixelRatio || 1;
  const w      = canvas.width  / dpr;
  const h      = canvas.height / dpr;

  const PAD_LEFT   = 80;
  const PAD_RIGHT  = 48;
  const PAD_TOP    = 12;
  const PAD_BOTTOM = 12;
  const drawW = w - PAD_LEFT - PAD_RIGHT;
  const drawH = h - PAD_TOP  - PAD_BOTTOM;
  const rowH  = drawH / data.length;
  const barH  = Math.min(rowH * 0.5, 14);

  const goodColor  = cssVar(opts.goodColor  || '--health-excellent');
  const warnColor  = cssVar(opts.warnColor  || '--state-warning');
  const badColor   = cssVar(opts.badColor   || '--state-fault');
  const trackColor = cssVar('--progress-track') || '#2a2e2a';
  const labelColor = cssVar('--text-muted')     || '#8a8e8a';
  const valueColor = cssVar('--text-primary')   || '#ffffff';
  const font       = `11px ${cssVar('--font-primary') || 'system-ui'}`;
  const goodThr    = opts.goodThreshold ?? 0.90;
  const warnThr    = opts.warnThreshold ?? 0.80;

  ctx.save();
  ctx.font = font;

  for (let i = 0; i < data.length; i++) {
    const { label, value } = data[i];
    const cy = PAD_TOP + i * rowH + rowH / 2;
    const bx = PAD_LEFT;
    const by = cy - barH / 2;

    // Choose bar color by PF threshold
    let barColor;
    if (value >= goodThr)      barColor = goodColor;
    else if (value >= warnThr) barColor = warnColor;
    else                       barColor = badColor;

    // Track (full bar background)
    ctx.fillStyle = trackColor;
    ctx.beginPath();
    ctx.roundRect(bx, by, drawW, barH, barH / 2);
    ctx.fill();

    // Fill bar
    const fillW = Math.max(0, Math.min(drawW, value * drawW));
    ctx.fillStyle = barColor;
    ctx.beginPath();
    ctx.roundRect(bx, by, fillW, barH, barH / 2);
    ctx.fill();

    // Row label (left)
    ctx.fillStyle = labelColor;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, PAD_LEFT - 8, cy);

    // Value (right)
    ctx.fillStyle = valueColor;
    ctx.textAlign = 'left';
    ctx.fillText(value.toFixed(3), PAD_LEFT + drawW + 6, cy);
  }

  ctx.restore();
}

// ── drawFaultTimeline ─────────────────────────────────────────────────────

/**
 * Draw a fault event timeline — dots positioned on a horizontal time axis.
 * Each fault event appears as a colored dot above the axis, with a label.
 *
 * Phase 5 — Analytics charts.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{ts: number, label: string, color?: string}>} events
 *   Each event has a timestamp, a short label, and an optional CSS color var.
 * @param {object} opts
 *   @param {number}  opts.fromTs        — start of time range (epoch ms)
 *   @param {number}  opts.toTs          — end of time range (epoch ms)
 *   @param {string}  [opts.dotColor='--fault-active']
 *   @param {number}  [opts.dotRadius=5]
 */
export function drawFaultTimeline(ctx, events, opts = {}) {
  const canvas  = ctx.canvas;
  const dpr     = window.devicePixelRatio || 1;
  const w       = canvas.width  / dpr;
  const h       = canvas.height / dpr;

  const PAD_LEFT   = 16;
  const PAD_RIGHT  = 16;
  const PAD_TOP    = 12;
  const PAD_BOTTOM = 28;
  const drawW  = w - PAD_LEFT - PAD_RIGHT;
  const axisY  = h - PAD_BOTTOM;
  const dotR   = opts.dotRadius ?? 5;

  const spanMs     = (opts.toTs - opts.fromTs) || 1;
  const dotColor   = cssVar(opts.dotColor || '--fault-active');
  const axisColor  = cssVar('--border-subtle')  || 'rgba(255,255,255,0.08)';
  const labelColor = cssVar('--text-faint')     || '#5a5e5a';
  const noDataColor = cssVar('--text-muted')    || '#8a8e8a';
  const font       = `10px ${cssVar('--font-primary') || 'system-ui'}`;

  ctx.save();
  ctx.font = font;

  // ── Time axis line ────────────────────────────────────────────────────
  ctx.strokeStyle = axisColor;
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(PAD_LEFT, axisY);
  ctx.lineTo(PAD_LEFT + drawW, axisY);
  ctx.stroke();

  // ── Axis end labels ───────────────────────────────────────────────────
  const fmt = _timeLabelFormatter(spanMs);
  ctx.fillStyle = labelColor;
  ctx.textAlign = 'left';
  ctx.fillText(fmt(opts.fromTs), PAD_LEFT, axisY + 14);
  ctx.textAlign = 'right';
  ctx.fillText(fmt(opts.toTs), PAD_LEFT + drawW, axisY + 14);

  if (events.length === 0) {
    ctx.fillStyle = noDataColor;
    ctx.textAlign = 'center';
    ctx.font      = `12px ${cssVar('--font-primary') || 'system-ui'}`;
    ctx.fillText('No fault events in range', PAD_LEFT + drawW / 2, h / 2 - 4);
    ctx.restore();
    return;
  }

  // ── Event dots ────────────────────────────────────────────────────────
  for (const ev of events) {
    const x = PAD_LEFT + ((ev.ts - opts.fromTs) / spanMs) * drawW;
    const y = axisY - dotR * 2 - 4;

    const color = ev.color ? cssVar(ev.color) : dotColor;

    // Stem line from dot to axis
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(x, axisY);
    ctx.lineTo(x, y + dotR);
    ctx.stroke();

    // Dot
    ctx.globalAlpha = 0.9;
    ctx.fillStyle   = color;
    ctx.beginPath();
    ctx.arc(x, y, dotR, 0, Math.PI * 2);
    ctx.fill();

    // Label (above dot, truncated)
    ctx.globalAlpha = 1;
    ctx.fillStyle   = labelColor;
    ctx.textAlign   = 'center';
    ctx.font        = `9px ${cssVar('--font-primary') || 'system-ui'}`;

    // Clip label to fit — just truncate to keep from overlapping axis
    const maxLabel = 8;
    const labelStr = ev.label.length > maxLabel
      ? ev.label.slice(0, maxLabel - 1) + '…'
      : ev.label;
    ctx.fillText(labelStr, x, y - dotR - 3);
  }

  ctx.restore();
}

/**
 * Hit-test a canvas mouse event against a time-series data array.
 * Returns the nearest data index within a pixel tolerance, or null.
 *
 * Shared utility for tooltip detection in analytics charts.
 *
 * @param {MouseEvent}  event          — raw mouse event on the canvas element
 * @param {number[]}    timestamps     — epoch-ms array (same length as data)
 * @param {number}      canvasW        — canvas CSS pixel width
 * @param {number}      [tolerance=12] — max pixel distance to register as hit
 * @returns {{ dataIndex: number } | null}
 */
export function hitTestTimeSeries(event, timestamps, canvasW, tolerance = 12) {
  const rect  = event.target.getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  const drawW  = canvasW - AXIS_PAD_LEFT - AXIS_PAD_RIGHT;
  const tsSpan = timestamps[timestamps.length - 1] - timestamps[0] || 1;

  let closestIdx  = -1;
  let closestDist = Infinity;

  for (let i = 0; i < timestamps.length; i++) {
    const x    = AXIS_PAD_LEFT + ((timestamps[i] - timestamps[0]) / tsSpan) * drawW;
    const dist = Math.abs(mouseX - x);
    if (dist < closestDist) {
      closestDist = dist;
      closestIdx  = i;
    }
  }

  if (closestIdx < 0 || closestDist > tolerance) return null;
  return { dataIndex: closestIdx };
}

// ── drawNoData ────────────────────────────────────────────────────────────

/**
 * Draw a centered "No data available" message on the canvas.
 * Called by page components instead of writing raw ctx.* calls inline.
 *
 * Phase 5 — Analytics charts.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} [message='No data available for this range']
 */
export function drawNoData(ctx, message = 'No data available for this range') {
  const canvas = ctx.canvas;
  const dpr    = window.devicePixelRatio || 1;
  const w      = canvas.width  / dpr;
  const h      = canvas.height / dpr;

  ctx.save();
  ctx.fillStyle    = cssVar('--text-faint') || '#5a5e5a';
  ctx.font         = `12px ${cssVar('--font-primary') || 'system-ui'}`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, w / 2, h / 2);
  ctx.restore();
}
