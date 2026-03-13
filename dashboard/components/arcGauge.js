/**
 * arcGauge.js — Smart Grid Sentinel Arc Gauge Component
 * Phase 3 deliverable. DESIGN.md §5, §17, §18.
 *
 * 270° SVG arc gauge with health-ramp color shifting.
 * Used for voltage, current, temperature, and fault probability displays.
 *
 * Rendering: all SVG geometry via svgEngine.js — zero inline geometry here.
 * Animation: registered with animationLoop for smooth value transitions.
 *
 * Component interface (DESIGN.md §17):
 *   constructor(containerEl, options)
 *   update(telemetryData)
 *   destroy()
 *
 * Options:
 *   field        {string}   — telemetryData key to read (e.g. 'v', 't', 'health')
 *   min          {number}   — gauge minimum value
 *   max          {number}   — gauge maximum value
 *   unit         {string}   — unit label (e.g. 'V', '°C', '%')
 *   label        {string}   — card label below value
 *   colorRamp    {Array<{threshold: number, color: string}>}
 *                           — CSS variable names ordered low→high threshold
 *                             e.g. [{threshold: 0, color: '--health-excellent'},
 *                                   {threshold: 70, color: '--health-degraded'},
 *                                   {threshold: 90, color: '--state-fault'}]
 *   size         {number}   — viewBox dimension in px (default 160)
 */

import { animationLoop }                from '../rendering/animationLoop.js';
import { createArcPath, updateArcLength, svgEl } from '../rendering/svgEngine.js';

// ── Arc geometry constants (270° sweep, gap at bottom) ─────────────────────
// Start: 135° (bottom-left), End: 45° (bottom-right), sweeping clockwise.
// These match DESIGN.md §5.1.1 and the svgEngine convention (0° = 3-o'clock).
const ARC_START_DEG = 135;
const ARC_END_DEG   = 45;
const SVG_NS        = 'http://www.w3.org/2000/svg';

// Transition duration for animated value changes (DESIGN.md §6 timing table)
const TRANSITION_MS = 300;

// Default color ramp — health score style (overridable via options)
const DEFAULT_COLOR_RAMP = [
  { threshold:   0, color: '--health-excellent' },
  { threshold:  70, color: '--health-good'      },
  { threshold:  80, color: '--health-degraded'  },
  { threshold:  90, color: '--health-poor'      },
  { threshold:  96, color: '--health-critical'  },
];

export class ArcGauge {
  /**
   * @param {HTMLElement} containerEl
   * @param {object}      options
   */
  constructor(containerEl, options = {}) {
    this._container = containerEl;
    this._opts = {
      field:     options.field     ?? 'health',
      min:       options.min       ?? 0,
      max:       options.max       ?? 100,
      unit:      options.unit      ?? '%',
      label:     options.label     ?? 'value',
      colorRamp: options.colorRamp ?? DEFAULT_COLOR_RAMP,
      size:      options.size      ?? 160,
    };

    // Animated value state — transitions smoothly between ticks
    this._currentValue  = this._opts.min;
    this._targetValue   = this._opts.min;
    this._animStartTime = null;
    this._animFrom      = this._opts.min;

    // Build DOM
    this._buildDOM();

    // Register animation subscriber for smooth arc transitions
    this._onFrame = this._onFrame.bind(this);
    animationLoop.subscribe(this._onFrame);
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  _buildDOM() {
    const size   = this._opts.size;
    const cx     = size / 2;
    const cy     = size / 2;
    // Radius: leave room for stroke width (12px) and a small inset margin
    const r      = size / 2 - 16;
    const stroke = 10;

    this._cx = cx;
    this._cy = cy;
    this._r  = r;

    // Container layout
    this._container.style.position = 'relative';
    this._container.style.display  = 'flex';
    this._container.style.flexDirection = 'column';
    this._container.style.alignItems    = 'center';

    // ── SVG element ────────────────────────────────────────────────────────
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('width',  size);
    svg.setAttribute('height', size);
    svg.setAttribute('aria-hidden', 'true');
    svg.style.overflow = 'visible';

    // Track arc (full 270° background)
    const trackD  = createArcPath(cx, cy, r, ARC_START_DEG, ARC_END_DEG);
    const trackEl = svgEl('path', {
      d:            trackD,
      fill:         'none',
      stroke:       'var(--progress-track)',
      'stroke-width':     stroke,
      'stroke-linecap':   'round',
    });

    // Fill arc (value proportion of 270°)
    const fillD  = createArcPath(cx, cy, r, ARC_START_DEG, ARC_END_DEG);
    const fillEl = svgEl('path', {
      d:            fillD,
      fill:         'none',
      stroke:       'var(--health-excellent)',
      'stroke-width':     stroke,
      'stroke-linecap':   'round',
      style:        'transition: stroke 600ms ease-in-out;',
    });

    svg.appendChild(trackEl);
    svg.appendChild(fillEl);

    // Pre-compute total arc length after appending to DOM context
    // We use a deferred measurement via a tiny rAF — element must be in the DOM.
    // Store refs so _onFrame can call updateArcLength.
    this._fillEl    = fillEl;
    this._trackEl   = trackEl;
    this._arcLength = null; // populated on first _onFrame after layout

    // ── Center text overlay ────────────────────────────────────────────────
    const center = document.createElement('div');
    center.style.cssText = [
      'position: absolute',
      `top: ${cy - 18}px`,
      'left: 0',
      'width: 100%',
      'text-align: center',
      'pointer-events: none',
    ].join(';');

    this._valueEl = document.createElement('span');
    this._valueEl.style.cssText = [
      'display: block',
      'font-size: var(--text-section)',
      'font-weight: 300',
      'color: var(--text-primary)',
      'font-variant-numeric: tabular-nums',
      'line-height: 1.1',
    ].join(';');
    this._valueEl.textContent = this._opts.min.toString();

    this._unitEl = document.createElement('span');
    this._unitEl.style.cssText = [
      'display: block',
      'font-size: var(--text-label)',
      'color: var(--text-muted)',
      'letter-spacing: 0.02em',
      'margin-top: 2px',
    ].join(';');
    this._unitEl.textContent = this._opts.unit;

    center.appendChild(this._valueEl);
    center.appendChild(this._unitEl);

    // ── Label below gauge ──────────────────────────────────────────────────
    const label = document.createElement('span');
    label.style.cssText = [
      'display: block',
      'font-size: var(--text-label)',
      'color: var(--text-muted)',
      'text-align: center',
      'margin-top: 4px',
      'letter-spacing: 0.04em',
      'text-transform: uppercase',
    ].join(';');
    label.textContent = this._opts.label;

    // Assemble
    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    wrapper.style.width    = size + 'px';
    wrapper.style.height   = size + 'px';
    wrapper.appendChild(svg);
    wrapper.appendChild(center);

    this._container.appendChild(wrapper);
    this._container.appendChild(label);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Called by the page on each telemetry tick.
   * @param {object} telemetryData — canonical telemetry object
   */
  update(telemetryData) {
    // Navigate nested paths (e.g. 'prediction.fault_probability')
    const raw = _getField(telemetryData, this._opts.field);
    if (raw == null || typeof raw !== 'number') return;

    const clamped = Math.max(this._opts.min, Math.min(this._opts.max, raw));

    // Start a smooth transition from the current animated value
    this._animFrom      = this._currentValue;
    this._targetValue   = clamped;
    this._animStartTime = null; // will be set on next frame
  }

  /**
   * Remove all subscriptions and listeners.
   * Must be called when the parent page/component unmounts.
   */
  destroy() {
    animationLoop.unsubscribe(this._onFrame);
  }

  // ── Animation frame callback ───────────────────────────────────────────────

  _onFrame(timestamp) {
    // Lazy arc length measurement (requires element in DOM)
    if (this._arcLength === null && this._fillEl.isConnected) {
      this._arcLength = this._fillEl.getTotalLength?.() ?? 251; // fallback
      // Initialise dash arrays immediately
      this._fillEl.style.strokeDasharray  = this._arcLength;
      this._fillEl.style.strokeDashoffset = this._arcLength;
    }

    // Nothing to animate yet
    if (this._targetValue === this._currentValue) return;

    // Start transition timer on first frame with a pending target
    if (this._animStartTime === null) {
      this._animStartTime = timestamp;
    }

    const elapsed  = timestamp - this._animStartTime;
    const progress = Math.min(1, elapsed / TRANSITION_MS);
    // Ease-out cubic
    const eased    = 1 - Math.pow(1 - progress, 3);

    this._currentValue = this._animFrom + (this._targetValue - this._animFrom) * eased;

    // Normalise to 0–100 score for updateArcLength
    const range = this._opts.max - this._opts.min;
    const score = ((this._currentValue - this._opts.min) / range) * 100;

    if (this._arcLength !== null) {
      updateArcLength(this._fillEl, score, this._arcLength);
    }

    // Update displayed number
    const decimals = _decimalsForUnit(this._opts.unit);
    this._valueEl.textContent = this._currentValue.toFixed(decimals);

    // Update arc stroke color from the color ramp
    const cssVar = _colorFromRamp(score, this._opts.colorRamp);
    this._fillEl.style.stroke = `var(${cssVar})`;

    if (progress >= 1) {
      this._currentValue  = this._targetValue;
      this._animStartTime = null;
    }
  }
}

// ── Utility helpers ──────────────────────────────────────────────────────────

/**
 * Read a dot-path from an object (e.g. 'prediction.fault_probability').
 * Returns null when any segment is missing.
 */
function _getField(obj, path) {
  if (!path.includes('.')) return obj?.[path] ?? null;
  return path.split('.').reduce((acc, key) => acc?.[key], obj) ?? null;
}

/**
 * Pick the CSS variable name from the ramp that corresponds to the given score (0–100).
 * The ramp is an array sorted ascending by threshold.
 */
function _colorFromRamp(score, ramp) {
  let chosen = ramp[0].color;
  for (const entry of ramp) {
    if (score >= entry.threshold) {
      chosen = entry.color;
    }
  }
  return chosen;
}

/**
 * How many decimal places to show for a given unit.
 */
function _decimalsForUnit(unit) {
  if (unit === 'V' || unit === 'A')  return 1;
  if (unit === '°C')                 return 1;
  if (unit === 'W' || unit === 'VA') return 0;
  return 0;
}
