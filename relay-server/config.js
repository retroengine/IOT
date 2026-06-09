// ============================================================
//  config.js — Smart Grid Sentinel Relay Server Configuration
//  Single source of truth. Edit ONLY this file for your setup.
//  Credentials are loaded from .env (never hardcoded here).
// ============================================================

// ── Load .env at startup ──────────────────────────────────────────────────
// Node 20.6+ has built-in dotenv support via --env-file flag.
// For Node 18/19 compatibility we use the dotenv package.
import 'dotenv/config';

export const config = {

  // ── Your ESP32 on your LAN ──────────────────────────────────────────────
  esp32: {
    ip:        process.env.ESP32_IP      || '10.117.3.199', // ← ESP32 LAN IP
    port:      80,                                           // ← ESP32 HTTP port (default 80)
    apiKey:    process.env.ESP32_API_KEY || 'aec158f34ad787c',
    timeoutMs: 5000,   // WebSocket / HTTP handshake timeout (ms)
    pollMs:    2000,   // How often httpPoller polls /api/telemetry (ms)
  },

  // ── HiveMQ Cloud MQTT (TLS port 8883) ───────────────────────────────────
  //  Primary transport when ESP32 WS is unavailable (off-LAN / roaming).
  //  Credentials come from .env — never commit passwords to git.
  mqtt: {
    host:           'e7fc2b846d3f4104914943838d5c7c27.s1.eu.hivemq.cloud',
    port:           8883,           // MQTT over TLS
    username:       process.env.MQTT_USERNAME || 'sgs-device-01',
    password:       process.env.MQTT_PASSWORD || '',
    topic:          'sgs/device/+/telemetry',
    keepalive:      60,             // seconds — HiveMQ Cloud requires ≤ 60s
    reconnectMs:    2000,           // initial reconnect delay
    reconnectMaxMs: 60000,          // cap for exponential backoff (60s)
  },

  // ── Relay server WebSocket (browser connects here) ──────────────────────
  server: {
    port:   Number(process.env.SERVER_PORT) || 3000,
    host:   'localhost',
    pushMs: 100,   // push to browser every 100ms — matches ESP32 push rate
  },

  // ── Data source priority (highest → lowest) ─────────────────────────────
  //  1. ESP32 WebSocket push (100ms, LAN only)
  //  2. ESP32 HTTP poll fallback (2s, LAN only)  ← NEW
  //  3. HiveMQ MQTT Cloud (5s, any network)
  //  4. Mock generator (offline / dev)
  sources: {
    esp32WsEnabled:   true,    // direct ESP32 WebSocket push (primary)
    esp32HttpEnabled: true,    // HTTP poll fallback when WS fails (LAN only)
    mqttEnabled:      true,    // HiveMQ Cloud fallback (off-LAN)
    mockEnabled:      true,    // synthetic data when all real sources offline
  },

  // ── Supabase (analytics backend) ────────────────────────────────
  supabase: {
    url:        process.env.SUPABASE_URL      || '',
    anonKey:    process.env.SUPABASE_ANON_KEY || '',
    enabled:    !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
    // How often to write a telemetry snapshot (ms)
    snapshotIntervalMs: 60_000,  // 1 minute — keeps row count manageable
    // Device ID tag written on every row
    deviceId: 'sgs-device-01',
  },

};
