/**
 * telemetryPoller.js — Smart Grid Sentinel Telemetry Poller
 * Source of truth: DESIGN.md v3.3, Sections 6, 7, and 18
 *
 * Manages the live data connection between the dashboard and the ESP32.
 * Transport: MQTT over WebSocket Secure (WSS) via HiveMQ Cloud port 8884.
 *   - Replaces the previous WS + HTTP-fallback model which used a LAN IP
 *     and triggered Mixed Content blocks on the HTTPS-hosted dashboard.
 *   - ESP32 already publishes to HiveMQ Cloud every ~2s — no firmware change.
 *   - Data shape (JSON schema v1.3) is identical — all downstream consumers
 *     are unaffected.
 *
 * Connection state machine:
 *   IDLE → CONNECTING → OPEN → (MQTT push frames arrive)
 *                 ↓ on connection drop
 *           RECONNECTING (mqtt.js auto-reconnect, 5s fixed interval)
 *                 ↓ on repeated failure
 *           DISCONNECTED
 *
 * SEPARATION RULE: No document.* calls. No imports from /components or /pages.
 * The poller writes to the buffer and notifies listeners — it never touches DOM.
 *
 * Public API (unchanged):
 *   connect()                   — start the connection
 *   disconnect()                — stop all transports and timers
 *   onMessage(callback)         — register a listener for parsed telemetry
 *   onStateChange(callback)     — register a listener for connection state events
 *   getLatest()                 → last parsed canonical telemetry object | null
 *   getConnectionState()        → current state string
 *
 * Requires mqtt.js UMD browser bundle loaded via <script> tag in index.html
 * BEFORE main.js. This sets window.mqtt which is read lazily in _openMqtt().
 * ESM imports of mqtt@4.x are not used — all CDN ESM builds include Node.js
 * internals that fail in browsers (net.createConnection / CORS errors).
 *
 * index.html script tag (must come before main.js):
 *   <script src="https://cdn.jsdelivr.net/npm/mqtt@4.3.7/dist/mqtt.min.js"></script>
 */

import { parse }                        from './telemetryParser.js';
import { push as bufferPush }           from './telemetryBuffer.js';

// ── Connection state constants (unchanged) ────────────────────────────────
export const CONNECTION_STATE = {
  IDLE:          'IDLE',
  CONNECTING:    'CONNECTING',
  OPEN:          'OPEN',
  RECONNECTING:  'RECONNECTING',
  HTTP_FALLBACK: 'HTTP_FALLBACK',   // kept for API compatibility — no longer entered
  DISCONNECTED:  'DISCONNECTED',
};

// ── MQTT WSS config — fill these in ──────────────────────────────────────
// Your HiveMQ Cloud cluster WSS endpoint (port 8884).
// Find it in: HiveMQ Cloud console → Cluster → Connection Settings
const MQTT_BROKER_URL  = 'e7fc2b846d3f4104914943838d5c7c27.s1.eu.hivemq.cloud:8884/mqtt';
const MQTT_USERNAME    = 'sgs-device-01';
const MQTT_PASSWORD    = 'Chicken@65';

// Must match the device_id your ESP32 uses in mqtt_client.cpp:
//   snprintf(client_id, ..., "sgs-%02x%02x%02x", mac[3], mac[4], mac[5])
const DEVICE_ID        = 'sgs-XXXXXX';

// ── Derived MQTT topics (match ESP32 firmware) ────────────────────────────
const TOPIC_TELEMETRY  = `sgs/device/${DEVICE_ID}/telemetry`;
const TOPIC_FAULT      = `sgs/device/${DEVICE_ID}/fault`;
const TOPIC_STATE      = `sgs/device/${DEVICE_ID}/state`;
const TOPIC_CMD        = `sgs/device/${DEVICE_ID}/cmd`;   // publish-only

// ── MQTT reconnect config ─────────────────────────────────────────────────
const MQTT_RECONNECT_MS  = 5000;    // mqtt.js reconnectPeriod
const MQTT_CONNECT_TIMEOUT_MS = 15000;

// ── Internal state ────────────────────────────────────────────────────────
let _mqttClient      = null;
let _connectionState = CONNECTION_STATE.IDLE;
let _latestTelemetry = null;           // last successfully parsed frame
let _messageListeners   = [];          // callbacks: (canonicalTelemetry) => void
let _stateListeners     = [];          // callbacks: (state, detail) => void

// ── State machine transition (unchanged) ─────────────────────────────────
function _setState(newState, detail = {}) {
  if (_connectionState === newState) return;
  _connectionState = newState;
  for (const cb of _stateListeners) {
    _callSafe(cb, newState, detail);
  }
}

// ── Safe callback invocation (unchanged) ─────────────────────────────────
function _callSafe(fn, ...args) {
  try {
    fn(...args);
  } catch (err) {
    console.error('[telemetryPoller] listener error:', err);
  }
}

// ── Frame processing pipeline (unchanged) ────────────────────────────────
/**
 * Process a raw JSON string or object received from the MQTT transport.
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
// MQTT WSS transport  (replaces the previous WS + HTTP fallback sections)
// ══════════════════════════════════════════════════════════════════════════

function _openMqtt() {
  _setState(CONNECTION_STATE.CONNECTING);

  // Inside an ES module, bare globals set by <script> tags are not directly
  // visible as identifiers. Access via window.mqtt instead — this works
  // regardless of whether the script tag loaded before or after module eval,
  // as long as connect() is called after DOMContentLoaded (which main.js ensures).
  const mqttLib = window.mqtt;
  if (!mqttLib) {
    console.error('[telemetryPoller] window.mqtt not found — ensure index.html loads mqtt.min.js via <script> tag before main.js');
    _setState(CONNECTION_STATE.DISCONNECTED, { error: 'mqtt_lib_missing' });
    return;
  }

  _mqttClient = mqttLib.connect(MQTT_BROKER_URL, {
    username        : MQTT_USERNAME,
    password        : MQTT_PASSWORD,
    clientId        : 'sgs-dashboard-' + Math.random().toString(16).slice(2, 8),
    clean           : true,
    reconnectPeriod : MQTT_RECONNECT_MS,
    connectTimeout  : MQTT_CONNECT_TIMEOUT_MS,
  });

  _mqttClient.on('connect', _onMqttConnect);
  _mqttClient.on('message', _onMqttMessage);
  _mqttClient.on('reconnect', _onMqttReconnect);
  _mqttClient.on('offline', _onMqttOffline);
  _mqttClient.on('error', _onMqttError);
  _mqttClient.on('close', _onMqttClose);
}

function _onMqttConnect() {
  console.info('[telemetryPoller] MQTT WSS connected:', MQTT_BROKER_URL);
  _setState(CONNECTION_STATE.OPEN, { transport: 'mqtt-wss', url: MQTT_BROKER_URL });

  // Subscribe to all inbound topics (telemetry, fault, state)
  _mqttClient.subscribe(
    [TOPIC_TELEMETRY, TOPIC_FAULT, TOPIC_STATE],
    { qos: 1 },
    (err) => {
      if (err) console.error('[telemetryPoller] MQTT subscribe error:', err);
      else     console.info('[telemetryPoller] Subscribed to SGS topics');
    }
  );
}

function _onMqttMessage(topic, payloadBuf) {
  // Telemetry and fault frames are both valid telemetry shapes — process both
  // through the same pipeline so all downstream consumers are notified.
  // State-change events (topic_state) carry the same fields used by the FSM
  // badge; they are processed through _processFrame as well since the parser
  // is tolerant of partial objects.
  _processFrame(payloadBuf.toString());
}

function _onMqttReconnect() {
  console.warn('[telemetryPoller] MQTT reconnecting…');
  _setState(CONNECTION_STATE.RECONNECTING, { transport: 'mqtt-wss' });
}

function _onMqttOffline() {
  console.warn('[telemetryPoller] MQTT offline');
  _setState(CONNECTION_STATE.DISCONNECTED, { error: 'mqtt_offline' });
}

function _onMqttError(err) {
  console.error('[telemetryPoller] MQTT error:', err.message);
  _setState(CONNECTION_STATE.RECONNECTING, { error: err.message });
}

function _onMqttClose() {
  if (_connectionState === CONNECTION_STATE.DISCONNECTED) return; // intentional
  console.warn('[telemetryPoller] MQTT connection closed');
  _setState(CONNECTION_STATE.RECONNECTING, { error: 'mqtt_closed' });
}

function _cleanupMqtt() {
  if (_mqttClient) {
    _mqttClient.removeAllListeners();
    try { _mqttClient.end(true); } catch (_) { /* ignore */ }
    _mqttClient = null;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Public API  (signatures and behaviour unchanged)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Start the telemetry connection via MQTT WSS to HiveMQ Cloud.
 * The `host` parameter is accepted for API compatibility but ignored —
 * the broker URL is configured via MQTT_BROKER_URL above.
 *
 * @param {string} [host] — ignored, kept for API compatibility
 */
export function connect(host) {   // eslint-disable-line no-unused-vars
  if (_connectionState !== CONNECTION_STATE.IDLE &&
      _connectionState !== CONNECTION_STATE.DISCONNECTED) {
    console.warn('[telemetryPoller] connect() called while already active — ignoring');
    return;
  }

  _openMqtt();
}

/**
 * Stop all transports and timers.
 * After disconnect(), call connect() to start again.
 */
export function disconnect() {
  _setState(CONNECTION_STATE.DISCONNECTED);
  _cleanupMqtt();
}

/**
 * Register a callback to receive parsed canonical telemetry objects.
 * Called on every successfully parsed MQTT frame.
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
 *        OPEN, DISCONNECTED, and RECONNECTING respectively).
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

// ── Convenience event name aliases (Phase 2 spec — unchanged) ────────────
export const EVENT = {
  CONNECTED:    CONNECTION_STATE.OPEN,
  DISCONNECTED: CONNECTION_STATE.DISCONNECTED,
  ERROR:        CONNECTION_STATE.RECONNECTING,
};