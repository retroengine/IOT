// ============================================================
//  dataRouter.js — Telemetry Source Priority Manager
//
//  Priority (highest → lowest):
//    1. ESP32 WebSocket — direct push at 100ms
//    2. MQTT            — HiveMQ Cloud relay, works off-LAN
//    3. Mock            — synthetic data for offline development
// ============================================================

import { config }   from './config.js';
import { generate } from './mockGenerator.js';

const STALE_ESP32_MS = 3_000;
const STALE_MQTT_MS  = 15_000;

const _frames = {
  esp32ws: null,
  mqtt:    null,
};

// Callback registered by wsRelay — called immediately on every new frame
let _immediateCallback = null;

export function onFrame(cb) {
  _immediateCallback = cb;
}

// ── Frame registration ────────────────────────────────────────────────────

export function registerEsp32WsFrame(json) {
  _frames.esp32ws = { data: json, receivedMs: Date.now() };
  // Forward immediately to wsRelay — no timer delay
  if (_immediateCallback) _immediateCallback(json, 'esp32ws');
}

export function registerMqttFrame(json) {
  _frames.mqtt = { data: json, receivedMs: Date.now() };
  // Only forward via MQTT if ESP32 WS is not alive
  if (!_esp32WsAvailable() && _immediateCallback) {
    _immediateCallback(json, 'mqtt');
  }
}

// ── Availability checks ───────────────────────────────────────────────────

function _esp32WsAvailable() {
  if (!config.sources.esp32WsEnabled) return false;
  if (!_frames.esp32ws) return false;
  return (Date.now() - _frames.esp32ws.receivedMs) < STALE_ESP32_MS;
}

function _mqttAvailable() {
  if (!config.sources.mqttEnabled) return false;
  if (!_frames.mqtt) return false;
  return (Date.now() - _frames.mqtt.receivedMs) < STALE_MQTT_MS;
}

// ── Best frame (used for immediate send on new client connect) ────────────

export function getBestFrame() {
  const now = Date.now();

  if (_esp32WsAvailable()) {
    return { data: _frames.esp32ws.data, source: 'esp32ws', ageMs: now - _frames.esp32ws.receivedMs };
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
    mqtt: {
      enabled:   config.sources.mqttEnabled,
      available: _mqttAvailable(),
      ageMs:     _frames.mqtt ? now - _frames.mqtt.receivedMs : null,
    },
    mock: { enabled: config.sources.mockEnabled },
  };
}