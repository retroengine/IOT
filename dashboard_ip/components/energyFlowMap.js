/**
 * energyFlowMap.js — Smart Grid Sentinel Energy Flow Map Component
 * Phase 3 deliverable. DESIGN.md §5.17, §17, §18, §19.
 *
 * SVG animated energy flow diagram with four nodes:
 *   GRID INPUT → METER → ESP32 PROTECTION → LOAD
 *
 * Animated signal dots travel along connector pipe paths (CSS offset-path).
 * On FAULT: lines switch to .flow-line--fault color, pipe backs turn red.
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
 *   showValueOverlay {boolean} — show live V·A·W labels on connector pipes (default true)
 *
 * ── Visual revision 2 — step-flow pipeline redesign ──────────────────────────
 *
 *  CHANGES FROM REVISION 1:
 *
 *    NODE_W          128 → 138    (+10px — label breathing room)
 *    GAP              23 → 41     (recomputed from formula — wider pipe lanes)
 *    Node shape      rect → chevron polygon (directional arrow-tab):
 *                      • First node:  flat-left, arrow-right tip
 *                      • Middle nodes: notched-left, arrow-right tip
 *                      • Last node:   notched-left, flat-right
 *    Connector       3-layer pipe assembly per segment:
 *                      1. pipeBack  — semi-transparent rounded rect (pipe body)
 *                      2. flow-line — animated offset-path line (energy travel)
 *                      3. highlight — thin bright line offset -4px (3D pipe illusion)
 *    Arrow marker    REMOVED — chevron node shape provides directionality.
 *                      No <marker> defs, no marker-end attribute on paths.
 *                      this._arrowHead and its update() block removed.
 *    this._pipeBacks NEW — array of bg rect elements; updated in update() for
 *                      fault / interrupted / normal color states.
 *    Status dot cx   Adjusted: non-last nodes use (x + NODE_W - ARROW_TIP - 8)
 *                      to keep dot inside the rectangular body, not in the tip.
 *
 *  INLINE STYLE OVERRIDE PATTERN (from revision 1) FULLY RETAINED:
 *    effects.css (FROZEN): .flow-line { opacity:0.35; stroke-width:1.5px }
 *    A CSS class rule outranks SVG presentation attributes in specificity.
 *    All opacity / stroke-width values are set via element.style (inline style),
 *    which always wins. Presentation attributes for these properties: NEVER used.
 *    Modifier classes (.flow-line--fault, .flow-line--interrupted) are still
 *    applied for stroke color and stroke-dasharray only.
 *    In update(), line.style.cssText is always set explicitly.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { animationLoop }              from '../rendering/animationLoop.js';
import { svgEl, animateOffsetPath }   from '../rendering/svgEngine.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// ── Layout constants ──────────────────────────────────────────────────────────
const NODE_W   = 138;   // increased from 128 — gives labels more horizontal room
const NODE_H   = 56;
const VB_W     = 660;   // MUST match container; never change
const VB_H     = 185;   // MUST match container; never change

// Chevron geometry
const ARROW_TIP = 12;   // depth of right-pointing arrow tip (non-last nodes)
const NOTCH_D   = 10;   // depth of left-side notch indent (non-first nodes)

// Equal spacing: 4 nodes × 138px = 552px. Remaining: 660 − 552 − 24 (side pads) = 84px.
// 3 gaps = 84 / 3 = 28px each.
const SIDE_PAD = 12;
const GAP      = Math.round((VB_W - 4 * NODE_W - 2 * SIDE_PAD) / 3); // 41

// Nodes vertically centered in viewBox
const NODE_Y   = Math.round((VB_H - NODE_H) / 2); // 67

// ── Node definitions ──────────────────────────────────────────────────────────
const NODES = [
  { id: 'grid',  label: 'GRID INPUT',      x: SIDE_PAD + 0 * (NODE_W + GAP) },
  { id: 'meter', label: 'METER',            x: SIDE_PAD + 1 * (NODE_W + GAP) },
  { id: 'esp32', label: 'ESP32 PROTECTION', x: SIDE_PAD + 2 * (NODE_W + GAP) },
  { id: 'load',  label: 'LOAD',             x: SIDE_PAD + 3 * (NODE_W + GAP) },
].map(n => ({ ...n, y: NODE_Y }));

// ── Inline style strings for flow lines ──────────────────────────────────────
// These MUST be inline style to override the frozen .flow-line { opacity:0.35; stroke-width:1.5px }
// rule in effects.css. Never set these via SVG presentation attributes.
const LINE_STYLE_NORMAL      = 'opacity:0.0;stroke-width:3px;';   // pipe path invisible; dots ride it
const LINE_STYLE_FAULT       = 'opacity:0.0;stroke-width:3px;';
const LINE_STYLE_INTERRUPTED = 'opacity:0.0;stroke-width:2px;stroke-dasharray:6 5;';

// Pipe background rect inline styles (not subject to flow-line class rules)
const PIPE_STYLE_NORMAL      = 'fill:var(--health-excellent);opacity:0.38;transition:fill 600ms ease-in-out,opacity 600ms ease-in-out;';
const PIPE_STYLE_FAULT       = 'fill:var(--state-fault);opacity:0.55;transition:fill 600ms ease-in-out,opacity 600ms ease-in-out;';
const PIPE_STYLE_INTERRUPTED = 'fill:var(--fault-inactive);opacity:0.15;transition:fill 600ms ease-in-out,opacity 600ms ease-in-out;';

// ── Chevron polygon point generator ──────────────────────────────────────────
/**
 * Returns an SVG `points` attribute string for a directional chevron node.
 *
 * @param {number}  x        - node left edge x
 * @param {number}  y        - node top edge y
 * @param {boolean} isFirst  - flat left side (no notch)
 * @param {boolean} isLast   - flat right side (no arrow tip)
 * @returns {string}
 */
function chevronPoints(x, y, isFirst, isLast) {
  const w   = NODE_W;
  const h   = NODE_H;
  const mid = y + h / 2;

  if (isFirst && isLast) {
    // Single node — plain rect fallback (should never occur in 4-node layout)
    return `${x},${y} ${x + w},${y} ${x + w},${y + h} ${x},${y + h}`;
  }

  if (isFirst) {
    // Flat left, arrow-tip right
    return [
      `${x},${y}`,
      `${x + w - ARROW_TIP},${y}`,
      `${x + w},${mid}`,
      `${x + w - ARROW_TIP},${y + h}`,
      `${x},${y + h}`,
    ].join(' ');
  }

  if (isLast) {
    // Notch left, flat right
    return [
      `${x + NOTCH_D},${y}`,
      `${x + w},${y}`,
      `${x + w},${y + h}`,
      `${x + NOTCH_D},${y + h}`,
      `${x},${mid}`,
    ].join(' ');
  }

  // Notch left, arrow-tip right (all middle nodes)
  return [
    `${x + NOTCH_D},${y}`,
    `${x + w - ARROW_TIP},${y}`,
    `${x + w},${mid}`,
    `${x + w - ARROW_TIP},${y + h}`,
    `${x + NOTCH_D},${y + h}`,
    `${x},${mid}`,
  ].join(' ');
}

export class EnergyFlowMap {
  /**
   * @param {HTMLElement} containerEl
   * @param {object}      options
   */
  constructor(containerEl, options = {}) {
    this._container        = containerEl;
    this._showValueOverlay = options.showValueOverlay ?? true;

    this._isFault   = false;
    this._relayOpen = false;

    this._flowLines   = [];   // SVGPathElement[]  — invisible; signal dots ride on them
    this._flowDots    = [];   // SVGCircleElement[]
    this._pipeBacks   = [];   // SVGRectElement[]  — visible pipe body
    this._valueLabels = [];   // SVGTextElement[]

    this._buildDOM();

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

    // ── Defs ──────────────────────────────────────────────────────────────
    const defs = svgEl('defs');

    // Soft glow filter — applied only to the ESP32 PROTECTION node (focal node)
    const filter = svgEl('filter', {
      id:     'node-glow',
      x:      '-20%',
      y:      '-35%',
      width:  '140%',
      height: '170%',
    });
    const feBlur = svgEl('feGaussianBlur', {
      in:           'SourceGraphic',
      stdDeviation: '4',
      result:       'blur',
    });
    const feComp = svgEl('feComposite', {
      in:       'SourceGraphic',
      in2:      'blur',
      operator: 'over',
    });
    filter.appendChild(feBlur);
    filter.appendChild(feComp);
    defs.appendChild(filter);

    svg.appendChild(defs);

    // ── Pipe connectors ────────────────────────────────────────────────────
    // Each connector is a 3-layer stack:
    //   1. pipeBack  — semi-transparent rounded rect; visible pipe body
    //   2. flow-line — hidden animated offset-path; signal dots travel on it
    //   3. highlight — thin bright line -4px above centre; 3D pipe illusion
    //
    // NOTE: flow-line paths are set to opacity:0 via inline style so the SVG
    // path itself is invisible. Only the animated dots riding it are seen.
    // This sidesteps the frozen effects.css opacity:0.35 conflict entirely.
    // The pipeBack rect provides the visible pipe stroke instead.

    const midY = NODE_Y + NODE_H / 2;

    for (let i = 0; i < NODES.length - 1; i++) {
      const from = NODES[i];
      const to   = NODES[i + 1];

      // Connector x extents: tip of left chevron → notch of right chevron
      const x1 = from.x + NODE_W;   // right edge of from-node (tip of arrow)
      const x2 = to.x;              // left edge of to-node   (notch entry)

      // ── Layer 1: pipe background rect ─────────────────────────────────
      const pipeH = 10;
      const pipeBack = svgEl('rect', {
        x:      x1,
        y:      midY - pipeH / 2,
        width:  x2 - x1,
        height: pipeH,
        rx:     3,
        ry:     3,
        style:  PIPE_STYLE_NORMAL,
      });
      svg.appendChild(pipeBack);
      this._pipeBacks.push(pipeBack);

      // ── Layer 2: invisible path for offset-path animation ─────────────
      const pathD = `M ${x1} ${midY} L ${x2} ${midY}`;
      const line = svgEl('path', {
        d:     pathD,
        fill:  'none',
        class: 'flow-line',
        // KEY: opacity:0 hides the SVG path while the dot still animates on it.
        // This avoids any conflict with the frozen effects.css .flow-line rule.
        style: LINE_STYLE_NORMAL,
      });
      svg.appendChild(line);
      this._flowLines.push(line);

      // ── Layer 3: signal dot — rides the invisible path ─────────────────
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('r', '5');
      dot.classList.add('signal-dot', 'signal-dot--voltage');
      animateOffsetPath(dot, pathD, 1800 + i * 200);
      svg.appendChild(dot);
      this._flowDots.push(dot);

      // ── Layer 4: highlight line — 3D pipe illusion ─────────────────────
      const hlInset = 5;   // keep a few px from node edges to avoid overlap
      const highlight = svgEl('line', {
        x1:    String(x1 + hlInset),
        y1:    String(midY - 3),
        x2:    String(x2 - hlInset),
        y2:    String(midY - 3),
        style: 'stroke:rgba(255,255,255,0.22);stroke-width:1.5px;stroke-linecap:round;',
      });
      svg.appendChild(highlight);

    }

    // ── Single value overlay label ─────────────────────────────────────────
    // ONE label, centered above the full pipeline at y = NODE_Y - 22.
    //
    // BUG FIX (Bug 1): Previous version created a label per connector segment
    //   (3 labels), all initialized to "–". update() only writes to midIdx=1.
    //   Segments 0 and 2 permanently showed "–" on screen.
    //   Fix: exactly one element — midIdx = floor(1/2) = 0. update() unchanged.
    //
    // BUG FIX (Bug 2): Label placed at gap midX (~329px), text ~160px wide,
    //   clipped by container overflow:hidden when it bled into node areas.
    //   Fix: center at VB_W/2 = 330, y = NODE_Y - 22 = 45 — open space above
    //   nodes, no overlap, no clipping.
    if (this._showValueOverlay) {
      const label = svgEl('text', {
        x:             String(VB_W / 2),
        y:             String(NODE_Y - 22),
        'text-anchor': 'middle',
        'font-family': 'var(--font-primary)',
        style:         'fill:var(--text-primary);opacity:0.65;font-size:11px;font-weight:500;letter-spacing:0.04em;',
      });
      label.textContent = '';
      svg.appendChild(label);
      this._valueLabels.push(label);
    }

    // ── Chevron node shapes ────────────────────────────────────────────────
    this._nodeEls = [];
    for (let idx = 0; idx < NODES.length; idx++) {
      const node    = NODES[idx];
      const isFirst = idx === 0;
      const isLast  = idx === NODES.length - 1;
      const group   = svgEl('g');

      // Chevron polygon — directional arrow-tab shape
      const shape = svgEl('polygon', {
        points:          chevronPoints(node.x, node.y, isFirst, isLast),
        fill:            'var(--bg-card-dark-2)',
        stroke:          'var(--health-excellent)',
        'stroke-width':  '1.5',
        'stroke-linejoin': 'miter',
        style:           'transition: stroke 600ms ease-in-out, filter 600ms ease-in-out;',
      });

      // Apply focal glow to ESP32 PROTECTION node (index 2)
      if (idx === 2) {
        shape.setAttribute('filter', 'url(#node-glow)');
      }

      // Node label — white semibold text, centered in the polygon bounding box.
      // All typographic properties are in inline style to ensure they cannot
      // be overridden by any CSS class affecting SVG text fill.
      const text = svgEl('text', {
        x:                   node.x + NODE_W / 2,
        y:                   node.y + NODE_H / 2 + 1,
        'text-anchor':       'middle',
        'dominant-baseline': 'middle',
        'font-family':       'var(--font-primary)',
        style:               'fill:var(--text-primary);font-size:10.5px;font-weight:600;letter-spacing:0.07em;',
      });
      text.textContent = node.label;

      // Status dot — positioned inside rectangular body, clear of chevron tip.
      // Non-last nodes: offset back by ARROW_TIP + 8px so dot stays in the body.
      // Last node: standard top-right corner placement.
      const dotCX = isLast
        ? node.x + NODE_W - 10
        : node.x + NODE_W - ARROW_TIP - 8;

      const statusDot = svgEl('circle', {
        cx:    dotCX,
        cy:    node.y + 10,
        r:     5,
        fill:  'var(--health-excellent)',
        style: 'transition: fill 600ms ease-in-out;',
      });

      group.appendChild(shape);
      group.appendChild(text);
      group.appendChild(statusDot);
      svg.appendChild(group);

      // Store shape under key 'rect' so update() logic is unchanged
      this._nodeEls.push({ rect: shape, statusDot, text });
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

    // ── Update connector flow lines & signal dots ──────────────────────────
    for (let i = 0; i < this._flowLines.length; i++) {
      const line = this._flowLines[i];
      const dot  = this._flowDots[i];

      const interrupted = this._relayOpen && i === this._flowLines.length - 1;

      // Remove modifier classes — they handle stroke color & dasharray only.
      // Opacity and stroke-width are exclusively managed via inline style.
      line.classList.remove('flow-line--fault', 'flow-line--interrupted');

      if (interrupted) {
        line.classList.add('flow-line--interrupted');
        // cssText replaces all inline style — ensures explicit opacity always present
        line.style.cssText           = LINE_STYLE_INTERRUPTED;
        dot.style.animationPlayState = 'paused';
        dot.style.opacity            = '0';
      } else if (isFault) {
        line.classList.add('flow-line--fault');
        line.style.cssText           = LINE_STYLE_FAULT;
        dot.style.animationPlayState = 'running';
        dot.style.opacity            = '';
        dot.className.baseVal        = 'signal-dot signal-dot--fault';
      } else {
        line.style.cssText           = LINE_STYLE_NORMAL;
        dot.style.animationPlayState = 'running';
        dot.style.opacity            = '';
        dot.className.baseVal        = 'signal-dot signal-dot--voltage';
      }
    }

    // ── Update pipe background rects ──────────────────────────────────────
    for (let i = 0; i < this._pipeBacks.length; i++) {
      const pb           = this._pipeBacks[i];
      const interrupted  = this._relayOpen && i === this._pipeBacks.length - 1;

      if (interrupted) {
        pb.style.cssText = PIPE_STYLE_INTERRUPTED;
      } else if (isFault) {
        pb.style.cssText = PIPE_STYLE_FAULT;
      } else {
        pb.style.cssText = PIPE_STYLE_NORMAL;
      }
    }

    // ── Update value overlay label ─────────────────────────────────────────
    if (this._showValueOverlay && this._valueLabels.length > 0) {
      const v = telemetryData?.v ?? 0;
      const a = telemetryData?.i ?? 0;
      const p = telemetryData?.p ?? 0;

      const overlay = `${v.toFixed(0)}V · ${a.toFixed(1)}A · ${p.toFixed(0)}W`;
      // Centre segment (index 1 of 3 segments = Meter→ESP32) shows live readings
      const midIdx = Math.floor(this._valueLabels.length / 2);
      if (this._valueLabels[midIdx]) {
        this._valueLabels[midIdx].textContent = overlay;
      }
    }

    // ── Update node status dots & border colors ────────────────────────────
    const nodeStateColor = isFault
      ? 'var(--state-fault)'
      : isWarning
        ? 'var(--state-warning)'
        : 'var(--health-excellent)';

    for (let n = 0; n < this._nodeEls.length; n++) {
      const { rect, statusDot } = this._nodeEls[n];
      const nodeColor = (n === 2) ? nodeStateColor : 'var(--health-excellent)';
      const loadDim   = (n === 3 && this._relayOpen);

      statusDot.setAttribute('fill',
        loadDim ? 'var(--fault-inactive)' : nodeColor
      );
      rect.setAttribute('stroke',
        loadDim   ? 'var(--fault-inactive)'
        : n === 2 ? nodeStateColor
                  : 'var(--border-subtle)'
      );
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
    // Signal dots are CSS-animated. This subscription participates in the
    // Page Visibility pause that animationLoop enforces globally.
  }
}