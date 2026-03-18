/**
 * telemetryPoller.js — Smart Grid Sentinel Telemetry Poller
 * Source of truth: DESIGN.md v3.3, Sections 6, 7, and 18
 *
 * Manages the live data connection between the dashboard and the ESP32.
 * Primary transport: WebSocket (server-initiated push every ~2s).
 * Fallback transport: HTTP GET /api/telemetry (polled at 100ms to approximate
 *                     10Hz display rate per Phase 2 spec).
 *
 * Connection state machine:
 *   IDLE → CONNECTING → OPEN → (WS push frames arrive)
 *                 ↓ on WS failure
 *           RECONNECTING (exponential backoff: 500ms→1s→2s→4s→30s cap)
 *                 ↓ after 3 consecutive reconnect failures
 *           HTTP_FALLBACK (polls /api/telemetry every 100ms)
 *                 ↓ when WS recovers
 *           OPEN (resumes WS, drops HTTP polling)
 *
 * SEPARATION RULE: No document.* calls. No imports from /components or /pages.
 * The poller writes to the buffer and notifies listeners — it never touches DOM.
 *
 * Public API:
 *   connect(host)               — start the connection
 *   disconnect()                — stop all transports and timers
 *   onMessage(callback)         — register a listener for parsed telemetry
 *   onStateChange(callback)     — register a listener for connection state events
 *   getLatest()                 → last parsed canonical telemetry object | null
 *   getConnectionState()        → current state string
 *
 * ─────────────────────────────────────────────────────────────────────────
 * MQTT WSS transport (Phase 7 — implemented)
 * ─────────────────────────────────────────────────────────────────────────
 * The WS+HTTP transport works only on the local network (direct ESP32 LAN IP).
 * The MQTT WSS transport connects via HiveMQ Cloud and works from any network —
 * the dashboard can be hosted on Netlify/GitHub Pages and receive live data.
 *
 * Implementation: native WebSocket with MQTT 3.1.1 binary framing.
 * No external library. No bundler. Pure ES module — drops straight into the
 * existing project with zero build-step changes.
 *
 * Public API additions (see bottom of this file):
 *   connectMqtt(config)     — start MQTT WSS transport
 *   disconnectMqtt()        — stop MQTT WSS transport
 *   getMqttState()          — current MQTT connection state string
 *   onMqttStateChange(cb)   — register listener for MQTT state transitions
 *
 * Called by: pages/page4-cloud.js credential form (user supplies credentials)
 * Credentials are NOT hardcoded — user enters them in the Page 4 UI.
 * Broker URL, username, and topic filter are persisted in localStorage.
 * Password is session-only (never stored).
 * ─────────────────────────────────────────────────────────────────────────
 */

import { parse }                        from './telemetryParser.js';
import { push as bufferPush }           from './telemetryBuffer.js';

// ── Connection state constants ────────────────────────────────────────────────
export const CONNECTION_STATE = {
  IDLE:          'IDLE',
  CONNECTING:    'CONNECTING',
  OPEN:          'OPEN',
  RECONNECTING:  'RECONNECTING',
  HTTP_FALLBACK: 'HTTP_FALLBACK',
  DISCONNECTED:  'DISCONNECTED',
};

// ── Backoff config ─────────────────────────────────────────────────────────
const BACKOFF_BASE_MS              = 500;
const BACKOFF_MAX_MS               = 30000;
const BACKOFF_MULTIPLIER           = 2;
const MAX_WS_FAILS_BEFORE_FALLBACK = 3;

// ── HTTP fallback poll interval ────────────────────────────────────────────
const HTTP_POLL_INTERVAL_MS = 100;

// ── WS heartbeat config ────────────────────────────────────────────────────
const WS_PING_INTERVAL_MS   = 60000;  // ping every 60s — data stream is the real heartbeat
const WS_PONG_TIMEOUT_MS    = 30000;  // 30s timeout — only fires if data stream is also dead

// ── Internal state ────────────────────────────────────────────────────────
let _ws              = null;
let _connectionState = CONNECTION_STATE.IDLE;
let _latestTelemetry = null;
let _messageListeners   = [];
let _stateListeners     = [];

let _reconnectAttempts  = 0;
let _backoffMs          = BACKOFF_BASE_MS;
let _backoffTimer       = null;

let _httpPollTimer      = null;
let _wsPingTimer        = null;
let _wsPongTimeoutTimer = null;

let _host    = null;
let _wsUrl   = null;
let _httpUrl = null;

// ── State machine transition ───────────────────────────────────────────────
function _setState(newState, detail = {}) {
  if (_connectionState === newState) return;
  _connectionState = newState;
  for (const cb of _stateListeners) {
    _callSafe(cb, newState, detail);
  }
}

// ── Safe callback invocation ──────────────────────────────────────────────
function _callSafe(fn, ...args) {
  try {
    fn(...args);
  } catch (err) {
    console.error('[telemetryPoller] listener error:', err);
  }
}

// ── Frame processing pipeline ─────────────────────────────────────────────
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

  _latestTelemetry = canonical;

  const ts = canonical.ts || Date.now();
  bufferPush('v', canonical.v, ts);
  bufferPush('i', canonical.i, ts);
  bufferPush('t', canonical.t, ts);
  bufferPush('p', canonical.p, ts);

  for (const cb of _messageListeners) {
    _callSafe(cb, canonical);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// WebSocket transport
// ══════════════════════════════════════════════════════════════════════════

function _openWebSocket() {
  _setState(CONNECTION_STATE.CONNECTING);
  try {
    _ws = new WebSocket(_wsUrl);
  } catch (err) {
    console.error('[telemetryPoller] WebSocket construction failed:', err);
    _onWsFailure();
    return;
  }
  _ws.onopen    = _onWsOpen;
  _ws.onmessage = _onWsMessage;
  _ws.onerror   = _onWsError;
  _ws.onclose   = _onWsClose;
}

function _onWsOpen() {
  console.info('[telemetryPoller] WebSocket connected:', _wsUrl);
  _setState(CONNECTION_STATE.OPEN, { transport: 'websocket', url: _wsUrl });
  _reconnectAttempts = 0;
  _backoffMs         = BACKOFF_BASE_MS;
  _stopHttpFallback();
  _startPing();
  // Start a data-stream watchdog — if no message arrives in 10s, connection is dead
  _startDataWatchdog();
}

function _onWsMessage(event) {
  _resetPongTimeout();
  _resetDataWatchdog();  // any incoming frame proves connection is alive
  _processFrame(event.data);
}

function _onWsError(event) {
  console.warn('[telemetryPoller] WebSocket error', event);
  _setState(CONNECTION_STATE.RECONNECTING, { error: 'ws_error' });
}

function _onWsClose(event) {
  _stopPing();
  _stopDataWatchdog();
  if (_connectionState === CONNECTION_STATE.DISCONNECTED) return;
  console.warn(`[telemetryPoller] WebSocket closed (code ${event.code})`);
  _onWsFailure();
}

function _onWsFailure() {
  _cleanupWs();
  _reconnectAttempts++;
  _startHttpFallback();
  if (_reconnectAttempts >= MAX_WS_FAILS_BEFORE_FALLBACK) {
    _scheduleWsReconnect(BACKOFF_MAX_MS);
  } else {
    _scheduleWsReconnect(_backoffMs);
    _backoffMs = Math.min(_backoffMs * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
  }
}

function _scheduleWsReconnect(delayMs) {
  _setState(CONNECTION_STATE.RECONNECTING, { delayMs });
  _clearBackoffTimer();
  _backoffTimer = setTimeout(() => {
    _backoffTimer = null;
    if (_connectionState !== CONNECTION_STATE.DISCONNECTED) _openWebSocket();
  }, delayMs);
}

function _cleanupWs() {
  _stopPing();
  if (_ws) {
    _ws.onopen = null; _ws.onmessage = null;
    _ws.onerror = null; _ws.onclose = null;
    try { _ws.close(); } catch (_) { /* ignore */ }
    _ws = null;
  }
}

// ── Heartbeat ─────────────────────────────────────────────────────────────
function _startPing() {
  _stopPing();
  _wsPingTimer = setInterval(() => {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      try { _ws.send(JSON.stringify({ type: 'ping' })); _startPongTimeout(); }
      catch (_) { /* ignore */ }
    }
  }, WS_PING_INTERVAL_MS);
}

function _stopPing() {
  clearInterval(_wsPingTimer);
  _wsPingTimer = null;
  _clearPongTimeout();
}

function _startPongTimeout() {
  _clearPongTimeout();
  _wsPongTimeoutTimer = setTimeout(() => {
    console.warn('[telemetryPoller] pong timeout — marking connection lost');
    _onWsFailure();
  }, WS_PONG_TIMEOUT_MS);
}

function _resetPongTimeout() {
  if (_wsPongTimeoutTimer) _startPongTimeout();
}

function _clearPongTimeout() {
  clearTimeout(_wsPongTimeoutTimer);
  _wsPongTimeoutTimer = null;
}

// ── Data stream watchdog ───────────────────────────────────────────────────
// Independent of the ping/pong mechanism. Monitors raw message arrival.
// If no message arrives within 10s the connection is silently dead.
// At 100ms push rate from relay server, 10s = 100 missed frames.
const DATA_WATCHDOG_MS = 10000;
let _dataWatchdogTimer = null;

function _startDataWatchdog() {
  _resetDataWatchdog();
}

function _resetDataWatchdog() {
  clearTimeout(_dataWatchdogTimer);
  _dataWatchdogTimer = setTimeout(() => {
    console.warn('[telemetryPoller] data watchdog — no frames in 10s, reconnecting');
    _onWsFailure();
  }, DATA_WATCHDOG_MS);
}

function _stopDataWatchdog() {
  clearTimeout(_dataWatchdogTimer);
  _dataWatchdogTimer = null;
}

// ══════════════════════════════════════════════════════════════════════════
// HTTP fallback transport
// ══════════════════════════════════════════════════════════════════════════

function _startHttpFallback() {
  if (_httpPollTimer) return;
  _setState(CONNECTION_STATE.HTTP_FALLBACK, { transport: 'http', url: _httpUrl });
  console.info('[telemetryPoller] HTTP fallback polling started:', _httpUrl);
  _httpPollTimer = setInterval(_httpPoll, HTTP_POLL_INTERVAL_MS);
  _httpPoll();
}

function _stopHttpFallback() {
  clearInterval(_httpPollTimer);
  _httpPollTimer = null;
}

async function _httpPoll() {
  try {
    const response = await fetch(_httpUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      console.warn(`[telemetryPoller] HTTP poll ${response.status}`);
      _setState(CONNECTION_STATE.HTTP_FALLBACK, { transport: 'http', httpStatus: response.status });
      return;
    }
    const json = await response.json();
    _processFrame(json);
  } catch (err) {
    _setState(CONNECTION_STATE.DISCONNECTED, { error: err.message });
  }
}

function _clearBackoffTimer() {
  clearTimeout(_backoffTimer);
  _backoffTimer = null;
}

// ══════════════════════════════════════════════════════════════════════════
// Public API
// ══════════════════════════════════════════════════════════════════════════

/**
 * Start the telemetry connection.
 * @param {string} [host] — ESP32 host, e.g. '10.177.189.199'. Defaults to window.location.host.
 */
export function connect(host) {
  if (_connectionState !== CONNECTION_STATE.IDLE &&
      _connectionState !== CONNECTION_STATE.DISCONNECTED) {
    console.warn('[telemetryPoller] connect() called while already active — ignoring');
    return;
  }
  _host    = host || (typeof window !== 'undefined' ? window.location.host : 'localhost');
  _wsUrl   = `ws://${_host}/ws/telemetry`;
  _httpUrl = `http://${_host}/api/telemetry`;
  _reconnectAttempts = 0;
  _backoffMs         = BACKOFF_BASE_MS;
  _openWebSocket();
}

/** Stop all transports, timers, and listeners. */
export function disconnect() {
  _setState(CONNECTION_STATE.DISCONNECTED);
  _stopHttpFallback();
  _stopPing();
  _clearBackoffTimer();
  _cleanupWs();
}

/**
 * @param {function} callback
 * @returns {function} unsubscribe
 */
export function onMessage(callback) {
  if (typeof callback !== 'function') throw new TypeError('[telemetryPoller] onMessage() requires a function');
  _messageListeners.push(callback);
  return () => { _messageListeners = _messageListeners.filter(cb => cb !== callback); };
}

/**
 * @param {function} callback
 * @returns {function} unsubscribe
 */
export function onStateChange(callback) {
  if (typeof callback !== 'function') throw new TypeError('[telemetryPoller] onStateChange() requires a function');
  _stateListeners.push(callback);
  return () => { _stateListeners = _stateListeners.filter(cb => cb !== callback); };
}

/** @returns {object|null} */
export function getLatest() { return _latestTelemetry; }

/** @returns {string} */
export function getConnectionState() { return _connectionState; }

// ── Convenience event name aliases ────────────────────────────────────────
export const EVENT = {
  CONNECTED:    CONNECTION_STATE.OPEN,
  DISCONNECTED: CONNECTION_STATE.DISCONNECTED,
  ERROR:        CONNECTION_STATE.RECONNECTING,
};

// ══════════════════════════════════════════════════════════════════════════
// MQTT WSS Transport — Phase 7
// Native MQTT 3.1.1 over WebSocket (subscribe-only, no external library)
//
// This section is purely additive. All existing WS/HTTP transport code
// above is unchanged. Both transports share _processFrame() and all
// registered _messageListeners — same data pipeline, different source.
//
// Called by: pages/page4-cloud.js (credential form UI)
// ══════════════════════════════════════════════════════════════════════════

// ── MQTT state constants ──────────────────────────────────────────────────
export const MQTT_STATE = {
  IDLE:         'IDLE',
  CONNECTING:   'CONNECTING',
  CONNECTED:    'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  DISCONNECTED: 'DISCONNECTED',
  ERROR:        'ERROR',
};

// ── MQTT internal state ───────────────────────────────────────────────────
let _mqttWs              = null;
let _mqttState           = MQTT_STATE.IDLE;
let _mqttConfig          = null;       // { brokerUrl, username, password, topicFilter }
let _mqttListeners       = [];
let _mqttPingTimer       = null;
let _mqttReconnectTimer  = null;
let _mqttBackoffMs       = 2000;
let _mqttRxBuffer        = new Uint8Array(0);
let _mqttPacketIdCounter = 1;

const MQTT_KEEPALIVE_S   = 30;
const MQTT_BACKOFF_MAX   = 60000;

// ── MQTT state transition ─────────────────────────────────────────────────
function _mqttSetState(newState, detail = {}) {
  if (_mqttState === newState) return;
  _mqttState = newState;
  for (const cb of _mqttListeners) _callSafe(cb, newState, detail);
}

// ── Binary encoding helpers ───────────────────────────────────────────────

const _utf8Enc = new TextEncoder();
const _utf8Dec = new TextDecoder();

/** Encode a UTF-8 string with a 2-byte big-endian length prefix. */
function _mqttStr(str) {
  const bytes = _utf8Enc.encode(str);
  const out   = new Uint8Array(2 + bytes.length);
  out[0] = (bytes.length >> 8) & 0xff;
  out[1] =  bytes.length       & 0xff;
  out.set(bytes, 2);
  return out;
}

/** Encode a remaining-length value (MQTT variable-length encoding). */
function _mqttRemLen(len) {
  const bytes = [];
  do {
    let b = len % 128;
    len   = Math.floor(len / 128);
    if (len > 0) b |= 0x80;
    bytes.push(b);
  } while (len > 0);
  return new Uint8Array(bytes);
}

/** Concatenate multiple Uint8Arrays into one. */
function _mqttConcat(arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out   = new Uint8Array(total);
  let offset  = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

/** Build a complete MQTT packet: fixed header byte + remaining length + payload. */
function _mqttPacket(fixedByte, payload) {
  return _mqttConcat([
    new Uint8Array([fixedByte]),
    _mqttRemLen(payload.length),
    payload,
  ]);
}

// ── Packet builders ───────────────────────────────────────────────────────

function _buildConnect(clientId, username, password) {
  const protoName  = _mqttStr('MQTT');
  const protoLevel = new Uint8Array([0x04]);     // MQTT 3.1.1

  let flags = 0x02; // clean session
  if (username) flags |= 0x80;
  if (password) flags |= 0x40;

  const varHeader = _mqttConcat([
    protoName,
    protoLevel,
    new Uint8Array([flags]),
    new Uint8Array([(MQTT_KEEPALIVE_S >> 8) & 0xff, MQTT_KEEPALIVE_S & 0xff]),
  ]);

  const payloadParts = [_mqttStr(clientId)];
  if (username) payloadParts.push(_mqttStr(username));
  if (password) payloadParts.push(_mqttStr(password));

  return _mqttPacket(0x10, _mqttConcat([varHeader, _mqttConcat(payloadParts)]));
}

function _buildSubscribe(packetId, topicFilter, qos = 0) {
  const payload = _mqttConcat([
    new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff]),
    _mqttStr(topicFilter),
    new Uint8Array([qos]),
  ]);
  return _mqttPacket(0x82, payload);
}

function _buildPingreq()   { return new Uint8Array([0xC0, 0x00]); }
function _buildDisconnect(){ return new Uint8Array([0xE0, 0x00]); }

// ── Incoming packet parser ────────────────────────────────────────────────

/** Append newly received bytes to the reassembly buffer, then drain packets. */
function _mqttOnData(data) {
  const incoming  = new Uint8Array(data);
  const combined  = new Uint8Array(_mqttRxBuffer.length + incoming.length);
  combined.set(_mqttRxBuffer, 0);
  combined.set(incoming, _mqttRxBuffer.length);
  _mqttRxBuffer = combined;
  _mqttDrainBuffer();
}

/** Extract and dispatch all complete packets from the receive buffer. */
function _mqttDrainBuffer() {
  while (_mqttRxBuffer.length >= 2) {
    // Decode variable remaining-length starting at byte 1
    let remLen     = 0;
    let multiplier = 1;
    let offset     = 1;

    while (offset < _mqttRxBuffer.length) {
      const byte = _mqttRxBuffer[offset++];
      remLen    += (byte & 0x7F) * multiplier;
      multiplier *= 128;
      if ((byte & 0x80) === 0) break;
      if (multiplier > 128 * 128 * 128) {
        // Malformed remaining length — reset buffer
        _mqttRxBuffer = new Uint8Array(0);
        return;
      }
    }

    const totalLen = offset + remLen;
    if (_mqttRxBuffer.length < totalLen) break; // incomplete — wait for more

    const packet      = _mqttRxBuffer.slice(0, totalLen);
    _mqttRxBuffer     = _mqttRxBuffer.slice(totalLen);
    const packetType  = (packet[0] & 0xF0) >> 4;

    _mqttDispatch(packetType, packet, offset);
  }
}

/** Dispatch a fully assembled packet to the correct handler. */
function _mqttDispatch(type, packet, varHeaderOffset) {
  switch (type) {
    case 2:  _mqttOnConnack(packet, varHeaderOffset); break; // CONNACK
    case 3:  _mqttOnPublish(packet, varHeaderOffset); break; // PUBLISH
    case 9:  _mqttOnSuback (packet, varHeaderOffset); break; // SUBACK
    case 13: /* PINGRESP — keepalive acknowledged */  break;
    default: /* ignore other packet types */          break;
  }
}

function _mqttOnConnack(packet, offset) {
  const returnCode = packet[offset + 1];
  if (returnCode !== 0) {
    const msg = [
      'unspecified', 'unacceptable protocol',
      'id rejected', 'server unavailable',
      'bad credentials', 'not authorized',
    ][returnCode] || `code ${returnCode}`;
    console.error(`[MQTT] CONNACK refused: ${msg}`);
    _mqttSetState(MQTT_STATE.ERROR, { reason: msg });
    _mqttCleanup();
    _mqttScheduleReconnect();
    return;
  }

  console.info('[MQTT] CONNACK accepted — subscribing to', _mqttConfig.topicFilter);
  _mqttSetState(MQTT_STATE.CONNECTED, { broker: _mqttConfig.brokerUrl });
  _mqttBackoffMs = 2000;

  // Subscribe to device telemetry topic
  const packetId = _mqttPacketIdCounter++;
  _mqttWs.send(_buildSubscribe(packetId, _mqttConfig.topicFilter, 0));

  // Start keepalive pings
  _mqttStartPing();
}

function _mqttOnPublish(packet, offset) {
  // Read topic string (2-byte length prefix)
  const topicLen   = (packet[offset] << 8) | packet[offset + 1];
  // payload starts after topic (QoS 0 has no packet ID)
  const payloadOff = offset + 2 + topicLen;
  const payloadStr = _utf8Dec.decode(packet.slice(payloadOff));

  // Feed into the shared frame processing pipeline
  _processFrame(payloadStr);
}

function _mqttOnSuback(packet, offset) {
  const returnCode = packet[offset + 2];
  if (returnCode === 0x80) {
    console.error('[MQTT] SUBACK: subscription refused');
  } else {
    console.info(`[MQTT] SUBACK: subscribed at QoS ${returnCode}`);
  }
}

// ── Keepalive ping ────────────────────────────────────────────────────────

function _mqttStartPing() {
  _mqttStopPing();
  _mqttPingTimer = setInterval(() => {
    if (_mqttWs && _mqttWs.readyState === WebSocket.OPEN) {
      _mqttWs.send(_buildPingreq());
    }
  }, MQTT_KEEPALIVE_S * 1000);
}

function _mqttStopPing() {
  clearInterval(_mqttPingTimer);
  _mqttPingTimer = null;
}

// ── Connection lifecycle ──────────────────────────────────────────────────

function _mqttOpen() {
  _mqttSetState(MQTT_STATE.CONNECTING);
  _mqttRxBuffer = new Uint8Array(0);

  try {
    // 'mqtt' is the IANA-registered WebSocket subprotocol for MQTT
    _mqttWs = new WebSocket(_mqttConfig.brokerUrl, ['mqtt']);
    _mqttWs.binaryType = 'arraybuffer';
  } catch (err) {
    console.error('[MQTT] WebSocket construction failed:', err);
    _mqttSetState(MQTT_STATE.ERROR, { reason: err.message });
    _mqttScheduleReconnect();
    return;
  }

  _mqttWs.onopen = () => {
    console.info('[MQTT] WebSocket open — sending CONNECT');
    // Derive a unique client ID (random suffix prevents collisions)
    const clientId = `sgs-dash-${Math.random().toString(36).slice(2, 8)}`;
    _mqttWs.send(_buildConnect(
      clientId,
      _mqttConfig.username || null,
      _mqttConfig.password || null,
    ));
  };

  _mqttWs.onmessage = (ev) => {
    _mqttOnData(ev.data);
  };

  _mqttWs.onerror = (ev) => {
    console.warn('[MQTT] WebSocket error', ev);
    _mqttSetState(MQTT_STATE.ERROR, { reason: 'ws_error' });
  };

  _mqttWs.onclose = (ev) => {
    _mqttStopPing();
    if (_mqttState === MQTT_STATE.DISCONNECTED) return; // deliberate close
    console.warn(`[MQTT] WebSocket closed (code ${ev.code}) — reconnecting`);
    _mqttCleanup();
    _mqttScheduleReconnect();
  };
}

function _mqttCleanup() {
  _mqttStopPing();
  if (_mqttWs) {
    _mqttWs.onopen = null;
    _mqttWs.onmessage = null;
    _mqttWs.onerror = null;
    _mqttWs.onclose = null;
    try { _mqttWs.close(); } catch (_) { /* ignore */ }
    _mqttWs = null;
  }
}

function _mqttScheduleReconnect() {
  if (_mqttState === MQTT_STATE.DISCONNECTED || !_mqttConfig) return;
  _mqttSetState(MQTT_STATE.RECONNECTING, { delayMs: _mqttBackoffMs });
  clearTimeout(_mqttReconnectTimer);
  _mqttReconnectTimer = setTimeout(() => {
    if (_mqttConfig && _mqttState !== MQTT_STATE.DISCONNECTED) _mqttOpen();
  }, _mqttBackoffMs);
  _mqttBackoffMs = Math.min(_mqttBackoffMs * 2, MQTT_BACKOFF_MAX);
}

// ══════════════════════════════════════════════════════════════════════════
// MQTT Public API
// ══════════════════════════════════════════════════════════════════════════

/**
 * Start the MQTT WSS transport.
 * Disconnects any running WS/HTTP transport first.
 * The same _messageListeners pipeline receives PUBLISH frames.
 *
 * @param {object} config
 *   @param {string} config.brokerUrl    — WSS URL, e.g. 'wss://host:8884/mqtt'
 *   @param {string} [config.username]   — MQTT username
 *   @param {string} [config.password]   — MQTT password (not stored)
 *   @param {string} [config.topicFilter]— MQTT topic, e.g. 'sgs/device/+/telemetry'
 */
export function connectMqtt(config) {
  if (!config?.brokerUrl) {
    console.error('[MQTT] connectMqtt: brokerUrl is required');
    return;
  }

  // Stop existing LAN transport — MQTT takes over as the data source
  disconnect();

  // Stop any previous MQTT session
  if (_mqttState !== MQTT_STATE.IDLE && _mqttState !== MQTT_STATE.DISCONNECTED) {
    disconnectMqtt();
  }

  _mqttConfig    = { ...config };
  _mqttBackoffMs = 2000;
  _mqttOpen();
}

/**
 * Stop the MQTT WSS transport gracefully.
 * Sends MQTT DISCONNECT before closing the WebSocket.
 */
export function disconnectMqtt() {
  clearTimeout(_mqttReconnectTimer);
  _mqttReconnectTimer = null;
  _mqttConfig = null;

  _mqttSetState(MQTT_STATE.DISCONNECTED);

  if (_mqttWs && _mqttWs.readyState === WebSocket.OPEN) {
    try { _mqttWs.send(_buildDisconnect()); } catch (_) { /* ignore */ }
  }
  _mqttCleanup();
  console.info('[MQTT] Disconnected');
}

/**
 * @returns {string} current MQTT state (one of MQTT_STATE values)
 */
export function getMqttState() { return _mqttState; }

/**
 * Register a listener for MQTT state transitions.
 * Callback receives (newState: string, detail: object).
 * @param {function} callback
 * @returns {function} unsubscribe
 */
export function onMqttStateChange(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('[MQTT] onMqttStateChange() requires a function');
  }
  _mqttListeners.push(callback);
  return () => { _mqttListeners = _mqttListeners.filter(cb => cb !== callback); };
}