/**
 * mqttPayloadInspector.js — Smart Grid Sentinel MQTT Payload Inspector
 * Phase 7 deliverable. DESIGN.md §11, §4.7, §17.
 *
 * Maintains a rolling buffer of the last 20 telemetry frames as they
 * arrive from the live poller. Each entry is rendered as a collapsible
 * row showing: timestamp · topic badge · syntax-highlighted JSON.
 *
 * Captures frames via update(telemetryData) — same data the firmware
 * publishes to sgs/device/<id>/telemetry over MQTT.
 *
 * Component interface (DESIGN.md §17):
 *   constructor(containerEl, options)
 *   update(telemetryData)
 *   destroy()
 *
 * Options:
 *   maxEntries {number}  — rolling buffer depth (default 20)
 *   topic      {string}  — MQTT topic label shown on each entry
 *                          (default 'sgs/device/<id>/telemetry')
 *
 * SEPARATION RULE: No imports from /pages or /telemetry.
 * Receives plain data objects; never fetches.
 */

// ── Syntax highlight rules ────────────────────────────────────────────────
// Maps token type to CSS variable name (DESIGN.md §3 + §11)
const HIGHLIGHT = {
  key:     '--text-muted',         // object keys
  string:  '--text-primary',       // string values
  number:  '--wave-current',       // numeric values   (#5DCAA5 teal)
  boolean: '--state-warning',      // true / false     (#EF9F27 amber)
  null:    '--text-faint',         // null
  brace:   '--text-faint',         // { } [ ]
  colon:   '--text-faint',         // :
  comma:   '--text-faint',         // ,
};

/**
 * Tokenise + highlight a JSON string into an HTML fragment.
 * Handles malformed JSON gracefully — falls back to plain pre-formatted text.
 *
 * @param {string} jsonStr
 * @returns {string} innerHTML-safe HTML string
 */
function _highlight(jsonStr) {
  try {
    // Validate: will throw on malformed JSON
    JSON.parse(jsonStr);
  } catch (_) {
    // Malformed — render as plain text in fault color
    const escaped = _escHtml(jsonStr);
    return `<span style="color:var(--state-fault)">${escaped}</span>`;
  }

  // Token-level regex highlight
  // We match tokens in priority order, colour each span, then join.
  const TOKEN_RE = /("(?:[^"\\]|\\.)*")(\s*:\s*)?|true|false|null|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?|[{}[\],:]|\S+/g;

  const parts = [];
  let match;
  while ((match = TOKEN_RE.exec(jsonStr)) !== null) {
    const raw = match[0];

    if (raw.startsWith('"') && match[2]) {
      // Key (string followed by colon)
      parts.push(_span(match[1], HIGHLIGHT.key));
      parts.push(_span(match[2], HIGHLIGHT.colon));
    } else if (raw.startsWith('"')) {
      parts.push(_span(raw, HIGHLIGHT.string));
    } else if (raw === 'true' || raw === 'false') {
      parts.push(_span(raw, HIGHLIGHT.boolean));
    } else if (raw === 'null') {
      parts.push(_span(raw, HIGHLIGHT.null));
    } else if (raw === '{' || raw === '}' || raw === '[' || raw === ']') {
      parts.push(_span(raw, HIGHLIGHT.brace));
    } else if (raw === ',' || raw === ':') {
      parts.push(_span(raw, HIGHLIGHT.comma));
    } else if (!isNaN(Number(raw))) {
      parts.push(_span(raw, HIGHLIGHT.number));
    } else {
      parts.push(_escHtml(raw));
    }
  }
  return parts.join('');
}

function _span(text, cssVar) {
  return `<span style="color:var(${cssVar})">${_escHtml(text)}</span>`;
}

function _escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Timestamp formatting ──────────────────────────────────────────────────

function _fmtTime(epochMs) {
  const d = new Date(epochMs);
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function _fmtDateFull(epochMs) {
  return new Date(epochMs).toLocaleString();
}

// ── Payload entry ─────────────────────────────────────────────────────────

let _entrySeq = 0; // monotonic ID for CSS targets

export class MqttPayloadInspector {
  /**
   * @param {HTMLElement} containerEl
   * @param {object}      options
   */
  constructor(containerEl, options = {}) {
    this._container  = containerEl;
    this._maxEntries = options.maxEntries ?? 20;
    this._topicBase  = options.topic      ?? 'sgs/device/–/telemetry';

    // Circular buffer of { id, ts, topic, raw, size } entries (newest first)
    this._entries    = [];

    // Filter string (applied to topic + raw JSON content)
    this._filter     = '';

    this._buildDOM();
  }

  // ── DOM construction ──────────────────────────────────────────────────

  _buildDOM() {
    // Header row: title + filter input + entry count
    const hdr = document.createElement('div');
    hdr.style.cssText = [
      'display: flex',
      'align-items: center',
      'gap: 10px',
      'margin-bottom: 10px',
      'flex-wrap: wrap',
    ].join(';');

    const title = document.createElement('span');
    title.style.cssText = [
      'font-size: 11px',
      'color: var(--text-muted)',
      'text-transform: uppercase',
      'letter-spacing: 0.08em',
      'flex-shrink: 0',
    ].join(';');
    title.textContent = 'Payload Inspector';

    this._countEl = document.createElement('span');
    this._countEl.style.cssText = [
      'font-size: 10px',
      'color: var(--text-faint)',
      'font-family: var(--font-mono)',
    ].join(';');
    this._countEl.textContent = '0 entries';

    // Filter input
    this._filterInput = document.createElement('input');
    this._filterInput.type        = 'text';
    this._filterInput.placeholder = 'Filter by topic or content…';
    this._filterInput.style.cssText = [
      'flex: 1',
      'min-width: 140px',
      'background: var(--bg-card-dark-2, var(--bg-card-dark))',
      'border: 1px solid var(--border-subtle)',
      'border-radius: var(--radius-sm)',
      'color: var(--text-primary)',
      'font-family: var(--font-mono)',
      'font-size: 11px',
      'padding: 5px 10px',
      'outline: none',
    ].join(';');
    this._filterInput.addEventListener('input', () => {
      this._filter = this._filterInput.value.toLowerCase().trim();
      this._renderList();
    });

    hdr.appendChild(title);
    hdr.appendChild(this._filterInput);
    hdr.appendChild(this._countEl);

    // Scrollable entry list
    this._list = document.createElement('div');
    this._list.style.cssText = [
      'display: flex',
      'flex-direction: column',
      'gap: 4px',
      'max-height: 420px',
      'overflow-y: auto',
      'scrollbar-width: thin',
    ].join(';');

    this._emptyEl = document.createElement('div');
    this._emptyEl.style.cssText = [
      'font-size: 11px',
      'color: var(--text-faint)',
      'padding: 24px 0',
      'text-align: center',
    ].join(';');
    this._emptyEl.textContent = 'Waiting for telemetry frames…';
    this._list.appendChild(this._emptyEl);

    this._container.appendChild(hdr);
    this._container.appendChild(this._list);
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Accept a new telemetry frame. Inserts at the top of the list,
   * dropping the oldest entry when buffer is full.
   * @param {object} telemetryData — canonical telemetry object
   */
  update(telemetryData) {
    if (!telemetryData) return;

    // Derive topic from device ID if available
    const deviceId = telemetryData.device || '–';
    const topic    = `sgs/device/${deviceId}/telemetry`;

    // Serialise (pretty-print for inspector)
    let raw;
    try {
      raw = JSON.stringify(telemetryData, null, 2);
    } catch (_) {
      raw = '(serialisation error)';
    }

    const entry = {
      id:    ++_entrySeq,
      ts:    telemetryData.ts || Date.now(),
      topic,
      raw,
      size:  raw.length,
    };

    // Prepend (newest first)
    this._entries.unshift(entry);
    if (this._entries.length > this._maxEntries) {
      this._entries.length = this._maxEntries;
    }

    this._renderList();
  }

  destroy() {
    // No animationLoop subscriptions
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  _renderList() {
    const filter = this._filter;

    // Filter entries
    const visible = filter
      ? this._entries.filter(e =>
          e.topic.toLowerCase().includes(filter) ||
          e.raw.toLowerCase().includes(filter))
      : this._entries;

    this._countEl.textContent = `${visible.length} / ${this._entries.length} entries`;

    // Clear and rebuild
    this._list.innerHTML = '';

    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = [
        'font-size: 11px',
        'color: var(--text-faint)',
        'padding: 24px 0',
        'text-align: center',
      ].join(';');
      empty.textContent = filter ? 'No entries match the filter.' : 'Waiting for telemetry frames…';
      this._list.appendChild(empty);
      return;
    }

    for (const entry of visible) {
      this._list.appendChild(this._buildEntryEl(entry));
    }
  }

  _buildEntryEl(entry) {
    const wrap = document.createElement('div');
    wrap.style.cssText = [
      'background: var(--bg-card-dark-2, var(--bg-card-dark))',
      'border-radius: var(--radius-sm)',
      'overflow: hidden',
      'border: 1px solid var(--border-subtle)',
    ].join(';');

    // ── Entry header row ─────────────────────────────────────────────
    const entryHdr = document.createElement('div');
    entryHdr.style.cssText = [
      'display: flex',
      'align-items: center',
      'gap: 8px',
      'padding: 6px 10px',
      'cursor: pointer',
      'user-select: none',
    ].join(';');
    entryHdr.setAttribute('role', 'button');
    entryHdr.setAttribute('aria-expanded', 'false');

    // Expand chevron
    const chevron = document.createElement('span');
    chevron.style.cssText = [
      'font-size: 10px',
      'color: var(--text-faint)',
      'transition: transform 200ms ease',
      'flex-shrink: 0',
    ].join(';');
    chevron.textContent = '▶';

    // Timestamp
    const tsEl = document.createElement('span');
    tsEl.style.cssText = [
      'font-family: var(--font-mono)',
      'font-size: 10px',
      'color: var(--text-muted)',
      'white-space: nowrap',
      'flex-shrink: 0',
    ].join(';');
    tsEl.textContent = _fmtTime(entry.ts);
    tsEl.title       = _fmtDateFull(entry.ts);

    // Topic badge
    const topicBadge = document.createElement('span');
    topicBadge.style.cssText = [
      'font-family: var(--font-mono)',
      'font-size: 10px',
      'color: var(--wave-voltage)',
      'flex: 1',
      'overflow: hidden',
      'text-overflow: ellipsis',
      'white-space: nowrap',
    ].join(';');
    topicBadge.textContent = entry.topic;

    // Size
    const sizeEl = document.createElement('span');
    sizeEl.style.cssText = [
      'font-family: var(--font-mono)',
      'font-size: 10px',
      'color: var(--text-faint)',
      'white-space: nowrap',
      'flex-shrink: 0',
    ].join(';');
    sizeEl.textContent = `${entry.size.toLocaleString()} B`;

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.style.cssText = [
      'background: transparent',
      'border: 1px solid var(--border-subtle)',
      'border-radius: 4px',
      'color: var(--text-faint)',
      'font-size: 9px',
      'padding: 2px 7px',
      'cursor: pointer',
      'flex-shrink: 0',
      'transition: color 150ms ease, border-color 150ms ease',
      'font-family: var(--font-primary)',
    ].join(';');
    copyBtn.textContent = 'Copy';
    copyBtn.setAttribute('aria-label', 'Copy payload to clipboard');

    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard?.writeText(entry.raw).then(() => {
        copyBtn.textContent = '✓ Copied';
        copyBtn.style.color = 'var(--health-excellent)';
        copyBtn.style.borderColor = 'var(--health-excellent)';
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
          copyBtn.style.color = '';
          copyBtn.style.borderColor = '';
        }, 1500);
      }).catch(() => {
        copyBtn.textContent = '✗';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      });
    });

    entryHdr.appendChild(chevron);
    entryHdr.appendChild(tsEl);
    entryHdr.appendChild(topicBadge);
    entryHdr.appendChild(sizeEl);
    entryHdr.appendChild(copyBtn);

    // ── Collapsible body ─────────────────────────────────────────────
    const body = document.createElement('div');
    body.style.cssText = [
      'display: none',
      'padding: 8px 10px 10px',
      'border-top: 1px solid var(--border-subtle)',
    ].join(';');

    const pre = document.createElement('pre');
    pre.style.cssText = [
      'font-family: var(--font-mono)',
      'font-size: 11px',
      'line-height: 1.6',
      'overflow-x: auto',
      'white-space: pre',
      'margin: 0',
      'color: var(--text-primary)',
    ].join(';');

    // Set syntax-highlighted HTML (safe — we escape all user-sourced text)
    pre.innerHTML = _highlight(entry.raw);
    body.appendChild(pre);

    // ── Toggle expand / collapse ─────────────────────────────────────
    let expanded = false;
    entryHdr.addEventListener('click', () => {
      expanded = !expanded;
      body.style.display    = expanded ? 'block' : 'none';
      chevron.style.transform = expanded ? 'rotate(90deg)' : '';
      entryHdr.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });

    wrap.appendChild(entryHdr);
    wrap.appendChild(body);

    return wrap;
  }
}
