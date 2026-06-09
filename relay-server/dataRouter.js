// ============================================================
//  dataRouter.js — Telemetry Source Priority Manager
//
//  Priority (highest → lowest):
//    1. ESP32 WebSocket — direct push at 100ms (LAN)
//    2. ESP32 HTTP poll — 2s fallback (LAN, when WS fails)
//    3. MQTT Cloud      — HiveMQ relay, works off-LAN
//    4. Mock            — synthetic data for offline development
// ============================================================

import { config }   from './config.js';
import { generate } from './mockGenerator.js';

const STALE_ESP32_WS_MS   = 3_000;   // 3s  — 30 missed frames at 100ms
const STALE_ESP32_HTTP_MS = 8_000;   // 8s  — 4 missed polls at 2s
const STALE_MQTT_MS       = 15_000;  // 15s — MQTT publishes at ~5s

const _frames = {
  esp32ws:   null,
  esp32http: null,
  mqtt:      null,
};

// Callbacks registered by wsRelay and supabaseWriter
const _frameCallbacks = [];

/**
 * Register a frame callback. Returns an unsubscribe function.
 * Multiple subscribers supported (wsRelay + supabaseWriter).
 */
export function onFrame(cb) {
  _frameCallbacks.push(cb);
  return () => {
    const idx = _frameCallbacks.indexOf(cb);
    if (idx !== -1) _frameCallbacks.splice(idx, 1);
  };
}

function _emit(data, source) {
  for (const cb of _frameCallbacks) {
    try { cb(data, source); } catch (err) {
      console.error('[dataRouter] frame callback error:', err.message);
    }
  }
}

// ── Frame registration ────────────────────────────────────────────────────

export function registerEsp32WsFrame(json) {
  _frames.esp32ws = { data: json, receivedMs: Date.now() };
  // Highest priority — always emit immediately
  _emit(json, 'esp32ws');
}

export function registerEsp32HttpFrame(json) {
  _frames.esp32http = { data: json, receivedMs: Date.now() };
  // Only emit if ESP32 WS is stale/offline
  if (!_esp32WsAvailable()) {
    _emit(json, 'esp32http');
  }
}

export function registerMqttFrame(json) {
  _frames.mqtt = { data: json, receivedMs: Date.now() };
  // Only emit if both ESP32 transports are stale/offline
  if (!_esp32WsAvailable() && !_esp32HttpAvailable()) {
    _emit(json, 'mqtt');
  }
}

// ── Availability checks ───────────────────────────────────────────────────

function _esp32WsAvailable() {
  if (!config.sources.esp32WsEnabled) return false;
  if (!_frames.esp32ws) return false;
  return (Date.now() - _frames.esp32ws.receivedMs) < STALE_ESP32_WS_MS;
}

function _esp32HttpAvailable() {
  if (!config.sources.esp32HttpEnabled) return false;
  if (!_frames.esp32http) return false;
  return (Date.now() - _frames.esp32http.receivedMs) < STALE_ESP32_HTTP_MS;
}

function _mqttAvailable() {
  if (!config.sources.mqttEnabled) return false;
  if (!_frames.mqtt) return false;
  return (Date.now() - _frames.mqtt.receivedMs) < STALE_MQTT_MS;
}

// ── Best frame (sent on new client connect + used by HTTP fallback) ────────

export function getBestFrame() {
  const now = Date.now();

  if (_esp32WsAvailable()) {
    return { data: _frames.esp32ws.data, source: 'esp32ws', ageMs: now - _frames.esp32ws.receivedMs };
  }
  if (_esp32HttpAvailable()) {
    return { data: _frames.esp32http.data, source: 'esp32http', ageMs: now - _frames.esp32http.receivedMs };
  }
  if (_mqttAvailable()) {
    return { data: _frames.mqtt.data, source: 'mqtt', ageMs: now - _frames.mqtt.receivedMs };
  }
  if (config.sources.mockEnabled) {
    return { data: generate(), source: 'mock', ageMs: 0 };
  }
  return null;
}

export function getSourceStatus() {
  const now = Date.now();
  return {
    esp32ws: {
      enabled:   config.sources.esp32WsEnabled,
      available: _esp32WsAvailable(),
      ageMs:     _frames.esp32ws ? now - _frames.esp32ws.receivedMs : null,
    },
    esp32http: {
      enabled:   config.sources.esp32HttpEnabled,
      available: _esp32HttpAvailable(),
      ageMs:     _frames.esp32http ? now - _frames.esp32http.receivedMs : null,
    },
    mqtt: {
      enabled:   config.sources.mqttEnabled,
      available: _mqttAvailable(),
      ageMs:     _frames.mqtt ? now - _frames.mqtt.receivedMs : null,
    },
    mock: { enabled: config.sources.mockEnabled },
  };
}