/**
 * energyFlowMap.js — Smart Grid Sentinel Energy Flow Map Component
 * Phase 3 deliverable. DESIGN.md §5.17, §17, §18, §19.
 *
 * SVG animated energy flow diagram with four nodes:
 *   GRID INPUT → METER → ESP32 PROTECTION → LOAD
 *
 * Animated signal dots travel along connector lines (CSS offset-path).
 * On FAULT: lines switch to .flow-line--fault color.
 * On relay OPEN: lines switch to .flow-line--interrupted, dots pause.
 *
 * Rendering: SVG via svgEngine helpers. animationLoop manages Page Visibility.
 *
 * Component interface (DESIGN.md §17):
 *   constructor(containerEl, options)
 *   update(telemetryData)
 *   destroy()
 *
 * Options:
 *   showValueOverlay {boolean}  — show live V·A·W labels on connector lines (default true)
 */

import { animationLoop }                      from '../rendering/animationLoop.js';
import { svgEl, animateOffsetPath }           from '../rendering/svgEngine.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// ── Node definitions ──────────────────────────────────────────────────────────
// Positions are in SVG user units (viewBox 600×160).
const NODES = [
  { id: 'grid',  label: 'GRID INPUT',       x:  30, y: 60 },
  { id: 'meter', label: 'METER',             x: 185, y: 60 },
  { id: 'esp32', label: 'ESP32 PROTECTION',  x: 345, y: 60 },
  { id: 'load',  label: 'LOAD',              x: 505, y: 60 },
];

const NODE_W  = 120;
const NODE_H  = 40;
const VB_W    = 660;
const VB_H    = 160;

export class EnergyFlowMap {
  /**
   * @param {HTMLElement} containerEl
   * @param {object}      options
   */
  constructor(containerEl, options = {}) {
    this._container        = containerEl;
    this._showValueOverlay = options.showValueOverlay ?? true;

    // State flags
    this._isFault    = false;
    this._relayOpen  = false;

    // Connector line + dot elements, indexed by segment
    this._flowLines   = [];  // SVGPathElement[]
    this._flowDots    = [];  // SVGCircleElement[]
    this._valueLabels = [];  // SVGTextElement[]

    this._buildDOM();

    // Frame callback keeps Page Visibility pause in sync
    this._onFrame = this._onFrame.bind(this);
    animationLoop.subscribe(this._onFrame);
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  _buildDOM() {
    this._container.style.position = 'relative';

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${VB_W} ${VB_H}`);
    svg.setAttribute('width',  '100%');
    svg.setAttribute('height', VB_H);
    svg.setAttribute('aria-label', 'Energy flow diagram: Grid to Load');
    svg.style.overflow = 'visible';
    this._svg = svg;

    // ── Arrow marker definition ────────────────────────────────────────────
    const defs   = svgEl('defs');
    const marker = svgEl('marker', {
      id:           'flow-arrow',
      viewBox:      '0 0 6 6',
      refX:         '5',
      refY:         '3',
      markerWidth:  '4',
      markerHeight: '4',
      orient:       'auto',
    });
    const arrowPath = svgEl('path', {
      d:    'M 0 0 L 6 3 L 0 6 Z',
      fill: 'var(--health-excellent)',
    });
    this._arrowHead = arrowPath;
    marker.appendChild(arrowPath);
    defs.appendChild(marker);
    svg.appendChild(defs);

    // ── Connector lines between adjacent nodes ─────────────────────────────
    for (let i = 0; i < NODES.length - 1; i++) {
      const from = NODES[i];
      const to   = NODES[i + 1];

      // Line from right edge of 'from' node to left edge of 'to' node
      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_H / 2;
      const pathD = `M ${x1} ${y1} L ${x2} ${y2}`;

      const line = svgEl('path', {
        d:               pathD,
        fill:            'none',
        class:           'flow-line',
        'marker-end':    'url(#flow-arrow)',
      });
      svg.appendChild(line);
      this._flowLines.push(line);

      // Traveling dot (offset-path)
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('r', '4');
      dot.classList.add('signal-dot', 'signal-dot--voltage');
      animateOffsetPath(dot, pathD, 1800 + i * 200);
      svg.appendChild(dot);
      this._flowDots.push(dot);

      // Value overlay label (mid-line)
      if (this._showValueOverlay) {
        const midX = (x1 + x2) / 2;
        const midY = y1 - 14;

        const label = svgEl('text', {
          x:               midX,
          y:               midY,
          'text-anchor':   'middle',
          fill:            'var(--text-muted)',
          'font-size':     '10',
          'font-family':   'var(--font-primary)',
        });
        label.textContent = '–';
        svg.appendChild(label);
        this._valueLabels.push(label);
      }
    }

    // ── Node boxes ────────────────────────────────────────────────────────────
    this._nodeEls = [];
    for (const node of NODES) {
      const group = svgEl('g');

      // Box
      const rect = svgEl('rect', {
        x:              node.x,
        y:              node.y,
        width:          NODE_W,
        height:         NODE_H,
        rx:             6,
        ry:             6,
        fill:           'var(--bg-card-dark-2)',
        stroke:         'var(--health-excellent)',
        'stroke-width': '1',
        style:          'transition: stroke 600ms ease-in-out, filter 600ms ease-in-out;',
      });

      // Label text
      const text = svgEl('text', {
        x:               node.x + NODE_W / 2,
        y:               node.y + NODE_H / 2 + 1,
        'text-anchor':   'middle',
        'dominant-baseline': 'middle',
        fill:            'var(--text-muted)',
        'font-size':     '10',
        'font-family':   'var(--font-primary)',
        'letter-spacing': '0.06em',
      });
      text.textContent = node.label;

      // Status dot (top-right of box)
      const statusDot = svgEl('circle', {
        cx:   node.x + NODE_W - 8,
        cy:   node.y + 8,
        r:    4,
        fill: 'var(--health-excellent)',
        style: 'transition: fill 600ms ease-in-out;',
      });

      group.appendChild(rect);
      group.appendChild(text);
      group.appendChild(statusDot);
      svg.appendChild(group);

      this._nodeEls.push({ rect, statusDot, text });
    }

    this._container.appendChild(svg);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * @param {object} telemetryData
   */
  update(telemetryData) {
    const isFault   = telemetryData?.state === 'FAULT'   || telemetryData?.state === 'LOCKOUT';
    const isWarning = telemetryData?.state === 'WARNING';
    const relay     = telemetryData?.relay ?? true;

    this._isFault   = isFault;
    this._relayOpen = !relay;

    // ── Update connector lines ─────────────────────────────────────────────
    for (let i = 0; i < this._flowLines.length; i++) {
      const line = this._flowLines[i];
      const dot  = this._flowDots[i];

      // The last segment (ESP32 → LOAD) is interrupted when relay is OPEN
      const interrupted = this._relayOpen && i === this._flowLines.length - 1;

      // Remove all modifier classes first
      line.classList.remove('flow-line--fault', 'flow-line--interrupted');

      if (interrupted) {
        line.classList.add('flow-line--interrupted');
        dot.style.animationPlayState = 'paused';
        dot.style.opacity            = '0';
      } else if (isFault) {
        line.classList.add('flow-line--fault');
        dot.style.animationPlayState = 'running';
        dot.style.opacity            = '';
        // Switch dot to fault color class
        dot.className.baseVal        = 'signal-dot signal-dot--fault';
      } else {
        dot.style.animationPlayState = 'running';
        dot.style.opacity            = '';
        dot.className.baseVal        = 'signal-dot signal-dot--voltage';
      }
    }

    // ── Update value overlay labels ────────────────────────────────────────
    if (this._showValueOverlay && this._valueLabels.length > 0) {
      const v = telemetryData?.v ?? 0;
      const i = telemetryData?.i ?? 0;
      const p = telemetryData?.p ?? 0;

      const overlay = `${v.toFixed(0)}V · ${i.toFixed(1)}A · ${p.toFixed(0)}W`;
      // Show on the middle connector (ESP32 input segment)
      const midIdx = Math.floor(this._valueLabels.length / 2);
      if (this._valueLabels[midIdx]) {
        this._valueLabels[midIdx].textContent = overlay;
      }
    }

    // ── Update node status dots ────────────────────────────────────────────
    const nodeStateColor = isFault
      ? 'var(--state-fault)'
      : isWarning
        ? 'var(--state-warning)'
        : 'var(--health-excellent)';

    for (let n = 0; n < this._nodeEls.length; n++) {
      const { rect, statusDot } = this._nodeEls[n];

      // ESP32 node reflects system state; others follow connectivity
      const nodeColor = (n === 2) ? nodeStateColor : 'var(--health-excellent)';
      // LOAD node dims when relay is open
      const loadDim   = (n === 3 && this._relayOpen);

      statusDot.setAttribute('fill', loadDim ? 'var(--fault-inactive)' : nodeColor);
      rect.style.stroke = loadDim ? 'var(--fault-inactive)' : (n === 2 ? nodeStateColor : 'var(--border-subtle)');
    }

    // ── Update arrowhead color ─────────────────────────────────────────────
    if (isFault) {
      this._arrowHead.setAttribute('fill', 'var(--state-fault)');
    } else {
      this._arrowHead.setAttribute('fill', 'var(--health-excellent)');
    }
  }

  /**
   * Unsubscribe from animationLoop.
   */
  destroy() {
    animationLoop.unsubscribe(this._onFrame);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _onFrame() {
    // Dots are CSS-animated. This subscription exists to participate in
    // the Page Visibility pause that animationLoop enforces globally.
  }
}
