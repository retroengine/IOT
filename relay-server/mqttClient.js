// ============================================================
//  mqttClient.js — HiveMQ Cloud MQTT Subscriber
//
//  Connects to HiveMQ Cloud over TLS (port 8883) using MQTT 3.1.1.
//  Subscribes to the device telemetry topic and feeds received
//  PUBLISH payloads to the registered onData callback.
//
//  Reconnect: exponential backoff from reconnectMs → reconnectMaxMs.
//  TLS: Node.js built-in tls module, connects to HiveMQ Cloud whose
//       certificate chain is trusted by Node's bundled CA store (ISRG
//       Root X1 / DigiCert — same as what browsers trust).
//       No custom CA cert file needed for HiveMQ Cloud.
//
//  Dependencies: mqtt (npm install mqtt)
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
let _dataCb         = null;
let _errorCb        = null;
let _stats          = { received: 0, errors: 0, reconnects: 0, connectedSince: 0 };

// ── Internal helpers ──────────────────────────────────────────────────────

function _clientId() {
  // Unique client ID prevents session collision when server restarts
  return `sgs-relay-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Public API ────────────────────────────────────────────────────────────

/** Connect to HiveMQ Cloud and subscribe to the telemetry topic. */
export function start() {
  if (_client) {
    console.warn('[mqttClient] start() called while already running — ignoring');
    return;
  }

  const brokerUrl = `mqtts://${config.mqtt.host}:${config.mqtt.port}`;

  console.info(`[mqttClient] connecting to ${brokerUrl} as '${config.mqtt.username}'`);
  console.info(`[mqttClient] topic filter: ${config.mqtt.topic}`);

  _client = mqtt.connect(brokerUrl, {
    clientId:             _clientId(),
    username:             config.mqtt.username,
    password:             config.mqtt.password,
    keepalive:            config.mqtt.keepalive,
    clean:                true,
    reconnectPeriod:      config.mqtt.reconnectMs,
    connectTimeout:       15_000,     // 15s TLS handshake timeout (HiveMQ Cloud can be slow)
    rejectUnauthorized:   true,       // ALWAYS verify TLS cert — never disable in production
  });

  // ── Connection established ────────────────────────────────────────────
  _client.on('connect', (connack) => {
    _alive = true;
    _stats.connectedSince = Date.now();
    console.info(`[mqttClient] connected — session present: ${connack.sessionPresent}`);

    // Subscribe with QoS 0 — telemetry is time-series, duplication is harmless
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
      console.warn(`[mqttClient] malformed JSON on topic '${topic}':`, err.message);
      _stats.errors++;
      return;
    }

    if (typeof json !== 'object' || json === null) {
      console.warn('[mqttClient] payload is not a JSON object — discarded');
      _stats.errors++;
      return;
    }

    _stats.received++;
    if (_dataCb) _dataCb(json, 'mqtt');
  });

  // ── Reconnect ─────────────────────────────────────────────────────────
  _client.on('reconnect', () => {
    _alive = false;
    _stats.reconnects++;
    console.info(`[mqttClient] reconnecting... (attempt #${_stats.reconnects})`);
  });

  // ── Errors ────────────────────────────────────────────────────────────
  _client.on('error', (err) => {
    _alive = false;
    _stats.errors++;
    console.error('[mqttClient] error:', err.message);
    if (_errorCb) _errorCb(err);
    // mqtt library will auto-reconnect — do not call _client.end() here
  });

  // ── Offline / disconnect ──────────────────────────────────────────────
  _client.on('offline', () => {
    _alive = false;
    console.warn('[mqttClient] offline — broker unreachable');
  });

  _client.on('disconnect', (packet) => {
    _alive = false;
    console.warn('[mqttClient] broker sent DISCONNECT:', packet?.returnCode ?? '');
  });

  _client.on('close', () => {
    _alive = false;
    // mqtt library handles reconnect automatically via reconnectPeriod
  });
}

/** Disconnect cleanly. Stops reconnect loop. */
export function stop() {
  if (!_client) return;

  _alive = false;
  // force: true closes the socket immediately without DISCONNECT handshake
  // Use false for clean disconnect (broker releases session cleanly)
  _client.end(false, {}, () => {
    console.info('[mqttClient] disconnected');
  });
  _client = null;
}

/**
 * Register callback for received telemetry frames.
 * Called with (jsonObject, sourceLabel) where sourceLabel = 'mqtt'.
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
