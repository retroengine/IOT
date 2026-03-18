// ============================================================
//  esp32WsClient.js — ESP32 WebSocket Client
//
//  Connects to ws://<esp32_ip>/ws/telemetry — the WebSocket
//  server now running on the ESP32 firmware.
//
//  The ESP32 pushes a full telemetry frame every 100ms.
//  This client receives those frames and feeds them to
//  dataRouter as the primary (highest priority) source.
//
//  Reconnect: exponential backoff 1s → 30s.
//  No external dependencies — uses Node.js built-in WebSocket
//  via the 'ws' npm package (already installed).
//
//  Public API:
//    start()       — connect to ESP32 WebSocket
//    stop()        — disconnect cleanly
//    onData(cb)    — register callback for received frames
//    onError(cb)   — register callback for errors
//    isAlive()     — true when connected and receiving frames
//    getStats()    — { received, errors, reconnects, connectedSince }
// ============================================================

import WebSocket    from 'ws';
import { config }  from './config.js';

const ESP32_WS_URL = `ws://${config.esp32.ip}/ws/telemetry`;

// ── Reconnect config ──────────────────────────────────────────────────────
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS  = 30000;

// ── State ─────────────────────────────────────────────────────────────────
let _ws             = null;
let _alive          = false;
let _dataCb         = null;
let _errorCb        = null;
let _reconnectTimer = null;
let _backoffMs      = RECONNECT_BASE_MS;
let _stopped        = false;
let _stats          = { received: 0, errors: 0, reconnects: 0, connectedSince: 0 };

// ── Ping timer — keeps connection alive and detects silent drops ──────────
const PING_INTERVAL_MS  = 10000;
const PONG_TIMEOUT_MS   = 5000;
let _pingTimer          = null;
let _pongTimeoutTimer   = null;

function _startPing() {
  _stopPing();
  _pingTimer = setInterval(() => {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      try {
        _ws.send(JSON.stringify({ type: 'ping' }));
        // Start pong timeout — if no response in 5s, connection is dead
        _pongTimeoutTimer = setTimeout(() => {
          console.warn('[esp32WsClient] pong timeout — reconnecting');
          _handleDisconnect();
        }, PONG_TIMEOUT_MS);
      } catch (_) {}
    }
  }, PING_INTERVAL_MS);
}

function _stopPing() {
  clearInterval(_pingTimer);
  _pingTimer = null;
  clearTimeout(_pongTimeoutTimer);
  _pongTimeoutTimer = null;
}

// ── Connection lifecycle ──────────────────────────────────────────────────

function _connect() {
  if (_stopped) return;

  console.info(`[esp32WsClient] connecting to ${ESP32_WS_URL}`);

  try {
    _ws = new WebSocket(ESP32_WS_URL, {
      handshakeTimeout: config.esp32.timeoutMs,
    });
  } catch (err) {
    console.error('[esp32WsClient] WebSocket construction failed:', err.message);
    _scheduleReconnect();
    return;
  }

  _ws.on('open', () => {
    console.info('[esp32WsClient] connected to ESP32 WebSocket');
    _alive               = true;
    _backoffMs           = RECONNECT_BASE_MS;
    _stats.connectedSince = Date.now();
    _startPing();
  });

  _ws.on('message', (data) => {
    // Clear pong timeout on ANY incoming message (telemetry frames count as pong)
    clearTimeout(_pongTimeoutTimer);
    _pongTimeoutTimer = null;

    let json;
    try {
      json = JSON.parse(data.toString('utf8'));
    } catch (err) {
      console.warn('[esp32WsClient] malformed JSON frame:', err.message);
      _stats.errors++;
      return;
    }

    // Ignore pong control messages
    if (json?.type === 'pong') return;

    if (typeof json !== 'object' || json === null) {
      _stats.errors++;
      return;
    }

    _alive = true;
    _stats.received++;
    if (_dataCb) _dataCb(json, 'esp32ws');
  });

  _ws.on('error', (err) => {
    _stats.errors++;
    // ECONNREFUSED = ESP32 not reachable yet — expected at startup
    if (err.code !== 'ECONNREFUSED') {
      console.warn('[esp32WsClient] error:', err.message);
    }
    if (_errorCb) _errorCb(err);
  });

  _ws.on('close', (code, reason) => {
    _stopPing();
    _alive = false;
    if (!_stopped) {
      console.warn(`[esp32WsClient] disconnected (code ${code}) — reconnecting`);
      _handleDisconnect();
    }
  });
}

function _handleDisconnect() {
  _stopPing();
  _alive = false;
  if (_ws) {
    _ws.removeAllListeners();
    try { _ws.terminate(); } catch (_) {}
    _ws = null;
  }
  _scheduleReconnect();
}

function _scheduleReconnect() {
  if (_stopped) return;
  _stats.reconnects++;
  clearTimeout(_reconnectTimer);
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    _connect();
  }, _backoffMs);
  _backoffMs = Math.min(_backoffMs * 2, RECONNECT_MAX_MS);
}

// ── Public API ────────────────────────────────────────────────────────────

/** Connect to ESP32 WebSocket. */
export function start() {
  _stopped   = false;
  _backoffMs = RECONNECT_BASE_MS;
  _connect();
}

/** Disconnect cleanly and stop reconnect loop. */
export function stop() {
  _stopped = true;
  _stopPing();
  clearTimeout(_reconnectTimer);
  _reconnectTimer = null;
  if (_ws) {
    _ws.removeAllListeners();
    // Add error listener before terminate to swallow the close-before-connect error
    _ws.on('error', () => {});
    try { _ws.terminate(); } catch (_) {}
    _ws = null;
  }
  _alive = false;
  console.info('[esp32WsClient] stopped');
}

/**
 * Register callback for telemetry frames.
 * Called with (jsonObject, 'esp32ws') on each received frame.
 */
export function onData(cb) {
  if (typeof cb !== 'function') throw new TypeError('[esp32WsClient] onData requires a function');
  _dataCb = cb;
}

/** Register callback for errors. */
export function onError(cb) {
  if (typeof cb !== 'function') throw new TypeError('[esp32WsClient] onError requires a function');
  _errorCb = cb;
}

/** @returns {boolean} true when connected and receiving frames */
export function isAlive() { return _alive; }

/** @returns {object} diagnostic counters */
export function getStats() { return { ..._stats }; }
