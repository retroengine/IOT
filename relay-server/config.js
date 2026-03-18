// ============================================================
//  config.js — Smart Grid Sentinel Relay Server Configuration
//  Single source of truth. Edit ONLY this file for your setup.
// ============================================================

export const config = {

  // ── Your ESP32 on your LAN ──────────────────────────────────────────────
  esp32: {
    ip:         '10.96.35.199',    // ← your ESP32's LAN IP
    apiKey:     'aec158f34ad787c', // ← your ESP32's API key
    timeoutMs:  5000,              // WebSocket handshake timeout (ms)
  },

  // ── HiveMQ Cloud MQTT ───────────────────────────────────────────────────
  mqtt: {
    host:          'e7fc2b846d3f4104914943838d5c7c27.s1.eu.hivemq.cloud',
    port:          8883,
    username:      'sgs-device-01',
    password:      'Chicken@65',
    topic:         'sgs/device/+/telemetry',
    keepalive:     60,
    reconnectMs:   5000,
    reconnectMaxMs: 60000,
  },

  // ── Relay server WebSocket (browser connects here) ──────────────────────
  server: {
    port:   3000,
    host:   'localhost',
    pushMs: 100,   // push to browser every 100ms — matches ESP32 push rate
  },

  // ── Data source priority ────────────────────────────────────────────────
  // ESP32 WebSocket → MQTT → Mock
  sources: {
    esp32WsEnabled: true,   // direct ESP32 WebSocket push (primary)
    mqttEnabled:    true,   // HiveMQ Cloud fallback (off-LAN)
    mockEnabled:    true,   // synthetic data when both are offline
  },

};
