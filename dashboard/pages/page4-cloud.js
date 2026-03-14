/**
 * page4-cloud.js — Smart Grid Sentinel Page 4: Cloud / MQTT
 * Phase 7 deliverable. DESIGN.md §11, §17.
 *
 * Live MQTT connection monitoring, signal-path visualiser, and
 * payload inspector. Read-only — no publish / control actions.
 *
 * Layout (top → bottom):
 *   Row 1  — MQTT Connection Status card
 *   Row 2  — Signal Path SVG diagram (ESP32 → MQTT Broker → Cloud → Dashboard)
 *   Row 3  — MQTT Payload Inspector (last 20 telemetry frames)
 *
 * NOTE: The Phase 3 SignalPath component is an overlay bezier-connector
 * between two existing DOM elements.  That interface does not suit a
 * standalone 4-node flow diagram, so this page builds its own SVG
 * signal-path — consistent visual language, no import misuse.
 *
 * Page lifecycle (DESIGN.md §17):
 *   mount(containerEl)    — instantiate components, inject styles
 *   update(telemetryData) — rate-gate updates per field group
 *   destroy()             — tear down, remove injected styles
 *
 * Update rate gates:
 *   always — payload inspector capture
 *   1 Hz   — counters, connection dot, last-publish timestamp
 *   0.5 Hz — signal path node colour refresh
 */

import { MqttPayloadInspector } from '../components/mqttPayloadInspector.js';

// ── Style injection ────────────────────────────────────────────────────────
const STYLE_ID   = 'p4-page-styles';
const LAYOUT_CLS = 'p4-active';

const PAGE4_CSS = `
/* ─── Page 4 root layout ─── */
.p4-active {
  display: flex !important;
  flex-direction: column;
  gap: var(--space-md);
  padding: var(--space-lg) var(--space-xl);
}

/* ─── Cards ─── */
.p4-card {
  background: var(--bg-card-dark);
  border-radius: var(--radius-md);
  padding: var(--space-md);
}
.p4-card-hdr {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: var(--space-sm);
}

/* ─── Page title ─── */
.p4-page-hdr {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: var(--space-md) var(--space-xl) 0;
}
.p4-page-title {
  font-size: var(--text-section);
  font-weight: 300;
  color: var(--text-primary);
  letter-spacing: 0.02em;
}

/* ─── Connection Status ─── */
.p4-status-grid {
  display: grid;
  grid-template-columns: auto 1fr 1fr 1fr 1fr;
  gap: var(--space-md);
  align-items: center;
}

.p4-conn-dot-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 64px;
}
.p4-conn-dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--state-fault);
  transition: background 400ms ease, box-shadow 400ms ease;
}
.p4-conn-dot.connected {
  background: var(--health-excellent);
  box-shadow: 0 0 10px var(--health-excellent);
  animation: p4-pulse 2.4s ease-in-out infinite;
}
@keyframes p4-pulse {
  0%, 100% { box-shadow: 0 0 8px var(--health-excellent); }
  50%       { box-shadow: 0 0 18px var(--health-excellent), 0 0 30px var(--health-excellent); }
}
.p4-conn-label {
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  white-space: nowrap;
}

.p4-stat-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 12px;
  background: rgba(255,255,255,0.03);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
}
.p4-stat-lbl {
  font-size: 9px;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.p4-stat-val {
  font-size: 20px;
  font-family: var(--font-mono);
  font-weight: 300;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  transition: color 400ms ease;
}
.p4-stat-sub {
  font-size: 9px;
  color: var(--text-faint);
  font-family: var(--font-mono);
}

.p4-broker-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.p4-broker-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 14px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--wave-voltage) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--wave-voltage) 35%, transparent);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--wave-voltage);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 340px;
}
.p4-tls-badge {
  display: inline-flex;
  align-items: center;
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.04em;
}
.p4-tls-badge.on  {
  background: color-mix(in srgb, var(--health-excellent) 18%, transparent);
  border: 1px solid var(--health-excellent);
  color: var(--health-excellent);
}
.p4-tls-badge.off {
  background: color-mix(in srgb, var(--state-fault) 18%, transparent);
  border: 1px solid var(--state-fault);
  color: var(--state-fault);
}
.p4-last-pub {
  font-size: 10px;
  color: var(--text-faint);
  font-family: var(--font-mono);
  margin-top: 6px;
}

/* ─── Signal Path SVG diagram ─── */
.p4-sigpath-svg {
  display: block;
  width: 100%;
  max-width: 760px;
  height: 120px;
  margin: 0 auto;
}

/* Travelling dot animation */
@keyframes p4-travel {
  0%   { offset-distance: 0%;   opacity: 1; }
  85%  { offset-distance: 100%; opacity: 0.7; }
  100% { offset-distance: 100%; opacity: 0; }
}

/* ─── Responsive ─── */
@media (max-width: 900px) {
  .p4-status-grid { grid-template-columns: auto 1fr 1fr; }
}
@media (max-width: 600px) {
  .p4-status-grid { grid-template-columns: 1fr 1fr; }
  .p4-conn-dot-wrap { display: none; }
}
`;

// ── Constants ────────────────────────────────────────────────────────────────
const SVG_NS = 'http://www.w3.org/2000/svg';

const PATH_NODES = [
  { id: 'esp32',     label: 'ESP32',       sub: 'Device',      icon: '⚙' },
  { id: 'broker',    label: 'MQTT Broker', sub: 'Message Bus', icon: '⟳' },
  { id: 'cloud',     label: 'Cloud',       sub: 'Backend',     icon: '☁' },
  { id: 'dashboard', label: 'Dashboard',   sub: 'This UI',     icon: '◫' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function _get(obj, path, fallback = null) {
  if (!path || obj == null) return fallback;
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return fallback;
    cur = cur[p];
  }
  return cur ?? fallback;
}

function _el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls)  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function _svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function _fmtTime(epochMs) {
  if (!epochMs) return '–';
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function _fmtCount(n) {
  if (n == null || !isFinite(n)) return '–';
  return n.toLocaleString();
}

function _injectStyle(id, css) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

// ══════════════════════════════════════════════════════════════════════════
// Page4Cloud
// ══════════════════════════════════════════════════════════════════════════

export class Page4Cloud {

  constructor() {
    this._allComponents  = [];
    this._lastHz1Update  = 0;
    this._lastSlowUpdate = 0;

    // Connection Status DOM refs
    this._connDotEl    = null;
    this._connLabelEl  = null;
    this._brokerPillEl = null;
    this._tlsBadgeEl   = null;
    this._lastPubEl    = null;
    this._statEls      = {};

    // Signal path SVG node and link refs
    this._pathNodeRefs = {};  // nodeId → { circle, glow, icon, label }
    this._pathLinkRefs = {};  // 'a-b'  → { line, travelDot }

    // Inspector
    this._inspector = null;

    this._lastConnected = null;
  }

  // ── mount ──────────────────────────────────────────────────────────────

  mount(containerEl) {
    this._container = containerEl;
    _injectStyle(STYLE_ID, PAGE4_CSS);

    containerEl.innerHTML = '';
    containerEl.classList.add(LAYOUT_CLS);

    this._buildPageHeader(containerEl);
    this._buildStatusCard(containerEl);
    this._buildSignalPathCard(containerEl);
    this._buildInspectorCard(containerEl);
  }

  // ── update ────────────────────────────────────────────────────────────

  update(telemetryData) {
    if (!telemetryData) return;
    const now = Date.now();

    // Always: capture frame in inspector
    this._inspector?.update(telemetryData);

    // 1 Hz: counters, dot, broker meta
    if (now - this._lastHz1Update >= 1000) {
      this._lastHz1Update = now;

      const connected = !!_get(telemetryData, 'network.mqtt.connected',
                               _get(telemetryData, 'mqtt.connected', false));
      if (connected !== this._lastConnected) {
        this._updateConnDot(connected);
        this._lastConnected = connected;
      }
      this._updateCounters(telemetryData);
      this._updateBrokerMeta(telemetryData);
    }

    // 0.5 Hz: signal path
    if (now - this._lastSlowUpdate >= 2000) {
      this._lastSlowUpdate = now;
      this._updateSignalPath(telemetryData);
    }
  }

  // ── destroy ───────────────────────────────────────────────────────────

  destroy() {
    for (const c of this._allComponents) {
      try { c.destroy(); } catch (e) { console.error('[page4]', e); }
    }
    this._allComponents = [];

    this._container?.classList.remove(LAYOUT_CLS);
    if (this._container) this._container.innerHTML = '';
    document.getElementById(STYLE_ID)?.remove();
  }

  // ══════════════════════════════════════════════════════════════════════
  // Page header
  // ══════════════════════════════════════════════════════════════════════

  _buildPageHeader(parent) {
    const hdr = _el('div', 'p4-page-hdr');
    hdr.appendChild(_el('h2', 'p4-page-title', 'Cloud / MQTT'));
    parent.appendChild(hdr);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Row 1 — MQTT Connection Status
  // ══════════════════════════════════════════════════════════════════════

  _buildStatusCard(parent) {
    const card = _el('div', 'p4-card');
    card.appendChild(_el('div', 'p4-card-hdr', 'MQTT CONNECTION STATUS'));

    const grid = _el('div', 'p4-status-grid');

    // Dot + label
    const dotWrap = _el('div', 'p4-conn-dot-wrap');
    this._connDotEl   = _el('div', 'p4-conn-dot');
    this._connLabelEl = _el('div', 'p4-conn-label', 'OFFLINE');
    dotWrap.appendChild(this._connDotEl);
    dotWrap.appendChild(this._connLabelEl);
    grid.appendChild(dotWrap);

    // Stat cells
    const statDefs = [
      { key: 'sent',        label: 'Messages Sent',    sub: 'total published' },
      { key: 'failed',      label: 'Failed Publishes', sub: 'delivery errors' },
      { key: 'reconnects',  label: 'Reconnects',       sub: 'since boot'      },
      { key: 'success_pct', label: 'Success Rate',     sub: 'publish quality' },
    ];
    this._statEls = {};
    for (const def of statDefs) {
      const cell = _el('div', 'p4-stat-cell');
      cell.appendChild(_el('div', 'p4-stat-lbl', def.label));
      const val = _el('div', 'p4-stat-val', '–');
      cell.appendChild(val);
      cell.appendChild(_el('div', 'p4-stat-sub', def.sub));
      grid.appendChild(cell);
      this._statEls[def.key] = val;
    }

    card.appendChild(grid);

    // Broker pill + TLS badge
    const brokerRow = _el('div', 'p4-broker-row');
    this._brokerPillEl = _el('div', 'p4-broker-pill', '–');
    this._tlsBadgeEl   = _el('span', 'p4-tls-badge off', 'TLS OFF');
    brokerRow.appendChild(this._brokerPillEl);
    brokerRow.appendChild(this._tlsBadgeEl);
    card.appendChild(brokerRow);

    // Last published
    this._lastPubEl = _el('div', 'p4-last-pub', 'Last published: –');
    card.appendChild(this._lastPubEl);

    parent.appendChild(card);
  }

  _updateConnDot(connected) {
    if (!this._connDotEl) return;
    if (connected) {
      this._connDotEl.className     = 'p4-conn-dot connected';
      this._connLabelEl.textContent = 'CONNECTED';
      this._connLabelEl.style.color = 'var(--health-excellent)';
    } else {
      this._connDotEl.className     = 'p4-conn-dot';
      this._connLabelEl.textContent = 'OFFLINE';
      this._connLabelEl.style.color = 'var(--state-fault)';
    }
  }

  _updateCounters(data) {
    const mqtt   = _get(data, 'network.mqtt', null) ?? _get(data, 'mqtt', null) ?? {};
    const sentN  = typeof mqtt.publish_total    === 'number' ? mqtt.publish_total    : null;
    const failN  = typeof mqtt.publish_failed   === 'number' ? mqtt.publish_failed   : null;
    const reconN = typeof mqtt.connect_attempts === 'number' ? mqtt.connect_attempts : null;

    let successPct = null;
    if (sentN != null && failN != null && sentN > 0) {
      successPct = (sentN - failN) / sentN * 100;
    }

    const _set = (key, value, color) => {
      const el = this._statEls[key];
      if (!el) return;
      el.textContent = value;
      if (color) el.style.color = color;
    };

    _set('sent',      sentN  != null ? _fmtCount(sentN)  : '–');
    _set('failed',    failN  != null ? _fmtCount(failN)  : '–',
         failN  > 0 ? 'var(--state-warning)' : null);
    _set('reconnects',reconN != null ? _fmtCount(reconN) : '–',
         reconN > 3 ? 'var(--state-warning)' : null);

    if (successPct != null) {
      const color = successPct >= 95 ? 'var(--health-excellent)' :
                    successPct >= 80 ? 'var(--state-warning)'    :
                                       'var(--state-fault)';
      _set('success_pct', successPct.toFixed(1) + '%', color);
    }

    if (this._lastPubEl) {
      this._lastPubEl.textContent = `Last published: ${_fmtTime(data.ts || null)}`;
    }
  }

  _updateBrokerMeta(data) {
    const deviceId = _get(data, 'device', '–');
    const mqtt     = _get(data, 'network.mqtt', null) ?? _get(data, 'mqtt', null) ?? {};
    const tls      = mqtt.tls       ?? false;
    const connected= mqtt.connected ?? false;

    if (this._brokerPillEl) {
      this._brokerPillEl.textContent = connected
        ? `mqtt://broker ← ${deviceId}`
        : `offline (device: ${deviceId})`;
    }
    if (this._tlsBadgeEl) {
      if (tls) {
        this._tlsBadgeEl.className   = 'p4-tls-badge on';
        this._tlsBadgeEl.textContent = '🔒 TLS ON';
      } else {
        this._tlsBadgeEl.className   = 'p4-tls-badge off';
        this._tlsBadgeEl.textContent = 'TLS OFF';
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Row 2 — Signal Path SVG Diagram
  // ══════════════════════════════════════════════════════════════════════

  _buildSignalPathCard(parent) {
    const card = _el('div', 'p4-card');
    card.appendChild(_el('div', 'p4-card-hdr', 'SIGNAL PATH'));
    this._buildSignalSvg(card);
    parent.appendChild(card);
  }

  _buildSignalSvg(parent) {
    const W    = 760;
    const H    = 120;
    const CY   = H / 2;
    const N    = PATH_NODES.length;
    const PAD  = 70;
    const STEP = (W - PAD * 2) / (N - 1);
    const R    = 22;

    const svg = _svgEl('svg', {
      viewBox: `0 0 ${W} ${H}`,
      preserveAspectRatio: 'xMidYMid meet',
      class: 'p4-sigpath-svg',
    });

    // Connector lines + travelling dots (behind nodes)
    this._pathLinkRefs = {};
    for (let i = 0; i < N - 1; i++) {
      const x1 = PAD + i * STEP + R + 2;
      const x2 = PAD + (i + 1) * STEP - R - 2;
      const linkId = `${PATH_NODES[i].id}-${PATH_NODES[i + 1].id}`;

      // Dashed connector line
      const line = _svgEl('line', {
        x1, y1: CY, x2, y2: CY,
        stroke: 'var(--border-subtle)',
        'stroke-width': '1.5',
        'stroke-dasharray': '5 4',
      });
      line.style.transition = 'stroke 500ms ease, opacity 500ms ease';
      svg.appendChild(line);

      // Travelling dot using CSS offset-path
      const pathStr = `M ${x1} ${CY} L ${x2} ${CY}`;
      const travelDot = _svgEl('circle', { r: '4', fill: 'var(--health-excellent)' });
      travelDot.style.cssText = [
        `offset-path: path("${pathStr}")`,
        'offset-distance: 0%',
        `animation: p4-travel ${1.5 + i * 0.12}s ease-in-out infinite`,
        `animation-delay: ${i * 0.45}s`,
        'animation-play-state: paused',
      ].join(';');
      svg.appendChild(travelDot);

      this._pathLinkRefs[linkId] = { line, travelDot };
    }

    // Node circles + labels (rendered on top of lines)
    this._pathNodeRefs = {};
    for (let i = 0; i < N; i++) {
      const node = PATH_NODES[i];
      const cx   = PAD + i * STEP;

      // Outer glow (initially transparent)
      const glow = _svgEl('circle', {
        cx, cy: CY, r: R + 7,
        fill: 'none',
        stroke: 'var(--health-excellent)',
        'stroke-width': '1',
        opacity: '0',
      });
      glow.style.transition = 'opacity 500ms ease, stroke 500ms ease';
      svg.appendChild(glow);

      // Main circle
      const circle = _svgEl('circle', {
        cx, cy: CY, r: R,
        fill:   'var(--bg-card-dark)',
        stroke: 'var(--border-subtle)',
        'stroke-width': '1.5',
      });
      circle.style.transition = 'stroke 500ms ease, opacity 500ms ease';
      svg.appendChild(circle);

      // Icon
      const icon = _svgEl('text', {
        x: cx, y: CY - 2,
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
        fill: 'var(--text-muted)',
        'font-size': '14',
        'font-family': 'var(--font-primary)',
      });
      icon.textContent = node.icon;
      icon.style.transition = 'fill 500ms ease';
      svg.appendChild(icon);

      // Node label
      const label = _svgEl('text', {
        x: cx, y: CY + R + 13,
        'text-anchor': 'middle',
        fill: 'var(--text-muted)',
        'font-size': '9',
        'font-family': 'var(--font-primary)',
        'font-weight': '500',
        'letter-spacing': '0.04em',
      });
      label.textContent = node.label.toUpperCase();
      label.style.transition = 'fill 500ms ease';
      svg.appendChild(label);

      // Sub label
      const sub = _svgEl('text', {
        x: cx, y: CY + R + 24,
        'text-anchor': 'middle',
        fill: 'var(--text-faint)',
        'font-size': '8',
        'font-family': 'var(--font-primary)',
      });
      sub.textContent = node.sub;
      svg.appendChild(sub);

      this._pathNodeRefs[node.id] = { circle, glow, icon, label };
    }

    parent.appendChild(svg);
  }

  _updateSignalPath(data) {
    const wifiOk = !!_get(data, 'network.wifi.connected',
                          _get(data, 'wifi.connected', false));
    const mqttOk = !!_get(data, 'network.mqtt.connected',
                          _get(data, 'mqtt.connected', false));
    const isFault = _get(data, 'state', 'NORMAL') === 'FAULT';

    const activeColor = isFault ? 'var(--state-fault)' : 'var(--health-excellent)';
    const activeStroke= isFault ? 'var(--state-fault)' : 'var(--health-good)';

    const nodeActive = {
      esp32:     true,
      broker:    mqttOk,
      cloud:     mqttOk,
      dashboard: true,
    };
    const linkActive = {
      'esp32-broker':    wifiOk,
      'broker-cloud':    mqttOk,
      'cloud-dashboard': mqttOk,
    };

    // Update node visuals
    for (const [id, refs] of Object.entries(this._pathNodeRefs)) {
      const active = nodeActive[id] ?? false;
      refs.circle.style.stroke  = active ? activeStroke : 'var(--border-subtle)';
      refs.circle.style.opacity = active ? '1' : '0.3';
      refs.glow.style.opacity   = active ? '0.3' : '0';
      refs.glow.setAttribute('stroke', activeColor);
      refs.icon.style.fill  = active ? 'var(--text-primary)' : 'var(--text-faint)';
      refs.label.style.fill = active ? 'var(--text-primary)' : 'var(--text-faint)';
    }

    // Update link visuals
    for (const [linkId, refs] of Object.entries(this._pathLinkRefs)) {
      const active = linkActive[linkId] ?? false;
      refs.line.style.stroke  = active ? activeStroke : 'var(--border-subtle)';
      refs.line.style.opacity = active ? '1' : '0.2';
      refs.travelDot.style.animationPlayState = active ? 'running' : 'paused';
      refs.travelDot.setAttribute('fill', activeColor);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Row 3 — Payload Inspector
  // ══════════════════════════════════════════════════════════════════════

  _buildInspectorCard(parent) {
    const card = _el('div', 'p4-card');
    card.appendChild(_el('div', 'p4-card-hdr', 'MQTT PAYLOAD INSPECTOR'));

    const wrap = document.createElement('div');
    this._inspector = new MqttPayloadInspector(wrap, { maxEntries: 20 });
    this._allComponents.push(this._inspector);

    card.appendChild(wrap);
    parent.appendChild(card);
  }
}