/**
 * signalPath.js — Smart Grid Sentinel Signal Path Component
 * Phase 3 deliverable. DESIGN.md §5.18, §17, §18, §19.
 *
 * Animated SVG dot traveling along a bezier path between two DOM elements.
 * Used to draw the glowing connector lines from Zone 2 arc gauges to Zone 3B panels.
 *
 * Rendering: path geometry via svgEngine.createSignalPath() and animateOffsetPath().
 * Animation: registered with animationLoop (Page Visibility guard included in loop).
 * Pauses when relay is OPEN (relayState = false from telemetry).
 *
 * Component interface (DESIGN.md §17):
 *   constructor(containerEl, options)
 *   update(telemetryData)
 *   destroy()
 *
 * Options:
 *   fromEl    {HTMLElement}  — source element (arc gauge)
 *   toEl      {HTMLElement}  — destination element (GPU panel)
 *   dotClass  {string}       — CSS class for dot color (from effects.css)
 *                              e.g. 'signal-dot--voltage', 'signal-dot--current'
 *   svgEl     {SVGSVGElement} — shared SVG overlay (optional; created internally if not provided)
 */

import { animationLoop }                               from '../rendering/animationLoop.js';
import { createSignalPath, animateOffsetPath, svgEl as makeSvgEl, createOverlaySvg }
  from '../rendering/svgEngine.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export class SignalPath {
  /**
   * @param {HTMLElement} containerEl  — parent element; the SVG overlay is appended here
   * @param {object}      options
   */
  constructor(containerEl, options = {}) {
    this._container = containerEl;
    this._fromEl    = options.fromEl   ?? null;
    this._toEl      = options.toEl     ?? null;
    this._dotClass  = options.dotClass ?? 'signal-dot--voltage';

    // External overlay SVG or create one on the container
    if (options.svgEl) {
      this._svg          = options.svgEl;
      this._ownsSvg      = false;
    } else {
      this._svg          = createOverlaySvg();
      this._container.style.position = 'relative'; // overlay needs positioned parent
      this._container.appendChild(this._svg);
      this._ownsSvg      = true;
    }

    // Relay state — animation pauses when relay is OPEN
    this._relayOpen = false;
    this._pathD     = null;

    this._buildDOM();
    this._computePath();

    // Recompute path on window resize
    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize, { passive: true });

    // Register frame callback (needed to re-check paused state reactively)
    this._onFrame = this._onFrame.bind(this);
    animationLoop.subscribe(this._onFrame);
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  _buildDOM() {
    // Connector line (static path element — the visible line)
    this._lineEl = makeSvgEl('path', {
      fill:   'none',
      class:  'signal-path-line',
    });
    this._svg.appendChild(this._lineEl);

    // Endpoint dots (small circles at each anchor)
    this._dot1 = makeSvgEl('circle', {
      r:       3,
      opacity: '0.5',
    });
    this._dot2 = makeSvgEl('circle', {
      r:       3,
      opacity: '0.5',
    });
    this._svg.appendChild(this._dot1);
    this._svg.appendChild(this._dot2);

    // Traveling dot (signal pulse)
    this._travelDot = document.createElementNS(SVG_NS, 'circle');
    this._travelDot.setAttribute('r', '2');
    this._travelDot.classList.add('signal-dot', this._dotClass);
    this._svg.appendChild(this._travelDot);
  }

  // ── Path computation ──────────────────────────────────────────────────────

  _computePath() {
    if (!this._fromEl || !this._toEl) return;
    if (!this._fromEl.isConnected || !this._toEl.isConnected) return;

    const svgRef = this._ownsSvg ? this._svg : this._svg;
    this._pathD  = createSignalPath(this._fromEl, this._toEl, svgRef);

    // Update line element
    this._lineEl.setAttribute('d', this._pathD);

    // Update endpoint dot positions
    const fromRect = this._fromEl.getBoundingClientRect();
    const toRect   = this._toEl.getBoundingClientRect();
    const svgRect  = svgRef.getBoundingClientRect();

    const x1 = fromRect.left + fromRect.width  / 2 - svgRect.left;
    const y1 = fromRect.bottom                     - svgRect.top;
    const x2 = toRect.left   + toRect.width   / 2 - svgRect.left;
    const y2 = toRect.top                          - svgRect.top;

    this._dot1.setAttribute('cx', x1);
    this._dot1.setAttribute('cy', y1);
    this._dot2.setAttribute('cx', x2);
    this._dot2.setAttribute('cy', y2);

    // Set the stroke color on line and dots (derived from dot class)
    const strokeColor = _colorFromDotClass(this._dotClass);
    this._lineEl.style.stroke = `var(${strokeColor})`;
    this._dot1.setAttribute('fill', `var(${strokeColor})`);
    this._dot2.setAttribute('fill', `var(${strokeColor})`);

    // Apply offset-path animation to the traveling dot
    animateOffsetPath(this._travelDot, this._pathD, 1500);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * @param {object} telemetryData
   */
  update(telemetryData) {
    const prevRelay  = this._relayOpen;
    this._relayOpen  = telemetryData?.relay === false;

    // Recolor on fault state
    const isFault    = telemetryData?.state === 'FAULT';
    if (isFault) {
      this._lineEl.style.stroke = 'var(--state-fault)';
      this._dot1.setAttribute('fill', 'var(--state-fault)');
      this._dot2.setAttribute('fill', 'var(--state-fault)');
      // Switch traveling dot to fault class
      this._travelDot.className.baseVal = `signal-dot signal-dot--fault`;
    } else {
      const strokeColor = _colorFromDotClass(this._dotClass);
      this._lineEl.style.stroke = `var(${strokeColor})`;
      this._dot1.setAttribute('fill', `var(${strokeColor})`);
      this._dot2.setAttribute('fill', `var(${strokeColor})`);
      this._travelDot.className.baseVal = `signal-dot ${this._dotClass}`;
    }

    // Apply pause/resume if relay state changed
    if (prevRelay !== this._relayOpen) {
      this._applyRelayState();
    }
  }

  /**
   * Unsubscribe, remove DOM, and clean up listeners.
   */
  destroy() {
    animationLoop.unsubscribe(this._onFrame);
    window.removeEventListener('resize', this._onResize);

    this._lineEl?.remove();
    this._dot1?.remove();
    this._dot2?.remove();
    this._travelDot?.remove();

    if (this._ownsSvg) {
      this._svg.remove();
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  _onFrame() {
    // Nothing to draw per frame — the traveling dot is CSS-animated.
    // This subscription exists so the component participates in the
    // Page Visibility pause (animationLoop already handles tab-hidden state).
  }

  _onResize() {
    // Recompute bezier path on viewport resize
    this._computePath();
  }

  _applyRelayState() {
    if (this._relayOpen) {
      // Pause traveling dot — animation:none equivalent
      this._travelDot.style.animationPlayState = 'paused';
      this._travelDot.style.opacity            = '0';
      this._lineEl.classList.add('flow-line--interrupted');
    } else {
      this._travelDot.style.animationPlayState = 'running';
      this._travelDot.style.opacity            = '';
      this._lineEl.classList.remove('flow-line--interrupted');
    }
  }
}

// ── Color helpers ─────────────────────────────────────────────────────────────

/**
 * Map a signal dot CSS class name to its stroke color CSS variable.
 */
function _colorFromDotClass(dotClass) {
  const map = {
    'signal-dot--voltage':     '--wave-voltage',
    'signal-dot--current':     '--wave-current',
    'signal-dot--temperature': '--state-warning',
    'signal-dot--fault':       '--state-fault',
  };
  return map[dotClass] ?? '--wave-voltage';
}
