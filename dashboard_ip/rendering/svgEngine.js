/**
 * svgEngine.js — Smart Grid Sentinel SVG Rendering Engine
 * Source of truth: DESIGN.md v3.3, Sections 18 and 19
 * FROZEN after Phase 1. Extend only — never rewrite.
 *
 * Provides shared SVG geometry helpers for all components.
 * Components NEVER write inline SVG geometry — all math lives here.
 *
 * Public API:
 *   createArcPath(cx, cy, r, startAngle, endAngle)   → SVG path d string
 *   createSignalPath(fromEl, toEl)                    → SVG path d string
 *   animateOffsetPath(el, duration)                   → void (mutates element)
 *   updateArcLength(el, score, maxLength)             → void (mutates element)
 *
 * Angle convention: 0° = 3 o'clock (standard SVG/Math convention).
 * Angles are in DEGREES, converted internally.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

// ── Angle utilities ───────────────────────────────────────────────────────

/**
 * Convert degrees to radians.
 * @param {number} deg
 * @returns {number}
 */
function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Compute a point on a circle.
 * @param {number} cx - center X
 * @param {number} cy - center Y
 * @param {number} r  - radius
 * @param {number} angleDeg - angle in degrees (0 = right / 3 o'clock)
 * @returns {{ x: number, y: number }}
 */
function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = toRad(angleDeg);
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

// ── createArcPath ─────────────────────────────────────────────────────────

/**
 * Build an SVG arc path d-string for use in <path d="..."/>.
 * Used by arcGauge.js and hexHealthCell.js.
 *
 * Arc gauges in this dashboard use a 270° sweep with a gap at the bottom:
 *   startAngle = 135°, endAngle = 45° (going clockwise through 270°)
 *
 * @param {number} cx         - center X (SVG user units)
 * @param {number} cy         - center Y
 * @param {number} r          - radius
 * @param {number} startAngle - start angle in degrees
 * @param {number} endAngle   - end angle in degrees
 * @param {boolean} [largeArcFlag] - override large-arc flag (auto-computed if omitted)
 * @returns {string} SVG path d attribute value
 *
 * @example
 * // 270° arc for a gauge (Section 5 arc gauge pattern)
 * const d = createArcPath(50, 50, 40, 135, 45);
 */
export function createArcPath(cx, cy, r, startAngle, endAngle, largeArcFlag) {
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end   = polarToCartesian(cx, cy, r, endAngle);

  // Compute the swept angle (0–360). Going clockwise from start to end.
  let sweep = endAngle - startAngle;
  if (sweep <= 0) sweep += 360;   // normalize

  // Large arc flag: 1 if arc spans more than 180°
  const large = largeArcFlag !== undefined ? (largeArcFlag ? 1 : 0) : (sweep > 180 ? 1 : 0);

  // Sweep direction: 1 = clockwise (positive angle in SVG coordinate system)
  const sweepDir = 1;

  return [
    `M ${start.x} ${start.y}`,
    `A ${r} ${r} 0 ${large} ${sweepDir} ${end.x} ${end.y}`,
  ].join(' ');
}

// ── createSignalPath ──────────────────────────────────────────────────────

/**
 * Compute an SVG cubic-bezier path string connecting two DOM elements.
 * Used by signalPath.js and energyFlowMap.js for the animated connector lines.
 *
 * Coordinates are in the SVG overlay's coordinate space.
 * The SVG overlay must be positioned over the full dashboard (position: absolute, top: 0, left: 0).
 *
 * The path is a smooth S-curve: control points are offset vertically by 40%
 * of the vertical distance, producing a visually consistent arc regardless of
 * the relative positions of source and destination elements.
 *
 * @param {HTMLElement} fromEl - source DOM element
 * @param {HTMLElement} toEl   - destination DOM element
 * @param {SVGElement}  svgEl  - the SVG overlay element (for coordinate transform)
 * @returns {string} SVG path d attribute value (M … C …)
 */
export function createSignalPath(fromEl, toEl, svgEl) {
  // getBoundingClientRect gives viewport coordinates.
  const fromRect = fromEl.getBoundingClientRect();
  const toRect   = toEl.getBoundingClientRect();
  const svgRect  = (svgEl || document.documentElement).getBoundingClientRect();

  // Anchor points: bottom-center of source, top-center of destination
  const x1 = fromRect.left + fromRect.width  / 2 - svgRect.left;
  const y1 = fromRect.bottom                     - svgRect.top;
  const x2 = toRect.left   + toRect.width   / 2 - svgRect.left;
  const y2 = toRect.top                          - svgRect.top;

  // Control points: vertical offset = 40% of total vertical span (smooth S-curve)
  const verticalSpan = Math.abs(y2 - y1);
  const offset = Math.max(verticalSpan * 0.4, 20); // minimum 20px offset

  const cp1x = x1;
  const cp1y = y1 + offset;
  const cp2x = x2;
  const cp2y = y2 - offset;

  return `M ${x1} ${y1} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`;
}

// ── animateOffsetPath ─────────────────────────────────────────────────────

/**
 * Apply a CSS offset-path animation to a signal dot element.
 * Used to make dots travel along the signal connector paths (Section 5.18 + 5.17).
 *
 * This writes the `offset-path` CSS property and ensures the `travelPath`
 * keyframe animation (defined in effects.css) is applied.
 *
 * @param {SVGElement | HTMLElement} el       - the dot element to animate
 * @param {string}                   pathD    - the SVG path d-string (from createSignalPath / createArcPath)
 * @param {number}                   [duration=2000] - animation duration in milliseconds
 *
 * @example
 * const dot = document.querySelector('.signal-dot');
 * const d   = createSignalPath(fromEl, toEl, svgOverlay);
 * animateOffsetPath(dot, d, 2000);
 */
export function animateOffsetPath(el, pathD, duration = 2000) {
  // Set the CSS offset-path to the computed path.
  // effects.css defines the travelPath keyframe; we only need to update the path.
  el.style.offsetPath           = `path('${pathD}')`;
  el.style.animationDuration    = `${duration}ms`;
  // Ensure the element has the signal-dot class (picks up travelPath animation from effects.css)
  if (!el.classList.contains('signal-dot')) {
    el.classList.add('signal-dot');
  }
}

// ── updateArcLength ───────────────────────────────────────────────────────

/**
 * Update the stroke-dasharray / stroke-dashoffset of an SVG arc element
 * to represent a score from 0–100 as a partial arc fill.
 *
 * Pattern:
 *   totalLength = circumference of the full arc (pre-computed or measured)
 *   dasharray   = totalLength
 *   dashoffset  = totalLength - (score / 100) * totalLength
 *
 * A score of 100 → full arc visible (dashoffset = 0)
 * A score of 0   → arc invisible (dashoffset = totalLength)
 *
 * @param {SVGPathElement | SVGCircleElement} el    - the arc/path element
 * @param {number}                            score - value 0–100
 * @param {number}                            [maxLength] - override total arc length
 *                                              (measured via getTotalLength() if omitted)
 *
 * @example
 * // Animate a health arc gauge to 87%
 * const arcEl = document.querySelector('#arc-voltage');
 * updateArcLength(arcEl, 87);
 */
export function updateArcLength(el, score, maxLength) {
  // Clamp score to [0, 100]
  const clamped = Math.max(0, Math.min(100, score));

  // Determine the total arc length.
  // Prefer explicit override (avoids reflow from getTotalLength on every frame).
  let total;
  if (maxLength !== undefined) {
    total = maxLength;
  } else if (typeof el.getTotalLength === 'function') {
    total = el.getTotalLength();
  } else {
    // Fallback for circle elements: circumference = 2πr
    const r = parseFloat(el.getAttribute('r') || '0');
    total   = 2 * Math.PI * r;
  }

  const filled = (clamped / 100) * total;
  const offset = total - filled;

  el.style.strokeDasharray  = `${total}`;
  el.style.strokeDashoffset = `${offset}`;
}

// ── SVG element factory helpers ───────────────────────────────────────────
// Convenience functions used by components to build SVG elements programmatically.

/**
 * Create an SVG element in the correct namespace.
 * @param {string} tag - e.g. 'path', 'circle', 'line'
 * @param {object} [attrs] - key/value attribute map
 * @returns {SVGElement}
 */
export function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

/**
 * Create a full-page SVG overlay element.
 * Used for signal path connectors (Section 5.18) — positioned absolute, covers the
 * dashboard container, pointer-events: none so it doesn't block interactions.
 *
 * @returns {SVGSVGElement}
 */
export function createOverlaySvg() {
  const svg = svgEl('svg', {
    'xmlns':           SVG_NS,
    'aria-hidden':     'true',
    'pointer-events':  'none',
  });
  svg.style.position   = 'absolute';
  svg.style.top        = '0';
  svg.style.left       = '0';
  svg.style.width      = '100%';
  svg.style.height     = '100%';
  svg.style.overflow   = 'visible';
  svg.style.zIndex     = 'var(--z-base)';
  return svg;
}
