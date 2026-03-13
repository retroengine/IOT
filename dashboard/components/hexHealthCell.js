/**
 * hexHealthCell.js — Smart Grid Sentinel Hex Health Cell Component
 * Phase 3 deliverable. DESIGN.md §3.1, §5, §17, §18.
 *
 * SVG hexagon with a perimeter arc fill proportional to health score (0–100).
 * Arc color follows the health ramp tokens. Smooth 300ms transition on update.
 *
 * Rendering: SVG geometry via svgEngine helpers.
 * Animation: arc transition via CSS stroke-dashoffset (no animationLoop needed).
 *            Load animation (fade + slide) uses CSS transition.
 *
 * Component interface (DESIGN.md §17):
 *   constructor(containerEl, options)
 *   update(telemetryData)
 *   destroy()
 *
 * Options:
 *   field    {string}  — path into telemetryData (e.g. 'diagnostics.voltage_stability')
 *   label    {string}  — label shown below hex (e.g. 'Voltage')
 */

import { updateArcLength, svgEl } from '../rendering/svgEngine.js';

// Hex geometry
const SVG_NS   = 'http://www.w3.org/2000/svg';
const HEX_SIZE = 120;   // viewBox dimension
const CX       = HEX_SIZE / 2;
const CY       = HEX_SIZE / 2;
const HEX_R    = 48;    // circumradius of the inner hex shape
const ARC_R    = 52;    // radius of the perimeter arc (slightly outside hex)

// Health ramp thresholds → CSS variable names (DESIGN.md §2)
const HEALTH_RAMP = [
  { threshold:  0,  color: '--health-critical'  },
  { threshold: 30,  color: '--health-poor'      },
  { threshold: 50,  color: '--health-degraded'  },
  { threshold: 70,  color: '--health-good'      },
  { threshold: 90,  color: '--health-excellent' },
];

export class HexHealthCell {
  /**
   * @param {HTMLElement} containerEl
   * @param {object}      options
   */
  constructor(containerEl, options = {}) {
    this._container = containerEl;
    this._opts = {
      field: options.field ?? 'health',
      label: options.label ?? 'System',
    };

    this._score    = 0;
    this._arcLen   = null;

    this._buildDOM();

    // Trigger load animation on next frame
    requestAnimationFrame(() => {
      this._wrapper.style.opacity   = '1';
      this._wrapper.style.transform = 'translateY(0)';
    });
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  _buildDOM() {
    this._wrapper = document.createElement('div');
    this._wrapper.style.cssText = [
      'display: flex',
      'flex-direction: column',
      'align-items: center',
      'gap: 6px',
      // Load animation start state
      'opacity: 0',
      'transform: translateY(8px)',
      'transition: opacity 400ms ease-out, transform 400ms ease-out',
    ].join(';');

    // Hover scale effect (DESIGN.md §6 interaction behaviors)
    this._wrapper.style.cursor     = 'default';
    this._wrapper.addEventListener('mouseenter', () => {
      this._wrapper.style.transform = 'scale(1.05)';
    });
    this._wrapper.addEventListener('mouseleave', () => {
      this._wrapper.style.transform = 'scale(1) translateY(0)';
    });

    // ── SVG ───────────────────────────────────────────────────────────────
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${HEX_SIZE} ${HEX_SIZE}`);
    svg.setAttribute('width',  HEX_SIZE);
    svg.setAttribute('height', HEX_SIZE);
    svg.setAttribute('aria-hidden', 'true');

    // Hexagon clip path
    const clipId = `hex-clip-${Math.random().toString(36).slice(2, 7)}`;
    const defs   = svgEl('defs');
    const clip   = svgEl('clipPath', { id: clipId });
    const hexPath = svgEl('path', { d: _hexPath(CX, CY, HEX_R) });
    clip.appendChild(hexPath);
    defs.appendChild(clip);
    svg.appendChild(defs);

    // Dark interior (clipped to hex shape)
    const bg = svgEl('path', {
      d:             _hexPath(CX, CY, HEX_R),
      fill:          'var(--bg-card-dark)',
      'clip-path':   `url(#${clipId})`,
    });
    svg.appendChild(bg);

    // Perimeter arc track (full circle behind the fill)
    const trackEl = svgEl('circle', {
      cx:                CX,
      cy:                CY,
      r:                 ARC_R,
      fill:              'none',
      stroke:            'var(--progress-track)',
      'stroke-width':    6,
      'stroke-linecap':  'round',
    });
    svg.appendChild(trackEl);

    // Perimeter arc fill — rotated so 0° starts at top (−90° offset)
    const fillEl = svgEl('circle', {
      cx:                CX,
      cy:                CY,
      r:                 ARC_R,
      fill:              'none',
      stroke:            'var(--health-excellent)',
      'stroke-width':    6,
      'stroke-linecap':  'round',
      transform:         `rotate(-90 ${CX} ${CY})`,
      style:             'transition: stroke-dashoffset 300ms ease, stroke 300ms ease-in-out;',
    });
    svg.appendChild(fillEl);

    this._fillEl = fillEl;

    // Centre score number
    this._scoreEl = svgEl('text', {
      x:            CX,
      y:            CY + 7,
      'text-anchor':      'middle',
      'dominant-baseline':'middle',
      fill:         'var(--text-primary)',
      'font-size':  '28',
      'font-weight':'300',
      'font-family':'var(--font-primary)',
    });
    this._scoreEl.textContent = '–';
    svg.appendChild(this._scoreEl);

    // ── Label below ────────────────────────────────────────────────────────
    const labelEl = document.createElement('span');
    labelEl.style.cssText = [
      'font-size: var(--text-label)',
      'color: var(--text-muted)',
      'text-transform: uppercase',
      'letter-spacing: 0.04em',
    ].join(';');
    labelEl.textContent = this._opts.label;

    this._wrapper.appendChild(svg);
    this._wrapper.appendChild(labelEl);
    this._container.appendChild(this._wrapper);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * @param {object} telemetryData
   */
  update(telemetryData) {
    const raw = _getField(telemetryData, this._opts.field);
    if (raw == null || typeof raw !== 'number') return;

    const score = Math.max(0, Math.min(100, Math.round(raw)));
    this._score = score;

    // Lazy arc length measurement
    if (this._arcLen === null && this._fillEl.isConnected) {
      // Circle circumference: 2πr
      this._arcLen = 2 * Math.PI * ARC_R;
      this._fillEl.style.strokeDasharray = this._arcLen;
    }

    if (this._arcLen !== null) {
      updateArcLength(this._fillEl, score, this._arcLen);
    }

    // Color from ramp
    const cssVar = _healthColor(score);
    this._fillEl.style.stroke = `var(${cssVar})`;

    // Update score text
    this._scoreEl.textContent = score.toString();
  }

  /**
   * No animationLoop subscription — nothing to unsubscribe.
   */
  destroy() {
    // No rAF subscriptions — CSS transitions handle animation.
  }
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

/**
 * Generate a regular hexagon SVG path (flat-top orientation).
 * @param {number} cx
 * @param {number} cy
 * @param {number} r  — circumradius
 * @returns {string}
 */
function _hexPath(cx, cy, r) {
  const points = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30); // pointy-top
    points.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
  }
  return `M ${points.join(' L ')} Z`;
}

function _healthColor(score) {
  let color = HEALTH_RAMP[0].color;
  for (const entry of HEALTH_RAMP) {
    if (score >= entry.threshold) color = entry.color;
  }
  return color;
}

function _getField(obj, path) {
  if (!path.includes('.')) return obj?.[path] ?? null;
  return path.split('.').reduce((acc, k) => acc?.[k], obj) ?? null;
}
