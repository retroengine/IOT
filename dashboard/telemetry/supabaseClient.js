/**
 * supabaseClient.js — Browser-side Supabase query client
 * Used by page5-analytics.js to fetch historical telemetry from Supabase.
 *
 * Uses the Supabase JS CDN build (ESM) — no bundler required.
 * The anon key is safe to expose in the browser (row-level security controls access).
 *
 * Public API:
 *   fetchTelemetry(field, from, to, limit)  → [{ts, value}]
 *   fetchFaultEvents(from, to)              → [{ts, from_state, to_state, ...}]
 *   fetchEnergyDaily(days)                  → [{date, energy_wh_total, ...}]
 *   isAvailable()                           → boolean
 */

// ── Config — set via environment or update before deploying ───────────────
// The anon key is safe to expose in the browser (row-level security controls access),
// but keep credentials out of source control. Override at build/deploy time.
const SUPABASE_URL      = ''; // e.g. 'https://your-project.supabase.co'
const SUPABASE_ANON_KEY = ''; // e.g. 'eyJhbGciOi...'
const DEVICE_ID         = 'sgs-device-01';

// ── Column mapping (field key → DB column name) ─────────────────────────────
const FIELD_COL = {
  v:    'voltage_v',
  i:    'current_a',
  t:    'temperature_c',
  p:    'power_w',
  pf:   'power_factor',
  e:    'energy_wh',
  freq: 'frequency_hz',
  va:   'apparent_va',
};

// ── Lazy Supabase client (import from CDN) ───────────────────────────────────
let _sbClient = null;

async function _getClient() {
  if (_sbClient) return _sbClient;
  try {
    const { createClient } = await import(
      'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'
    );
    _sbClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });
    return _sbClient;
  } catch (err) {
    console.error('[supabaseClient] failed to load Supabase JS:', err);
    return null;
  }
}

/**
 * Fetch a single telemetry field as a time-series array.
 *
 * @param {string} field   — 'v' | 'i' | 't' | 'p' | 'pf'
 * @param {Date}   from    — start of range
 * @param {Date}   to      — end of range
 * @param {number} [limit] — max rows (default 1000)
 * @returns {Promise<Array<{ts: number, value: number}>>}
 */
export async function fetchTelemetry(field, from, to, limit = 1000) {
  const col = FIELD_COL[field];
  if (!col) throw new Error(`[supabaseClient] unknown field: ${field}`);

  const sb = await _getClient();
  if (!sb) return [];

  const { data, error } = await sb
    .from('telemetry_snapshots')
    .select(`ts, ${col}`)
    .eq('device_id', DEVICE_ID)
    .gte('ts', from.toISOString())
    .lte('ts', to.toISOString())
    .order('ts', { ascending: true })
    .limit(limit);

  if (error) {
    console.error(`[supabaseClient] fetchTelemetry error (${field}):`, error.message);
    return [];
  }

  // Convert to the {ts: epochMs, value: number} shape expected by canvasEngine
  return (data || [])
    .filter(row => row[col] != null)
    .map(row => ({
      ts:    new Date(row.ts).getTime(),   // UTC ISO string → epoch ms
      value: Number(row[col]),
    }));
}

/**
 * Fetch multiple telemetry fields in parallel.
 *
 * @param {string[]} fields   — e.g. ['v', 'i', 't', 'p']
 * @param {Date}     from
 * @param {Date}     to
 * @param {number}   [limit]
 * @returns {Promise<Record<string, Array<{ts, value}>>>}
 */
export async function fetchTelemetryMulti(fields, from, to, limit = 1000) {
  const results = await Promise.all(
    fields.map(f => fetchTelemetry(f, from, to, limit))
  );
  return Object.fromEntries(fields.map((f, i) => [f, results[i]]));
}

/**
 * Fetch fault/FSM transition events.
 *
 * @param {Date}   from
 * @param {Date}   to
 * @param {number} [limit]
 * @returns {Promise<Array>}
 */
export async function fetchFaultEvents(from, to, limit = 500) {
  const sb = await _getClient();
  if (!sb) return [];

  const { data, error } = await sb
    .from('fault_events')
    .select('ts, from_state, to_state, fault_code, voltage_v, current_a, temperature_c, fault_probability, risk_level, trip_count')
    .eq('device_id', DEVICE_ID)
    .gte('ts', from.toISOString())
    .lte('ts', to.toISOString())
    .order('ts', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('[supabaseClient] fetchFaultEvents error:', error.message);
    return [];
  }

  // Convert ts to epochMs for chart rendering
  return (data || []).map(row => ({
    ...row,
    ts: new Date(row.ts).getTime(),
  }));
}

/**
 * Fetch daily energy totals for the last N days.
 *
 * @param {number} [days] — number of past days (default 30)
 * @returns {Promise<Array>}
 */
export async function fetchEnergyDaily(days = 30) {
  const sb = await _getClient();
  if (!sb) return [];

  const { data, error } = await sb
    .from('energy_daily')
    .select('date, energy_wh_total, peak_voltage_v, min_voltage_v, avg_power_w, avg_current_a, avg_temperature_c, fault_count, uptime_s, sample_count')
    .eq('device_id', DEVICE_ID)
    .gte('date', new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10))
    .order('date', { ascending: true })
    .limit(days);

  if (error) {
    console.error('[supabaseClient] fetchEnergyDaily error:', error.message);
    return [];
  }

  return data || [];
}

/**
 * Fetch recent MQTT connection events.
 *
 * @param {number} [limit]
 * @returns {Promise<Array>}
 */
export async function fetchMqttEvents(limit = 100) {
  const sb = await _getClient();
  if (!sb) return [];

  const { data, error } = await sb
    .from('mqtt_events')
    .select('ts, event_type, reconnect_count, publish_total, publish_failed, error_msg')
    .eq('device_id', DEVICE_ID)
    .order('ts', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[supabaseClient] fetchMqttEvents error:', error.message);
    return [];
  }

  return (data || []).map(row => ({
    ...row,
    ts: new Date(row.ts).getTime(),
  }));
}

/** @returns {boolean} true if Supabase URL is configured */
export function isAvailable() {
  return !!(SUPABASE_URL && SUPABASE_ANON_KEY);
}
