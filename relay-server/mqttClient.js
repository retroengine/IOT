// ============================================================
//  mqttClient.js — HiveMQ Cloud MQTT Subscriber
//
//  Connects to HiveMQ Cloud over TLS (port 8883) using MQTT 3.1.1.
//  Subscribes to the device telemetry topic and feeds received
//  PUBLISH payloads to the registered onData callback.
//
//  Reconnect: MANUAL exponential backoff from reconnectMs → reconnectMaxMs.
//  The mqtt library's built-in reconnect (`reconnectPeriod`) is disabled
//  (set to 0) so we control the delay ourselves — this properly implements
//  the backoff cap defined in config.reconnectMaxMs.
//
//  TLS: Node.js built-in tls module. HiveMQ Cloud certificate chain is
//       trusted by Node's bundled CA store (ISRG Root X1 / DigiCert).
//       No custom CA cert file needed.
//
//  Dependencies: mqtt (npm install mqtt), dotenv (npm install dotenv)
//
//  Public API:
//    start()       — connect and subscribe
//    stop()        — disconnect cleanly
//    onData(cb)    — register callback for received telemetry JSON
//    onError(cb)   — register callback for errors
//    isAlive()     — true when MQTT session is active
//    getStats()    — { received, errors, reconnects, connectedSince }
// ============================================================

import mqtt       from 'mqtt';
import { config } from './config.js';

// ── State ─────────────────────────────────────────────────────────────────
let _client         = null;
let _alive          = false;
let _stopped        = false;
let _dataCb         = null;
let _errorCb        = null;
let _backoffMs      = config.mqtt.reconnectMs;
let _reconnectTimer = null;
let _stats          = { received: 0, errors: 0, reconnects: 0, connectedSince: 0 };

// ── Internal helpers ──────────────────────────────────────────────────────

function _clientId() {
  // Unique client ID prevents session collision on server restart
  return `sgs-relay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function _scheduleReconnect() {
  if (_stopped) return;

  const delay = _backoffMs;
  _backoffMs  = Math.min(_backoffMs * 2, config.mqtt.reconnectMaxMs);

  console.info(`[mqttClient] reconnecting in ${delay}ms (next cap: ${_backoffMs}ms)`);
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    if (!_stopped) _connect();
  }, delay);
  _stats.reconnects++;
}

function _clearReconnectTimer() {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
}

function _connect() {
  if (_stopped || _client) return;

  const brokerUrl = `mqtts://${config.mqtt.host}:${config.mqtt.port}`;

  console.info(`[mqttClient] connecting → ${brokerUrl}  user: '${config.mqtt.username}'`);
  console.info(`[mqttClient] topic: ${config.mqtt.topic}`);

  _client = mqtt.connect(brokerUrl, {
    clientId:           _clientId(),
    username:           config.mqtt.username,
    password:           config.mqtt.password,
    keepalive:          config.mqtt.keepalive,
    clean:              true,
    reconnectPeriod:    0,         // ← DISABLED — we drive reconnect manually
    connectTimeout:     20_000,    // 20s TLS handshake timeout (HiveMQ Cloud can be slow)
    rejectUnauthorized: true,      // ALWAYS verify TLS cert
  });

  // ── Connection established ────────────────────────────────────────────
  _client.on('connect', (connack) => {
    _alive     = true;
    _backoffMs = config.mqtt.reconnectMs;  // reset backoff on successful connect
    _stats.connectedSince = Date.now();
    console.info(`[mqttClient] ✓ connected — session present: ${connack.sessionPresent}`);

    // Subscribe with QoS 0 — telemetry is time-series; duplication is harmless
    _client.subscribe(config.mqtt.topic, { qos: 0 }, (err, granted) => {
      if (err) {
        console.error('[mqttClient] subscribe failed:', err.message);
        _stats.errors++;
        if (_errorCb) _errorCb(err);
        return;
      }
      for (const g of granted) {
        console.info(`[mqttClient] subscribed to '${g.topic}' at QoS ${g.qos}`);
      }
    });
  });

  // ── Incoming PUBLISH ──────────────────────────────────────────────────
  _client.on('message', (topic, payload) => {
    let json;
    try {
      json = JSON.parse(payload.toString('utf8'));
    } catch (err) {
      console.warn(`[mqttClient] malformed JSON on '${topic}':`, err.message);
      _stats.errors++;
      return;
    }

    if (typeof json !== 'object' || json === null) {
      console.warn('[mqttClient] payload is not a JSON object — discarded');
      _stats.errors++;
      return;
    }

    _stats.received++;
    if (_stats.received === 1) {
      console.info('[mqttClient] ✓ first MQTT frame received — stream is live');
    }

    if (_dataCb) _dataCb(json, 'mqtt');
  });

  // ── Error ─────────────────────────────────────────────────────────────
  _client.on('error', (err) => {
    _alive = false;
    _stats.errors++;
    console.error('[mqttClient] connection error:', err.message);
    if (_errorCb) _errorCb(err);
    // Do NOT call _client.end() here — let the 'close' event handle cleanup
  });

  // ── Offline / Close → schedule manual reconnect ───────────────────────
  _client.on('offline', () => {
    _alive = false;
    console.warn('[mqttClient] offline — broker unreachable');
  });

  _client.on('close', () => {
    _alive = false;
    if (_stopped) return; // deliberate stop — do not reconnect
    // Tear down the current client instance before scheduling a new connection
    _teardownClient();
    _scheduleReconnect();
  });

  _client.on('disconnect', (packet) => {
    _alive = false;
    console.warn('[mqttClient] broker sent DISCONNECT code:', packet?.returnCode ?? '?');
  });
}

function _teardownClient() {
  if (!_client) return;
  const c = _client;
  _client = null;    // clear reference FIRST to prevent re-entry
  c.removeAllListeners();
  try { c.end(true); } catch (_) {}  // force-close; ignore errors during teardown
}

// ── Public API ────────────────────────────────────────────────────────────

/** Connect to HiveMQ Cloud and subscribe to the telemetry topic. */
export function start() {
  if (_client || _reconnectTimer) {
    console.warn('[mqttClient] start() called while already running — ignoring');
    return;
  }
  _stopped   = false;
  _backoffMs = config.mqtt.reconnectMs;
  _connect();
}

/** Disconnect cleanly. Stops reconnect loop and all event handlers. */
export function stop() {
  _stopped = true;
  _clearReconnectTimer();
  _teardownClient();
  _alive = false;
  console.info('[mqttClient] stopped');
}

/**
 * Register callback for received telemetry frames.
 * Called with (jsonObject, 'mqtt').
 * @param {function} cb
 */
export function onData(cb) {
  if (typeof cb !== 'function') throw new TypeError('[mqttClient] onData requires a function');
  _dataCb = cb;
}

/**
 * Register callback for connection/protocol errors.
 * @param {function} cb
 */
export function onError(cb) {
  if (typeof cb !== 'function') throw new TypeError('[mqttClient] onError requires a function');
  _errorCb = cb;
}

/** @returns {boolean} true when MQTT session is active */
export function isAlive() { return _alive; }

/** @returns {object} diagnostic counters */
export function getStats() { return { ..._stats }; }
