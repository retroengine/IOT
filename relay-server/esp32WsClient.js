// ============================================================
//  esp32WsClient.js — ESP32 WebSocket Client
//
//  Connects to ws://<esp32_ip>/ws/telemetry
//  ESP32 pushes full telemetry JSON every 100ms.
//
//  Liveness detection: data stream watchdog only.
//  No ping/pong — the 100ms data stream IS the heartbeat.
//  If no frame arrives in 5s (50 missed frames), reconnect.
//
//  Reconnect: exponential backoff 1s → 30s.
// ============================================================

import WebSocket   from 'ws';
import { config }  from './config.js';

const ESP32_WS_URL      = `ws://${config.esp32.ip}/ws/telemetry`;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS  = 30000;
const DATA_WATCHDOG_MS  = 5000;   // 5s = 50 missed frames at 100ms rate

let _ws             = null;
let _alive          = false;
let _dataCb         = null;
let _errorCb        = null;
let _reconnectTimer = null;
let _watchdogTimer  = null;
let _backoffMs      = RECONNECT_BASE_MS;
let _stopped        = false;
let _stats          = { received: 0, errors: 0, reconnects: 0, connectedSince: 0 };

// ── Data stream watchdog ──────────────────────────────────────────────────
// Reset on every incoming frame. If it fires, the connection is silently dead.

function _startWatchdog() {
  clearTimeout(_watchdogTimer);
  _watchdogTimer = setTimeout(() => {
    console.warn('[esp32WsClient] data watchdog fired — no frames in 5s, reconnecting');
    _handleDisconnect();
  }, DATA_WATCHDOG_MS);
}

function _resetWatchdog() {
  if (_watchdogTimer) _startWatchdog();
}

function _stopWatchdog() {
  clearTimeout(_watchdogTimer);
  _watchdogTimer = null;
}

// ── Connection lifecycle ──────────────────────────────────────────────────

function _connect() {
  if (_stopped) return;

  try {
    _ws = new WebSocket(ESP32_WS_URL, {
      handshakeTimeout: config.esp32.timeoutMs,
    });
  } catch (err) {
    console.error('[esp32WsClient] construction failed:', err.message);
    _scheduleReconnect();
    return;
  }

  _ws.on('open', () => {
    console.info(`[esp32WsClient] connected to ESP32 — waiting for data stream`);
    _alive                = true;
    _backoffMs            = RECONNECT_BASE_MS;
    _stats.connectedSince = Date.now();
    _startWatchdog();   // arm watchdog — must receive data within 5s
  });

  _ws.on('message', (data) => {
    _resetWatchdog();   // any frame proves connection is alive

    let json;
    try {
      json = JSON.parse(data.toString('utf8'));
    } catch (err) {
      _stats.errors++;
      return;
    }

    // Ignore pong control messages
    if (json?.type === 'pong') return;
    if (typeof json !== 'object' || json === null) { _stats.errors++; return; }

    _alive = true;
    _stats.received++;

    if (_stats.received === 1) {
      console.info('[esp32WsClient] first frame received — stream is live');
    }

    if (_dataCb) _dataCb(json, 'esp32ws');
  });

  _ws.on('error', (err) => {
    _stats.errors++;
    if (err.code !== 'ECONNREFUSED') {
      console.warn('[esp32WsClient] error:', err.message);
    }
    if (_errorCb) _errorCb(err);
  });

  _ws.on('close', (code) => {
    _stopWatchdog();
    _alive = false;
    if (!_stopped) {
      if (code !== 1006) {  // suppress repeated timeout noise
        console.warn(`[esp32WsClient] closed (code ${code}) — reconnecting`);
      }
      _handleDisconnect();
    }
  });
}

function _handleDisconnect() {
  _stopWatchdog();
  _alive = false;
  if (_ws) {
    _ws.removeAllListeners();
    _ws.on('error', () => {});  // swallow errors during teardown
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

export function start() {
  _stopped   = false;
  _backoffMs = RECONNECT_BASE_MS;
  console.info(`[esp32WsClient] connecting to ${ESP32_WS_URL}`);
  _connect();
}

export function stop() {
  _stopped = true;
  _stopWatchdog();
  clearTimeout(_reconnectTimer);
  _reconnectTimer = null;
  if (_ws) {
    _ws.removeAllListeners();
    _ws.on('error', () => {});
    try { _ws.terminate(); } catch (_) {}
    _ws = null;
  }
  _alive = false;
  console.info('[esp32WsClient] stopped');
}

export function onData(cb) {
  if (typeof cb !== 'function') throw new TypeError('[esp32WsClient] onData requires a function');
  _dataCb = cb;
}

export function onError(cb) {
  if (typeof cb !== 'function') throw new TypeError('[esp32WsClient] onError requires a function');
  _errorCb = cb;
}

export function isAlive() { return _alive; }
export function getStats() { return { ..._stats }; }