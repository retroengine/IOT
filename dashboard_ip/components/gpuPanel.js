/**
 * gpuPanel.js — Smart Grid Sentinel GPU-Style Load Panel
 * Phase 7 deliverable. DESIGN.md §5.16, §17.
 *
 * Horizontal stacked bar showing ESP32 CPU load as a proportion of
 * the available budget. Color ramp: green <50%, amber 50–80%, red >80%.
 * Bar is clamped at 100% regardless of input.
 *
 * Falls back to sys.cpu_load_pct from the canonical telemetry object.
 * When loop-time budget data becomes available in the firmware, the
 * component accepts explicit override values via options.
 *
 * Component interface (DESIGN.md §17):
 *   constructor(containerEl, options)
 *   update(telemetryData)
 *   destroy()
 *
 * Options:
 *   label     {string}  — display label (default 'ESP32 Load')
 *   field     {string}  — dot-path into canonical telemetry (default 'sys.cpu_load_pct')
 *   showSpark {boolean} — whether to render a 60-sample sparkline below the bar (default true)
 */

// ── Colour thresholds ─────────────────────────────────────────────────────
const COLOR_THRESHOLDS = [
  { below: 50,  color: '--health-excellent' },
  { below: 80,  color: '--state-warning'    },
  { below: 101, color: '--state-fault'      },
];

function _colorForPct(pct) {
  for (const entry of COLOR_THRESHOLDS) {
    if (pct < entry.below) return `var(${entry.color})`;
  }
  return `var(--state-fault)`;
}

// ── Deep-get helper (no external imports) ─────────────────────────────────
function _getField(obj, path) {
  if (!path || obj == null) return null;
  if (!path.includes('.')) return obj[path] ?? null;
  return path.split('.').reduce((acc, k) => acc?.[k], obj) ?? null;
}

// ── SparkBuffer — private 60-value ring buffer ────────────────────────────
class _SparkBuffer {
  constructor(cap = 60) {
    this._cap  = cap;
    this._data = new Array(cap);
    this._head = 0;
    this._size = 0;
  }
  push(v) {
    this._data[this._head] = v;
    this._head = (this._head + 1) % this._cap;
    if (this._size < this._cap) this._size++;
  }
  toArray() {
    if (this._size === 0) return [];
    if (this._size < this._cap) return this._data.slice(0, this._size);
    return [...this._data.slice(this._head), ...this._data.slice(0, this._head)];
  }
  get length() { return this._size; }
}

// ── SVG namespace ─────────────────────────────────────────────────────────
const SVG_NS = 'http://www.w3.org/2000/svg';

export class GpuPanel {
  /**
   * @param {HTMLElement} containerEl
   * @param {object}      options
   */
  constructor(containerEl, options = {}) {
    this._container = containerEl;
    this._label     = options.label     ?? 'ESP32 Load';
    this._field     = options.field     ?? 'sys.cpu_load_pct';
    this._showSpark = options.showSpark !== false;

    this._pct    = 0;
    this._spark  = new _SparkBuffer(60);

    this._buildDOM();
    this._drawSpark();
  }

  // ── DOM construction ──────────────────────────────────────────────────

  _buildDOM() {
    // Wrapper card (inherits bg from parent; no independent bg here —
    // parent page card provides the surface)
    this._root = document.createElement('div');
    this._root.style.cssText = [
      'display: flex',
      'flex-direction: column',
      'gap: 6px',
    ].join(';');

    // ── Header row: label left, value right ──────────────────────────
    const hdr = document.createElement('div');
    hdr.style.cssText = [
      'display: flex',
      'align-items: center',
      'justify-content: space-between',
    ].join(';');

    this._labelEl = document.createElement('span');
    this._labelEl.style.cssText = [
      'font-size: 11px',
      'color: var(--text-muted)',
      'text-transform: uppercase',
      'letter-spacing: 0.06em',
      'white-space: nowrap',
    ].join(';');
    this._labelEl.textContent = this._label;

    this._valueEl = document.createElement('span');
    this._valueEl.style.cssText = [
      'font-size: 15px',
      'color: var(--text-primary)',
      'font-family: var(--font-mono)',
      'font-variant-numeric: tabular-nums',
      'font-weight: 400',
      'transition: color 400ms ease-in-out',
    ].join(';');
    this._valueEl.textContent = '–%';

    hdr.appendChild(this._labelEl);
    hdr.appendChild(this._valueEl);

    // ── Bar track ─────────────────────────────────────────────────────
    const track = document.createElement('div');
    track.style.cssText = [
      'height: 6px',
      'background: var(--progress-track)',
      'border-radius: var(--radius-pill)',
      'overflow: hidden',
      'position: relative',
    ].join(';');

    this._fill = document.createElement('div');
    this._fill.style.cssText = [
      'height: 100%',
      'width: 0%',
      'border-radius: var(--radius-pill)',
      'background: var(--health-excellent)',
      'transition: width 400ms ease-in-out, background 400ms ease-in-out',
    ].join(';');
    track.appendChild(this._fill);

    // ── Sparkline canvas ──────────────────────────────────────────────
    this._root.appendChild(hdr);
    this._root.appendChild(track);

    if (this._showSpark) {
      this._sparkCanvas       = document.createElement('canvas');
      this._sparkCanvas.style.cssText = [
        'display: block',
        'width: 100%',
        'height: 28px',
        'opacity: 0.6',
      ].join(';');
      this._root.appendChild(this._sparkCanvas);

      // Observe size changes to re-calibrate DPR
      this._ro = new ResizeObserver(() => this._setupCanvas());
      this._ro.observe(this._root);
      requestAnimationFrame(() => this._setupCanvas());
    }

    this._container.appendChild(this._root);
  }

  _setupCanvas() {
    const canvas = this._sparkCanvas;
    if (!canvas || !this._root.offsetWidth) return;
    const dpr = window.devicePixelRatio || 1;
    const w   = this._root.offsetWidth;
    const h   = 28;
    canvas.width  = w * dpr;
    canvas.height = h * dpr;
    this._ctx = canvas.getContext('2d');
    this._ctx.scale(dpr, dpr);
    this._drawSpark();
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * @param {object} telemetryData — canonical telemetry object
   */
  update(telemetryData) {
    const raw = _getField(telemetryData, this._field);
    if (raw == null || typeof raw !== 'number' || !isFinite(raw)) return;

    const pct = Math.max(0, Math.min(100, raw));
    this._pct = pct;
    this._spark.push(pct);

    // Value label
    this._valueEl.textContent = pct.toFixed(1) + '%';

    // Bar fill + color
    const color = _colorForPct(pct);
    this._fill.style.width      = `${pct}%`;
    this._fill.style.background = color;
    this._valueEl.style.color   = color;

    // Sparkline
    if (this._ctx) this._drawSpark();
  }

  destroy() {
    this._ro?.disconnect();
  }

  // ── Sparkline renderer (canvas, no external engine import needed) ─────

  _drawSpark() {
    const ctx = this._ctx;
    if (!ctx || !this._sparkCanvas) return;

    const data = this._spark.toArray();
    const W    = this._sparkCanvas.width  / (window.devicePixelRatio || 1);
    const H    = this._sparkCanvas.height / (window.devicePixelRatio || 1);

    ctx.clearRect(0, 0, W, H);
    if (data.length < 2) return;

    // Resolve color from the current pct
    const color = _colorForPct(this._pct);

    ctx.beginPath();
    const step = W / (data.length - 1);
    for (let i = 0; i < data.length; i++) {
      const x = i * step;
      const y = H - (data[i] / 100) * H;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    // Resolve the CSS variable to an actual color for canvas
    const cssColor = getComputedStyle(document.documentElement)
      .getPropertyValue(color.slice(4, -1).trim()) || '#1D9E75';

    ctx.strokeStyle = cssColor.trim();
    ctx.lineWidth   = 1.2;
    ctx.stroke();
  }
}
