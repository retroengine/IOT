// ============================================================
//  supabaseWriter.js — Smart Grid Sentinel Analytics Backend
//
//  Persists telemetry data to Supabase Postgres.
//  All timestamps are written as UTC ISO-8601 strings so that
//  Supabase stores them as proper timestamptz columns.
//
//  What gets written:
//    1. telemetry_snapshots — every snapshotIntervalMs (default 60s)
//    2. fault_events        — immediately on every FSM state transition
//    3. energy_daily        — upserted hourly with aggregated daily totals
//    4. mqtt_events         — on connection lifecycle changes (from server.js)
//
//  Public API:
//    start()                      — begin background write loops
//    stop()                       — flush and stop
//    ingestFrame(frame, source)   — called on every data frame
//    writeMqttEvent(type, detail) — called from server.js on MQTT events
//    getStats()                   — { snapshotsSaved, faultsSaved, errors }
// ============================================================

import { createClient } from '@supabase/supabase-js';
import { config }       from './config.js';

// ── Supabase client ───────────────────────────────────────────────────────
let _sb = null;

function _client() {
  if (!_sb) {
    _sb = createClient(config.supabase.url, config.supabase.anonKey, {
      auth: { persistSession: false },  // server-side — no token persistence needed
    });
  }
  return _sb;
}

// ── State ─────────────────────────────────────────────────────────────────
let _started         = false;
let _snapshotTimer   = null;
let _dailyTimer      = null;
let _lastFrame       = null;      // most recent canonical frame
let _lastFsmState    = null;      // track FSM transitions
let _dailyAggregator = _newDailyAgg();
let _stats           = { snapshotsSaved: 0, faultsSaved: 0, dailySaved: 0, mqttEventsSaved: 0, errors: 0 };

// ── Daily aggregator ──────────────────────────────────────────────────────

function _newDailyAgg() {
  return {
    date:         _utcDateStr(new Date()),
    voltages:     [],
    currents:     [],
    temperatures: [],
    powers:       [],
    uptime_s:     0,
    fault_count:  0,
    trip_count:   0,
    samples:      0,
  };
}

/** Return 'YYYY-MM-DD' in UTC */
function _utcDateStr(d) {
  return d.toISOString().slice(0, 10);
}

/** Return full ISO-8601 UTC timestamp string for a given epoch ms */
function _isoTs(epochMs) {
  return new Date(epochMs).toISOString();
}

// ── Ingest frame (called on every frame from dataRouter) ──────────────────

/**
 * Process an incoming canonical telemetry frame.
 * Immediately checks for FSM transitions (→ fault_event).
 * Accumulates into daily aggregator.
 *
 * @param {object} frame   canonical telemetry from telemetryParser
 * @param {string} source  'esp32ws' | 'esp32http' | 'mqtt' | 'mock'
 */
export function ingestFrame(frame, source) {
  if (!config.supabase.enabled || !frame) return;

  // Update latest frame
  _lastFrame = { ...frame, _source: source };

  // ── FSM transition detection ─────────────────────────────────────────
  const newState = frame.state || 'BOOT';
  if (_lastFsmState !== null && _lastFsmState !== newState) {
    // State changed — write fault_event immediately
    _writeFaultEvent(frame, source, _lastFsmState, newState).catch(err => {
      console.error('[supabaseWriter] fault_event write failed:', err.message);
      _stats.errors++;
    });
  }
  _lastFsmState = newState;

  // ── Daily accumulation ───────────────────────────────────────────────
  const today = _utcDateStr(new Date());
  if (_dailyAggregator.date !== today) {
    // Day rolled over — reset aggregator (daily upsert will run from timer)
    _dailyAggregator = _newDailyAgg();
    _dailyAggregator.date = today;
  }

  const agg = _dailyAggregator;
  if (typeof frame.v === 'number') agg.voltages.push(frame.v);
  if (typeof frame.i === 'number') agg.currents.push(frame.i);
  if (typeof frame.t === 'number') agg.temperatures.push(frame.t);
  if (typeof frame.p === 'number') agg.powers.push(frame.p);
  if (typeof frame.uptime === 'number') agg.uptime_s = frame.uptime;
  if (typeof frame.faults?.trip_count === 'number') agg.trip_count = frame.faults.trip_count;
  agg.samples++;
}

// ── Snapshot writer ───────────────────────────────────────────────────────

async function _writeSnapshot() {
  if (!_lastFrame) return;

  const f  = _lastFrame;
  const ts = _isoTs(typeof f.ts === 'number' ? f.ts : Date.now());

  const row = {
    device_id:      config.supabase.deviceId,
    ts,                                           // ← proper UTC timestamp
    voltage_v:      f.v       ?? null,
    current_a:      f.i       ?? null,
    temperature_c:  f.t       ?? null,
    power_w:        f.p       ?? null,
    apparent_va:    f.va      ?? null,
    energy_wh:      f.e       ?? null,
    power_factor:   f.pf      ?? null,
    frequency_hz:   f.freq    ?? null,
    fsm_state:      f.state   ?? null,
    health_score:   f.health  ?? null,
    relay_on:       f.relay   ?? null,
    trip_count:     f.faults?.trip_count ?? null,
    fault_code:     f.faults?.active     ?? null,
    wifi_rssi:      f.wifi?.rssi         ?? null,
    mqtt_connected: f.mqtt?.connected    ?? null,
    free_heap:      f.sys?.free_heap     ?? null,
    uptime_s:       f.sys?.uptime_s      ?? null,
    cpu_load_pct:   f.sys?.cpu_load_pct  ?? null,
    source:         f._source  ?? 'unknown',
    schema_v:       f.schema_v ?? '1.3',
  };

  const { error } = await _client()
    .from('telemetry_snapshots')
    .insert(row);

  if (error) {
    console.error('[supabaseWriter] snapshot insert error:', error.message);
    _stats.errors++;
  } else {
    _stats.snapshotsSaved++;
    if (_stats.snapshotsSaved % 10 === 1) {
      console.info(`[supabaseWriter] ✓ ${_stats.snapshotsSaved} snapshots saved  (last ts: ${ts})`);
    }
  }
}

// ── Fault event writer ────────────────────────────────────────────────────

async function _writeFaultEvent(frame, source, fromState, toState) {
  const ts = _isoTs(typeof frame.ts === 'number' ? frame.ts : Date.now());

  const row = {
    device_id:         config.supabase.deviceId,
    ts,                                            // ← proper UTC timestamp
    from_state:        fromState,
    to_state:          toState,
    fault_code:        frame.faults?.active          ?? 'NONE',
    trip_count:        frame.faults?.trip_count      ?? null,
    voltage_v:         frame.v                       ?? null,
    current_a:         frame.i                       ?? null,
    temperature_c:     frame.t                       ?? null,
    power_w:           frame.p                       ?? null,
    fault_probability: frame.prediction?.fault_probability ?? null,
    risk_level:        frame.prediction?.risk_level        ?? null,
    health_score:      frame.health                  ?? null,
    source,
  };

  const { error } = await _client()
    .from('fault_events')
    .insert(row);

  if (error) {
    console.error('[supabaseWriter] fault_event insert error:', error.message);
    _stats.errors++;
  } else {
    _stats.faultsSaved++;
    console.info(`[supabaseWriter] ⚡ fault_event: ${fromState} → ${toState}  ts: ${ts}`);
  }
}

// ── Daily aggregation writer ──────────────────────────────────────────────

function _avg(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
function _max(arr) { return arr && arr.length ? Math.max(...arr) : null; }
function _min(arr) { return arr && arr.length ? Math.min(...arr) : null; }

async function _writeDailyUpsert() {
  const agg = _dailyAggregator;
  if (agg.samples === 0) return;

  const now = new Date().toISOString();

  const row = {
    device_id:        config.supabase.deviceId,
    date:             agg.date,                   // UTC date string 'YYYY-MM-DD'
    energy_wh_total:  _lastFrame?.e               ?? null,
    peak_voltage_v:   _max(agg.voltages),
    min_voltage_v:    _min(agg.voltages),
    avg_power_w:      _avg(agg.powers),
    avg_current_a:    _avg(agg.currents),
    avg_temperature_c:_avg(agg.temperatures),
    uptime_s:         agg.uptime_s,
    fault_count:      agg.fault_count,
    trip_count_end:   agg.trip_count,
    sample_count:     agg.samples,
    updated_at:       now,
  };

  const { error } = await _client()
    .from('energy_daily')
    .upsert(row, { onConflict: 'device_id,date' });

  if (error) {
    console.error('[supabaseWriter] energy_daily upsert error:', error.message);
    _stats.errors++;
  } else {
    _stats.dailySaved++;
    console.info(`[supabaseWriter] 📅 energy_daily upserted for ${agg.date}  samples: ${agg.samples}`);
  }
}

// ── MQTT event writer (public) ────────────────────────────────────────────

/**
 * Write a connection lifecycle event to mqtt_events table.
 * Called externally from server.js on MQTT connect/disconnect.
 *
 * @param {'connected'|'disconnected'|'reconnect'|'publish_failed'} eventType
 * @param {object} [detail]  optional extra fields
 */
export async function writeMqttEvent(eventType, detail = {}) {
  if (!config.supabase.enabled) return;

  const ts = new Date().toISOString();           // ← always fresh UTC timestamp

  const row = {
    device_id:       config.supabase.deviceId,
    ts,
    event_type:      eventType,
    reconnect_count: detail.reconnects   ?? null,
    publish_total:   detail.received     ?? null,
    publish_failed:  detail.errors       ?? null,
    broker:          config.mqtt.host,
    error_msg:       detail.message      ?? null,
  };

  const { error } = await _client()
    .from('mqtt_events')
    .insert(row);

  if (error) {
    console.error('[supabaseWriter] mqtt_event insert error:', error.message);
    _stats.errors++;
  } else {
    _stats.mqttEventsSaved++;
    console.info(`[supabaseWriter] 🔌 mqtt_event: ${eventType}  ts: ${ts}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/** Start background write loops. */
export function start() {
  if (!config.supabase.enabled) {
    console.warn('[supabaseWriter] Supabase not configured — analytics disabled');
    return;
  }
  if (_started) return;
  _started = true;

  console.info(`[supabaseWriter] starting — writing to ${config.supabase.url}`);
  console.info(`[supabaseWriter] snapshot interval: ${config.supabase.snapshotIntervalMs / 1000}s`);

  // Telemetry snapshot: every snapshotIntervalMs
  _snapshotTimer = setInterval(() => {
    _writeSnapshot().catch(err => {
      console.error('[supabaseWriter] snapshot error:', err.message);
      _stats.errors++;
    });
  }, config.supabase.snapshotIntervalMs);

  // Daily rollup upsert: every hour
  _dailyTimer = setInterval(() => {
    _writeDailyUpsert().catch(err => {
      console.error('[supabaseWriter] daily upsert error:', err.message);
      _stats.errors++;
    });
  }, 3_600_000);

  // Write one snapshot immediately if we have data
  setTimeout(() => {
    if (_lastFrame) _writeSnapshot();
  }, 5000);
}

/** Flush any pending data and stop timers. */
export async function stop() {
  _started = false;
  if (_snapshotTimer) { clearInterval(_snapshotTimer); _snapshotTimer = null; }
  if (_dailyTimer)    { clearInterval(_dailyTimer);    _dailyTimer    = null; }

  // Final flush
  try {
    await _writeSnapshot();
    await _writeDailyUpsert();
    console.info('[supabaseWriter] final flush complete');
  } catch (err) {
    console.error('[supabaseWriter] stop flush error:', err.message);
  }
}

/** @returns {object} diagnostic counters */
export function getStats() {
  return { ..._stats };
}
