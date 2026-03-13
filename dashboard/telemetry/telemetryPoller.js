/**
 * telemetryPoller.js — Smart Grid Sentinel Telemetry Poller
 * Source of truth: DESIGN.md v3.3, Sections 6, 7, and 18
 *
 * Manages the live data connection between the dashboard and the ESP32.
 * Primary transport: WebSocket (server-initiated push every ~2s).
 * Fallback transport: HTTP GET /api/telemetry (polled at 100ms to approximate
 *                     10Hz display rate per Phase 2 spec).
 *
 * Connection state machine:
 *   IDLE → CONNECTING → OPEN → (WS push frames arrive)
 *                 ↓ on WS failure
 *           RECONNECTING (exponential backoff: 500ms→1s→2s→4s→30s cap)
 *                 ↓ after 3 consecutive reconnect failures
 *           HTTP_FALLBACK (polls /api/telemetry every 100ms)
 *                 ↓ when WS recovers
 *           OPEN (resumes WS, drops HTTP polling)
 *
 * SEPARATION RULE: No document.* calls. No imports from /components or /pages.
 * The poller writes to the buffer and notifies listeners — it never touches DOM.
 *
 * Public API:
 *   connect()                   — start the connection
 *   disconnect()                — stop all transports and timers
 *   onMessage(callback)         — register a listener for parsed telemetry
 *   onStateChange(callback)     — register a listener for connection state events
 *   getLatest()                 → last parsed canonical telemetry object | null
 *   getConnectionState()        → current state string
 */

import { parse }                        from './telemetryParser.js';
import { push as bufferPush }           from './telemetryBuffer.js';

// ── Connection state constants ────────────────────────────────────────────
export const CONNECTION_STATE = {
  IDLE:          'IDLE',
  CONNECTING:    'CONNECTING',
  OPEN:          'OPEN',
  RECONNECTING:  'RECONNECTING',
  HTTP_FALLBACK: 'HTTP_FALLBACK',
  DISCONNECTED:  'DISCONNECTED',
};

// ── Backoff config (DESIGN.md §6 + Phase 2 spec) ──────────────────────────
const BACKOFF_BASE_MS        = 500;    // first retry delay
const BACKOFF_MAX_MS         = 30000; // cap (30s)
const BACKOFF_MULTIPLIER     = 2;
const MAX_WS_FAILS_BEFORE_FALLBACK = 3; // switch to HTTP after 3 consecutive WS failures

// ── HTTP fallback poll interval ────────────────────────────────────────────
// 100ms to approximate 10Hz display rate (Phase 2 spec).
// DESIGN.md §6 defines the cadence as 2s for HTTP; the 100ms interval is
// a frontend approximation used when the WS channel is unavailable.
const HTTP_POLL_INTERVAL_MS  = 100;

// ── WS heartbeat config (DESIGN.md §6) ────────────────────────────────────
const WS_PING_INTERVAL_MS    = 10000; // send ping every 10s
const WS_PONG_TIMEOUT_MS     = 5000;  // mark lost if no pong within 5s

// ── Internal state ────────────────────────────────────────────────────────
let _ws              = null;           // active WebSocket
let _connectionState = CONNECTION_STATE.IDLE;
let _latestTelemetry = null;           // last successfully parsed frame
let _messageListeners   = [];          // callbacks: (canonicalTelemetry) => void
let _stateListeners     = [];          // callbacks: (state, detail) => void

let _reconnectAttempts  = 0;           // consecutive WS failures
let _backoffMs          = BACKOFF_BASE_MS;
let _backoffTimer       = null;

let _httpPollTimer      = null;
let _wsPingTimer        = null;
let _wsPongTimeoutTimer = null;

let _host               = null;        // resolved at connect() time
let _wsUrl              = null;
let _httpUrl            = null;

// ── State machine transition ───────────────────────────────────────────────
function _setState(newState, detail = {}) {
  if (_connectionState === newState) return;
  _connectionState = newState;
  for (const cb of _stateListeners) {
    _callSafe(cb, newState, detail);
  }
}

// ── Safe callback invocation ──────────────────────────────────────────────
function _callSafe(fn, ...args) {
  try {
    fn(...args);
  } catch (err) {
    console.error('[telemetryPoller] listener error:', err);
  }
}

// ── Frame processing pipeline ─────────────────────────────────────────────
/**
 * Process a raw JSON string or object received from either transport.
 * Parse → validate → push to buffer → notify listeners.
 *
 * @param {string|object} raw
 */
function _processFrame(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch (_) {
      console.warn('[telemetryPoller] dropped malformed JSON frame');
      return;
    }
  }

  const canonical = parse(obj);
  if (canonical === null) {
    console.warn('[telemetryPoller] parser returned null — frame discarded');
    return;
  }

  // Store last known value (DESIGN.md §16 rule 17: never zero-out on error)
  _latestTelemetry = canonical;

  // Push to buffer for waveform / sparkline consumers
  const ts = canonical.ts || Date.now();
  bufferPush('v', canonical.v, ts);
  bufferPush('i', canonical.i, ts);
  bufferPush('t', canonical.t, ts);
  bufferPush('p', canonical.p, ts);

  // Notify all registered message listeners
  for (const cb of _messageListeners) {
    _callSafe(cb, canonical);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// WebSocket transport
// ══════════════════════════════════════════════════════════════════════════

function _openWebSocket() {
  _setState(CONNECTION_STATE.CONNECTING);

  try {
    _ws = new WebSocket(_wsUrl);
  } catch (err) {
    console.error('[telemetryPoller] WebSocket construction failed:', err);
    _onWsFailure();
    return;
  }

  _ws.onopen = _onWsOpen;
  _ws.onmessage = _onWsMessage;
  _ws.onerror = _onWsError;
  _ws.onclose = _onWsClose;
}

function _onWsOpen() {
  console.info('[telemetryPoller] WebSocket connected:', _wsUrl);
  _setState(CONNECTION_STATE.OPEN, { transport: 'websocket', url: _wsUrl });

  // Reset backoff on successful connection
  _reconnectAttempts = 0;
  _backoffMs         = BACKOFF_BASE_MS;

  // Stop HTTP fallback if it was running
  _stopHttpFallback();

  // Start heartbeat
  _startPing();
}

function _onWsMessage(event) {
  // Any message resets the pong timeout (data frames count as liveness)
  _resetPongTimeout();
  _processFrame(event.data);
}

function _onWsError(event) {
  console.warn('[telemetryPoller] WebSocket error', event);
  _setState(CONNECTION_STATE.RECONNECTING, { error: 'ws_error' });
}

function _onWsClose(event) {
  _stopPing();
  if (_connectionState === CONNECTION_STATE.DISCONNECTED) return; // intentional close
  console.warn(`[telemetryPoller] WebSocket closed (code ${event.code})`);
  _onWsFailure();
}

function _onWsFailure() {
  _cleanupWs();
  _reconnectAttempts++;

  // Start HTTP fallback immediately on the FIRST WS failure.
  // This guarantees data continuity within 0ms of WS loss — well within
  // the 2-second spec requirement ("WebSocket failure triggers HTTP fallback
  // within 2 seconds"). WS reconnect continues in the background with
  // exponential backoff; HTTP stops automatically when WS recovers.
  _startHttpFallback();

  // Schedule WS reconnect: exponential backoff up to BACKOFF_MAX_MS.
  // After MAX_WS_FAILS_BEFORE_FALLBACK consecutive failures, hold at max
  // backoff to avoid hammering the ESP32 (DESIGN.md §16 rule 20).
  if (_reconnectAttempts >= MAX_WS_FAILS_BEFORE_FALLBACK) {
    _scheduleWsReconnect(BACKOFF_MAX_MS);
  } else {
    _scheduleWsReconnect(_backoffMs);
    _backoffMs = Math.min(_backoffMs * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
  }
}

function _scheduleWsReconnect(delayMs) {
  _setState(CONNECTION_STATE.RECONNECTING, { delayMs });
  _clearBackoffTimer();
  _backoffTimer = setTimeout(() => {
    _backoffTimer = null;
    if (_connectionState !== CONNECTION_STATE.DISCONNECTED) {
      _openWebSocket();
    }
  }, delayMs);
}

function _cleanupWs() {
  _stopPing();
  if (_ws) {
    _ws.onopen = null;
    _ws.onmessage = null;
    _ws.onerror = null;
    _ws.onclose = null;
    try { _ws.close(); } catch (_) { /* ignore */ }
    _ws = null;
  }
}

// ── Heartbeat / ping-pong ─────────────────────────────────────────────────
function _startPing() {
  _stopPing();
  _wsPingTimer = setInterval(() => {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      try {
        _ws.send(JSON.stringify({ type: 'ping' }));
        _startPongTimeout();
      } catch (_) { /* ignore send errors — onclose will fire */ }
    }
  }, WS_PING_INTERVAL_MS);
}

function _stopPing() {
  clearInterval(_wsPingTimer);
  _wsPingTimer = null;
  _clearPongTimeout();
}

function _startPongTimeout() {
  _clearPongTimeout();
  _wsPongTimeoutTimer = setTimeout(() => {
    console.warn('[telemetryPoller] pong timeout — marking connection lost');
    _onWsFailure();
  }, WS_PONG_TIMEOUT_MS);
}

function _resetPongTimeout() {
  // Any frame (including actual data) resets the pong watchdog
  if (_wsPongTimeoutTimer) _startPongTimeout();
}

function _clearPongTimeout() {
  clearTimeout(_wsPongTimeoutTimer);
  _wsPongTimeoutTimer = null;
}

// ══════════════════════════════════════════════════════════════════════════
// HTTP fallback transport
// ══════════════════════════════════════════════════════════════════════════

function _startHttpFallback() {
  if (_httpPollTimer) return; // already running
  _setState(CONNECTION_STATE.HTTP_FALLBACK, { transport: 'http', url: _httpUrl });
  console.info('[telemetryPoller] HTTP fallback polling started:', _httpUrl);
  _httpPollTimer = setInterval(_httpPoll, HTTP_POLL_INTERVAL_MS);
  // Kick off first poll immediately
  _httpPoll();
}

function _stopHttpFallback() {
  clearInterval(_httpPollTimer);
  _httpPollTimer = null;
}

async function _httpPoll() {
  try {
    const response = await fetch(_httpUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      // Short timeout — we're polling frequently
      signal: AbortSignal.timeout(2000),
    });

    if (!response.ok) {
      // e.g. 401 (auth), 404, 500 — log but keep polling
      console.warn(`[telemetryPoller] HTTP poll ${response.status}`);
      _setState(CONNECTION_STATE.HTTP_FALLBACK, {
        transport: 'http',
        httpStatus: response.status,
      });
      return;
    }

    const json = await response.json();
    _processFrame(json);

    // If WS has since recovered, promote state
    if (_connectionState === CONNECTION_STATE.HTTP_FALLBACK) {
      // Try to re-establish WS on next backoff cycle (already scheduled)
    }

  } catch (err) {
    // Network error or timeout — both transports down
    _setState(CONNECTION_STATE.DISCONNECTED, { error: err.message });
  }
}

// ── Utility timer cleanup ─────────────────────────────────────────────────
function _clearBackoffTimer() {
  clearTimeout(_backoffTimer);
  _backoffTimer = null;
}

// ══════════════════════════════════════════════════════════════════════════
// Public API
// ══════════════════════════════════════════════════════════════════════════

/**
 * Start the telemetry connection.
 *
 * Derives the WebSocket and HTTP URLs from the current page's origin,
 * so no configuration is needed when the dashboard is served by the ESP32.
 *
 * @param {string} [host] — override host, e.g. '192.168.1.100'.
 *                          Defaults to window.location.host.
 */
export function connect(host) {
  if (_connectionState !== CONNECTION_STATE.IDLE &&
      _connectionState !== CONNECTION_STATE.DISCONNECTED) {
    console.warn('[telemetryPoller] connect() called while already active — ignoring');
    return;
  }

  _host    = host || (typeof window !== 'undefined' ? window.location.host : 'localhost');
  _wsUrl   = `ws://${_host}/ws/telemetry`;
  _httpUrl = `http://${_host}/api/telemetry`;

  _reconnectAttempts = 0;
  _backoffMs         = BACKOFF_BASE_MS;

  _openWebSocket();
}

/**
 * Stop all transports, timers, and listeners.
 * After disconnect(), call connect() to start again.
 */
export function disconnect() {
  _setState(CONNECTION_STATE.DISCONNECTED);
  _stopHttpFallback();
  _stopPing();
  _clearBackoffTimer();
  _cleanupWs();
}

/**
 * Register a callback to receive parsed canonical telemetry objects.
 * The callback is called synchronously on every successfully parsed frame,
 * from both WS and HTTP transports.
 *
 * @param {function(canonicalTelemetry: object): void} callback
 * @returns {function} unsubscribe function — call to remove this listener
 */
export function onMessage(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('[telemetryPoller] onMessage() requires a function');
  }
  _messageListeners.push(callback);
  return () => {
    _messageListeners = _messageListeners.filter(cb => cb !== callback);
  };
}

/**
 * Register a callback to receive connection state change events.
 * Called with (newState: string, detail: object) on every state transition.
 *
 * State strings: see CONNECTION_STATE constants above.
 * Emits: "connected", "disconnected", "error" (Phase 2 spec aliases for
 *        OPEN, DISCONNECTED, and RECONNECTING/HTTP_FALLBACK respectively).
 *
 * @param {function(state: string, detail: object): void} callback
 * @returns {function} unsubscribe function
 */
export function onStateChange(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('[telemetryPoller] onStateChange() requires a function');
  }
  _stateListeners.push(callback);
  return () => {
    _stateListeners = _stateListeners.filter(cb => cb !== callback);
  };
}

/**
 * Get the last successfully parsed canonical telemetry object.
 *
 * Returns null if no frame has been received yet.
 * Per DESIGN.md §16 rule 17: this value is NEVER cleared on disconnect —
 * components should display it as stale data rather than blank.
 *
 * @returns {object|null}
 */
export function getLatest() {
  return _latestTelemetry;
}

/**
 * Get the current connection state string.
 * One of: IDLE, CONNECTING, OPEN, RECONNECTING, HTTP_FALLBACK, DISCONNECTED.
 *
 * @returns {string}
 */
export function getConnectionState() {
  return _connectionState;
}

// ── Convenience event name aliases (Phase 2 spec) ─────────────────────────
// The spec says poller "Emits connection state events: connected, disconnected, error".
// These are state string values that the stateChange listener will receive:
//   'connected'    → CONNECTION_STATE.OPEN
//   'disconnected' → CONNECTION_STATE.DISCONNECTED
//   'error'        → CONNECTION_STATE.RECONNECTING or HTTP_FALLBACK

export const EVENT = {
  CONNECTED:    CONNECTION_STATE.OPEN,
  DISCONNECTED: CONNECTION_STATE.DISCONNECTED,
  ERROR:        CONNECTION_STATE.RECONNECTING,
};
