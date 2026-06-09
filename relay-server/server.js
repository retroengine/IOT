// ============================================================
//  server.js — Smart Grid Sentinel Relay Server
//  Entry point. Run with: node server.js
//
//  Data flow (priority, highest → lowest):
//    ESP32 WS push (100ms)  → esp32WsClient → dataRouter → wsRelay → browser
//    ESP32 HTTP poll (2s)   → httpPoller    → dataRouter ↑  (LAN fallback)
//    HiveMQ MQTT (5s)       → mqttClient    → dataRouter ↑  (off-LAN)
//    Mock generator         → dataRouter ↑                   (offline dev)
// ============================================================

import { config }          from './config.js';
import * as esp32WsClient  from './esp32WsClient.js';
import * as httpPoller     from './httpPoller.js';
import * as mqttClient     from './mqttClient.js';
import * as dataRouter     from './dataRouter.js';
import * as wsRelay        from './wsRelay.js';
import * as supabase       from './supabaseWriter.js';

// ── Node version check ────────────────────────────────────────────────────
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error('[SGS] ERROR: Node.js 18 or newer required.');
  process.exit(1);
}

// ── Startup banner ────────────────────────────────────────────────────────
console.log('');
console.log('╔══════════════════════════════════════════════════════╗');
console.log('║        Smart Grid Sentinel — Relay Server            ║');
console.log('╚══════════════════════════════════════════════════════╝');
console.log('');
console.log(`  ESP32 WebSocket : ws://${config.esp32.ip}/ws/telemetry`);
console.log(`  ESP32 HTTP poll : http://${config.esp32.ip}:${config.esp32.port}/api/telemetry  (${config.esp32.pollMs}ms)`);
console.log(`  MQTT broker     : ${config.mqtt.host}:${config.mqtt.port}`);
console.log(`  MQTT user       : ${config.mqtt.username}`);
console.log(`  Browser WS      : ws://localhost:${config.server.port}/ws/telemetry`);
console.log(`  Dashboard       : http://localhost:${config.server.port}`);
console.log(`  Status          : http://localhost:${config.server.port}/status`);
console.log(`  Push rate       : ${config.server.pushMs}ms`);
console.log(`  Sources         : ESP32WS=${config.sources.esp32WsEnabled} ESP32HTTP=${config.sources.esp32HttpEnabled} MQTT=${config.sources.mqttEnabled} Mock=${config.sources.mockEnabled}`);
console.log('');

// ── Wire ESP32 WebSocket → dataRouter ────────────────────────────────────
esp32WsClient.onData((json) => {
  dataRouter.registerEsp32WsFrame(json);
  if (esp32WsClient.getStats().received === 1) {
    console.info('[server] ✓ ESP32 WebSocket live — direct push active');
  }
});

esp32WsClient.onError((err) => {
  // ECONNREFUSED is expected when ESP32 is booting — suppress noise
  if (err.code !== 'ECONNREFUSED') {
    console.warn('[server] ESP32 WS error:', err.message);
  }
});

// ── Wire ESP32 HTTP poll → dataRouter ────────────────────────────────────
httpPoller.onData((json) => {
  dataRouter.registerEsp32HttpFrame(json);
  if (httpPoller.getStats().ok === 1) {
    console.info('[server] ✓ ESP32 HTTP poll live — LAN fallback active');
  }
});

httpPoller.onError((err) => {
  // Only log occasionally — repeated ECONNREFUSED is expected when ESP32 is offline
  if (httpPoller.getStats().fail % 10 === 1) {
    console.warn('[server] ESP32 HTTP poll error:', err.message);
  }
});

// ── Wire MQTT → dataRouter ────────────────────────────────────────────
mqttClient.onData((json) => {
  dataRouter.registerMqttFrame(json);
  if (mqttClient.getStats().received === 1) {
    console.info('[server] ✓ MQTT live — HiveMQ Cloud fallback active');
    supabase.writeMqttEvent('connected', mqttClient.getStats());
  }
});

mqttClient.onError((err) => {
  console.warn('[server] MQTT error:', err.message);
});

// ── Wire dataRouter → supabaseWriter ───────────────────────────────────
// Every frame that comes in (from any source) is fed to supabaseWriter.
// The writer handles its own sampling — only persists once per 60s.
dataRouter.onFrame((data, source) => {
  supabase.ingestFrame(data, source);
});

// ── Log active source every 30s ───────────────────────────────────────────
let _lastSource = null;
setInterval(() => {
  const frame = dataRouter.getBestFrame();
  const src   = frame?.source ?? 'none';
  if (src !== _lastSource) {
    console.info(`[server] active source switched → ${src.toUpperCase()}`);
    _lastSource = src;
  }
  const s = dataRouter.getSourceStatus();
  const wsAge   = s.esp32ws.ageMs   != null ? `${Math.round(s.esp32ws.ageMs)}ms`    : 'never';
  const httpAge = s.esp32http.ageMs != null ? `${Math.round(s.esp32http.ageMs)}ms`  : 'never';
  const mqttAge = s.mqtt.ageMs      != null ? `${Math.round(s.mqtt.ageMs / 1000)}s` : 'never';
  console.info(`[server] WS:${wsAge}  HTTP:${httpAge}  MQTT:${mqttAge}  clients:${wsRelay.getStats().clients}`);
}, 30_000);

// ── Start everything ────────────────────────────────────────────────
wsRelay.start();

if (config.sources.esp32WsEnabled)   esp32WsClient.start();
if (config.sources.esp32HttpEnabled) httpPoller.start();
if (config.sources.mqttEnabled)      mqttClient.start();
supabase.start();  // start Supabase write loops (no-op if not configured)

console.log('  Press Ctrl+C to stop.\n');

// ── Graceful shutdown ─────────────────────────────────────────────────────
async function _shutdown(signal) {
  console.info(`\n[server] ${signal} — shutting down gracefully...`);
  esp32WsClient.stop();
  httpPoller.stop();
  mqttClient.stop();
  await supabase.stop();   // flush final snapshot to Supabase before exit
  wsRelay.stop();
  setTimeout(() => process.exit(0), 1500);
}

process.on('SIGINT',  () => _shutdown('SIGINT'));
process.on('SIGTERM', () => _shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err);
  // Do not exit — stay alive for watchdog restart
});
