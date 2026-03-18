// ============================================================
//  httpPoller.js — Direct ESP32 HTTP Telemetry Poller
//
//  Polls GET http://<esp32_ip>/api/telemetry at the configured
//  interval. Parses and validates the response JSON.
//  On success: calls the registered onData callback.
//  On failure: increments fail counter, calls onError callback.
//
//  No external dependencies. Uses Node.js built-in fetch (v18+).
//
//  Public API:
//    start()           — begin polling
//    stop()            — stop polling, cancel pending requests
//    onData(cb)        — register callback for valid telemetry frames
//    onError(cb)       — register callback for errors
//    isAlive()         — true if last poll succeeded
//    getStats()        — { ok, fail, lastOkMs, lastFailMs }
// ============================================================

import { config } from './config.js';

const ESP32_URL = `http://${config.esp32.ip}:${config.esp32.port}/api/telemetry`;

// ── State ─────────────────────────────────────────────────────────────────
let _timer        = null;
let _alive        = false;
let _dataCb       = null;
let _errorCb      = null;
let _stats        = { ok: 0, fail: 0, lastOkMs: 0, lastFailMs: 0 };
let _abortCtrl    = null;   // AbortController for the in-flight request

// ── Internal fetch ────────────────────────────────────────────────────────
async function _poll() {
  // Cancel any still-pending previous request before starting a new one.
  // This prevents pileup if the ESP32 is slow to respond.
  if (_abortCtrl) {
    _abortCtrl.abort();
  }
  _abortCtrl = new AbortController();

  const headers = { 'Accept': 'application/json' };
  if (config.esp32.apiKey) {
    headers['X-API-Key'] = config.esp32.apiKey;
  }

  try {
    const res = await fetch(ESP32_URL, {
      method:  'GET',
      headers,
      signal:  AbortSignal.any([
        _abortCtrl.signal,
        AbortSignal.timeout(config.esp32.timeoutMs),
      ]),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const json = await res.json();

    // Basic sanity check — must be an object with a sensors or v field
    if (typeof json !== 'object' || json === null) {
      throw new Error('Response is not a JSON object');
    }

    _alive = true;
    _stats.ok++;
    _stats.lastOkMs = Date.now();

    if (_dataCb) _dataCb(json, 'http');

  } catch (err) {
    // AbortError is expected on stop() or when we cancel a stale request.
    // Do not count it as a real failure.
    if (err.name === 'AbortError') return;

    _alive = false;
    _stats.fail++;
    _stats.lastFailMs = Date.now();

    const msg = `[httpPoller] poll failed: ${err.message}`;
    console.warn(msg);
    if (_errorCb) _errorCb(new Error(msg));
  } finally {
    _abortCtrl = null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/** Start polling. Safe to call multiple times — only one timer runs. */
export function start() {
  if (_timer) return;

  console.info(`[httpPoller] starting — polling ${ESP32_URL} every ${config.esp32.pollMs}ms`);

  // Fire once immediately, then on interval
  _poll();
  _timer = setInterval(_poll, config.esp32.pollMs);
}

/** Stop polling and cancel any in-flight request. */
export function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  if (_abortCtrl) {
    _abortCtrl.abort();
    _abortCtrl = null;
  }
  _alive = false;
  console.info('[httpPoller] stopped');
}

/**
 * Register callback for valid telemetry frames.
 * Called with (jsonObject, sourceLabel) where sourceLabel = 'http'.
 * @param {function} cb
 */
export function onData(cb) {
  if (typeof cb !== 'function') throw new TypeError('[httpPoller] onData requires a function');
  _dataCb = cb;
}

/**
 * Register callback for errors.
 * Called with (Error).
 * @param {function} cb
 */
export function onError(cb) {
  if (typeof cb !== 'function') throw new TypeError('[httpPoller] onError requires a function');
  _errorCb = cb;
}

/** @returns {boolean} true if the last poll succeeded */
export function isAlive() { return _alive; }

/** @returns {object} diagnostic counters */
export function getStats() { return { ..._stats }; }
