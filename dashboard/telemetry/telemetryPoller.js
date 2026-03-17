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
 *   connect(host)               — start the connection
 *   disconnect()                — stop all transports and timers
 *   onMessage(callback)         — register a listener for parsed telemetry
 *   onStateChange(callback)     — register a listener for connection state events
 *   getLatest()                 → last parsed canonical telemetry object | null
 *   getConnectionState()        → current state string
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NEXT PHASE — MQTT WSS transport
 * ─────────────────────────────────────────────────────────────────────────
 * The WS+HTTP transport works only on the local network (direct ESP32 LAN IP).
 * The MQTT WSS upgrade connects via HiveMQ Cloud and works from any network,
 * eliminating the Mixed Content errors on the HTTPS-hosted dashboard.
 *
 * Blocked by: mqtt.js v4 has no true ESM browser build. All CDN paths either
 * fail with CORS (unpkg ESM) or pull in Node.js net.createConnection (UMD).
 * Resolution options being evaluated:
 *   a) Use mqtt.js v5 which has a proper browser ESM export
 *   b) Bundle mqtt via Vite/Rollup as part of a build step
 *   c) Use a lightweight alternative (e.g. MQTT over native WebSocket without library)
 *
 * Config values ready when transport is implemented:
 *   MQTT_BROKER_URL = 'wss://e7fc2b846d3f4104914943838d5c7c27.s1.eu.hivemq.cloud:8884/mqtt'
 *   MQTT_USERNAME   = 'sgs-device-01'
 *   MQTT_PASSWORD   = 'Chicken@65'
 *   DEVICE_ID       = 'sgs-XXXXXX'  ← replace with ESP32 MAC suffix from serial output
 * ─────────────────────────────────────────────────────────────────────────
 */

import { parse }                        from './telemetryParser.js';
import { push as bufferPush }           from './telemetryBuffer.js';

// ── Connection state constants ────────────────────────────────────────────────
export const CONNECTION_STATE = {
  IDLE:          'IDLE',
  CONNECTING:    'CONNECTING',
  OPEN:          'OPEN',
  RECONNECTING:  'RECONNECTING',
  HTTP_FALLBACK: 'HTTP_FALLBACK',
  DISCONNECTED:  'DISCONNECTED',
};

// ── Backoff config ─────────────────────────────────────────────────────────
const BACKOFF_BASE_MS              = 500;
const BACKOFF_MAX_MS               = 30000;
const BACKOFF_MULTIPLIER           = 2;
const MAX_WS_FAILS_BEFORE_FALLBACK = 3;

// ── HTTP fallback poll interval ────────────────────────────────────────────
const HTTP_POLL_INTERVAL_MS = 100;

// ── WS heartbeat config ────────────────────────────────────────────────────
const WS_PING_INTERVAL_MS   = 10000;
const WS_PONG_TIMEOUT_MS    = 5000;

// ── Internal state ────────────────────────────────────────────────────────
let _ws              = null;
let _connectionState = CONNECTION_STATE.IDLE;
let _latestTelemetry = null;
let _messageListeners   = [];
let _stateListeners     = [];

let _reconnectAttempts  = 0;
let _backoffMs          = BACKOFF_BASE_MS;
let _backoffTimer       = null;

let _httpPollTimer      = null;
let _wsPingTimer        = null;
let _wsPongTimeoutTimer = null;

let _host    = null;
let _wsUrl   = null;
let _httpUrl = null;

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

  _latestTelemetry = canonical;

  const ts = canonical.ts || Date.now();
  bufferPush('v', canonical.v, ts);
  bufferPush('i', canonical.i, ts);
  bufferPush('t', canonical.t, ts);
  bufferPush('p', canonical.p, ts);

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
  _ws.onopen    = _onWsOpen;
  _ws.onmessage = _onWsMessage;
  _ws.onerror   = _onWsError;
  _ws.onclose   = _onWsClose;
}

function _onWsOpen() {
  console.info('[telemetryPoller] WebSocket connected:', _wsUrl);
  _setState(CONNECTION_STATE.OPEN, { transport: 'websocket', url: _wsUrl });
  _reconnectAttempts = 0;
  _backoffMs         = BACKOFF_BASE_MS;
  _stopHttpFallback();
  _startPing();
}

function _onWsMessage(event) {
  _resetPongTimeout();
  _processFrame(event.data);
}

function _onWsError(event) {
  console.warn('[telemetryPoller] WebSocket error', event);
  _setState(CONNECTION_STATE.RECONNECTING, { error: 'ws_error' });
}

function _onWsClose(event) {
  _stopPing();
  if (_connectionState === CONNECTION_STATE.DISCONNECTED) return;
  console.warn(`[telemetryPoller] WebSocket closed (code ${event.code})`);
  _onWsFailure();
}

function _onWsFailure() {
  _cleanupWs();
  _reconnectAttempts++;
  _startHttpFallback();
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
    if (_connectionState !== CONNECTION_STATE.DISCONNECTED) _openWebSocket();
  }, delayMs);
}

function _cleanupWs() {
  _stopPing();
  if (_ws) {
    _ws.onopen = null; _ws.onmessage = null;
    _ws.onerror = null; _ws.onclose = null;
    try { _ws.close(); } catch (_) { /* ignore */ }
    _ws = null;
  }
}

// ── Heartbeat ─────────────────────────────────────────────────────────────
function _startPing() {
  _stopPing();
  _wsPingTimer = setInterval(() => {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      try { _ws.send(JSON.stringify({ type: 'ping' })); _startPongTimeout(); }
      catch (_) { /* ignore */ }
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
  if (_httpPollTimer) return;
  _setState(CONNECTION_STATE.HTTP_FALLBACK, { transport: 'http', url: _httpUrl });
  console.info('[telemetryPoller] HTTP fallback polling started:', _httpUrl);
  _httpPollTimer = setInterval(_httpPoll, HTTP_POLL_INTERVAL_MS);
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
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      console.warn(`[telemetryPoller] HTTP poll ${response.status}`);
      _setState(CONNECTION_STATE.HTTP_FALLBACK, { transport: 'http', httpStatus: response.status });
      return;
    }
    const json = await response.json();
    _processFrame(json);
  } catch (err) {
    _setState(CONNECTION_STATE.DISCONNECTED, { error: err.message });
  }
}

function _clearBackoffTimer() {
  clearTimeout(_backoffTimer);
  _backoffTimer = null;
}

// ══════════════════════════════════════════════════════════════════════════
// Public API
// ══════════════════════════════════════════════════════════════════════════

/**
 * Start the telemetry connection.
 * @param {string} [host] — ESP32 host, e.g. '10.177.189.199'. Defaults to window.location.host.
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

/** Stop all transports, timers, and listeners. */
export function disconnect() {
  _setState(CONNECTION_STATE.DISCONNECTED);
  _stopHttpFallback();
  _stopPing();
  _clearBackoffTimer();
  _cleanupWs();
}

/**
 * @param {function} callback
 * @returns {function} unsubscribe
 */
export function onMessage(callback) {
  if (typeof callback !== 'function') throw new TypeError('[telemetryPoller] onMessage() requires a function');
  _messageListeners.push(callback);
  return () => { _messageListeners = _messageListeners.filter(cb => cb !== callback); };
}

/**
 * @param {function} callback
 * @returns {function} unsubscribe
 */
export function onStateChange(callback) {
  if (typeof callback !== 'function') throw new TypeError('[telemetryPoller] onStateChange() requires a function');
  _stateListeners.push(callback);
  return () => { _stateListeners = _stateListeners.filter(cb => cb !== callback); };
}

/** @returns {object|null} */
export function getLatest() { return _latestTelemetry; }

/** @returns {string} */
export function getConnectionState() { return _connectionState; }

// ── Convenience event name aliases ────────────────────────────────────────
export const EVENT = {
  CONNECTED:    CONNECTION_STATE.OPEN,
  DISCONNECTED: CONNECTION_STATE.DISCONNECTED,
  ERROR:        CONNECTION_STATE.RECONNECTING,
};