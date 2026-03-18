/**
 * telemetryParser.js — Smart Grid Sentinel Telemetry Parser
 * Source of truth: DESIGN.md v3.3, Section 7
 *
 * Validates and normalises raw JSON payloads from WebSocket or HTTP
 * into the canonical telemetry object consumed by all dashboard components.
 *
 * Handles three input variants transparently:
 *   1. Verbose v1.3  — nested object, keyed with full paths (default firmware)
 *   2. Short-key     — flat object with abbreviated keys ("sk":1 present)
 *   3. Canonical     — already flat with short display keys (mockData / tests)
 *
 * SEPARATION RULE: No document.* calls. No imports from /components or /pages.
 *
 * Public API:
 *   parse(raw)  → canonical telemetry object | null
 *
 * Returns null on ANY validation failure — never throws.
 */

// ── Short-key remapping table (DESIGN.md §7) ──────────────────────────────
// Left:  short key emitted by firmware (minified mode, "sk":1 present)
// Right: canonical nested path used in verbose v1.3 payloads
const KEY_MAP = {
  // sensors
  v_fil:  'sensors.voltage.filtered_value',
  v_raw:  'sensors.voltage.raw_value',
  v_conf: 'sensors.voltage.confidence',
  i_fil:  'sensors.current.filtered_value',
  i_raw:  'sensors.current.raw_value',
  i_conf: 'sensors.current.confidence',
  t_fil:  'sensors.temperature.filtered_value',
  t_conf: 'sensors.temperature.confidence',
  // power
  pw_r:   'power.real_power_w',
  pw_a:   'power.apparent_power_va',
  pw_e:   'power.energy_estimate_wh',
  // alerts
  fsm:    'alerts.fsm_state',
  flt:    'alerts.active_fault',
  trips:  'alerts.trip_count',
  ov:     'alerts.over_voltage',
  oc:     'alerts.over_current',
  ot:     'alerts.over_temperature',
  sc:     'alerts.short_circuit_risk',
  inr:    'alerts.inrush_event',
  // warnings
  w_ov:   'alerts.warnings.ov',
  w_uv:   'alerts.warnings.uv',
  w_oc:   'alerts.warnings.oc',
  w_th:   'alerts.warnings.thermal',
  w_cr:   'alerts.warnings.curr_rising',
  // prediction
  fp:     'prediction.fault_probability',
  rl:     'prediction.risk_level',
  // loads
  r1:     'loads.relay1.state',
  r2:     'loads.relay2.state',
  // network
  wifi:   'network.wifi_connected',
  rssi:   'network.wifi_rssi',
  mqtt:   'network.mqtt_connected',
  tls:    'network.mqtt_tls_verified',
  ip:     'network.ip',
  // system
  up:     'system.uptime_s',
  heap:   'system.free_heap',
};

// ── Valid FSM state strings ────────────────────────────────────────────────
const VALID_FSM_STATES = new Set([
  'BOOT', 'NORMAL', 'WARNING', 'FAULT', 'RECOVERY', 'LOCKOUT',
]);

// ── Valid active fault codes ───────────────────────────────────────────────
const VALID_FAULT_CODES = new Set([
  'NONE', 'OVERVOLTAGE', 'OVERCURRENT', 'THERMAL',
  'UNDERVOLT', 'SHORT_CIRCUIT', 'SENSOR_FAIL',
]);

// ── Valid risk levels ──────────────────────────────────────────────────────
const VALID_RISK_LEVELS = new Set(['LOW', 'MODERATE', 'HIGH', 'CRITICAL']);

// ── Numeric clamp ranges (DESIGN.md §7 schema descriptions) ───────────────
const CLAMP = {
  v:    { min: 0,     max: 300  },   // voltage V
  i:    { min: 0,     max: 100  },   // current A
  t:    { min: -40,   max: 150  },   // temperature °C
  p:    { min: 0,     max: 50000 },  // real power W
  va:   { min: 0,     max: 50000 },  // apparent power VA
  e:    { min: 0,     max: 1e9  },   // energy Wh (session since boot)
  pf:   { min: 0,     max: 1    },   // power factor
  freq: { min: 45,    max: 65   },   // frequency Hz
  health:          { min: 0, max: 100 },
  fault_probability:{ min: 0, max: 100 },
  rssi:            { min: -120, max: 0 },
  trip_count:      { min: 0, max: 255 },
};

// ── Utility: clamp a number to a named range ───────────────────────────────
function clamp(key, value) {
  const range = CLAMP[key];
  if (!range || typeof value !== 'number' || !isFinite(value)) return value;
  return Math.max(range.min, Math.min(range.max, value));
}

// ── Utility: safe number extraction with default ───────────────────────────
function safeNum(v, fallback = 0) {
  const n = Number(v);
  return (isFinite(n) ? n : fallback);
}

// ── Utility: safe boolean coercion ────────────────────────────────────────
function safeBool(v, fallback = false) {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true') return true;
  if (v === 0 || v === '0' || v === 'false') return false;
  return fallback;
}

// ── Utility: safe deep-get from a nested object using dotted path ─────────
// e.g. deepGet(obj, 'sensors.voltage.filtered_value')
function deepGet(obj, path) {
  if (obj == null) return undefined;
  const parts = path.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

// ── Step 1: Remap minified short keys to canonical nested paths ───────────
/**
 * If the payload contains "sk":1, expand all short keys to their canonical
 * dotted paths and return a flat object keyed by canonical paths.
 * Otherwise return the original object unchanged.
 *
 * @param {object} raw
 * @returns {object} — same reference or expanded flat object
 */
function remapShortKeys(raw) {
  if (!raw.sk) return raw; // verbose or canonical mode — no remapping needed

  const expanded = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'sk') continue; // meta key, discard
    const canonical = KEY_MAP[k];
    if (canonical) {
      expanded[canonical] = v;
    }
    // Unknown short keys are dropped — forward-compatible.
  }
  return expanded;
}

// ── Step 2: Extract primary measurements ─────────────────────────────────
/**
 * Pull the six primary measurement fields from the normalised object.
 * Handles both verbose (nested object) and flat (dotted-key) representations.
 *
 * @param {object} d — object after remapShortKeys()
 * @returns {{ v, i, t, p, va, e, pf, freq }}
 */
function extractMeasurements(d) {
  // Verbose v1.3: values live in nested sub-objects (d.sensors.voltage.filtered_value)
  // After remapShortKeys, short keys become flat dotted strings ('sensors.voltage.filtered_value')
  // Canonical mode: values are already at d.v, d.i, d.t, etc.

  // Helper: try canonical key first, then verbose nested path.
  function pick(canonical, verbosePath) {
    const cv = d[canonical];
    if (cv !== undefined) return safeNum(cv);
    return safeNum(deepGet(d, verbosePath));
  }

  return {
    v:    clamp('v',    pick('v',    'sensors.voltage.filtered_value')),
    i:    clamp('i',    pick('i',    'sensors.current.filtered_value')),
    t:    clamp('t',    pick('t',    'sensors.temperature.filtered_value')),
    p:    clamp('p',    pick('p',    'power.real_power_w')),
    va:   clamp('va',   pick('va',   'power.apparent_power_va')),
    e:    clamp('e',    pick('e',    'power.energy_estimate_wh')),
    pf:   clamp('pf',   pick('pf',   'power.power_factor')),
    freq: clamp('freq', pick('freq', 'power.frequency_hz')),
  };
}

// ── Step 3: Extract protection status ─────────────────────────────────────
function extractProtection(d) {
  function boolPath(canonical, verbosePath) {
    const cv = d[canonical];
    if (cv !== undefined) return safeBool(cv);
    return safeBool(deepGet(d, verbosePath));
  }

  function numPath(canonical, verbosePath, fallback = 0) {
    const cv = d[canonical];
    if (cv !== undefined) return safeNum(cv, fallback);
    return safeNum(deepGet(d, verbosePath), fallback);
  }

  function strPath(canonical, verbosePath, fallback = '') {
    const cv = d[canonical];
    if (cv !== undefined) return String(cv);
    const vv = deepGet(d, verbosePath);
    return vv !== undefined ? String(vv) : fallback;
  }

  // FSM state — must be one of the 6 valid strings
  let state = strPath('state', 'alerts.fsm_state', 'BOOT').toUpperCase();
  if (!VALID_FSM_STATES.has(state)) state = 'BOOT';

  // Active fault code
  let activeFault = strPath('active_fault', 'alerts.active_fault', 'NONE').toUpperCase();
  if (!VALID_FAULT_CODES.has(activeFault)) activeFault = 'NONE';

  // Trip count (0–3, >3 forces LOCKOUT)
  const tripCount = clamp('trip_count',
    numPath('trip_count', 'alerts.trip_count', 0));

  // Relay state — use relay1 as canonical relay reference
  const relay = boolPath('relay', 'loads.relay1.state');

  // Health score
  const health = clamp('health',
    numPath('health', 'diagnostics.system_health.overall_health_score', 100));

  // Fault flags
  const faults = {
    active:        activeFault,
    trip_count:    tripCount,
    over_voltage:  boolPath('over_voltage',  'alerts.over_voltage'),
    over_current:  boolPath('over_current',  'alerts.over_current'),
    over_temp:     boolPath('over_temp',     'alerts.over_temperature'),
    short_circuit: boolPath('short_circuit', 'alerts.short_circuit_risk'),
    inrush:        boolPath('inrush',        'alerts.inrush_event'),
    warnings: {
      ov:          boolPath('warnings_ov',  'alerts.warnings.ov'),
      uv:          boolPath('warnings_uv',  'alerts.warnings.uv'),
      oc:          boolPath('warnings_oc',  'alerts.warnings.oc'),
      thermal:     boolPath('warnings_th',  'alerts.warnings.thermal'),
      curr_rising: boolPath('warnings_cr',  'alerts.warnings.curr_rising'),
    },
  };

  return { state, relay, health, faults };
}

// ── Step 4: Extract prediction ─────────────────────────────────────────────
function extractPrediction(d) {
  function numPath(canonical, verbosePath, fallback = 0) {
    const cv = d[canonical];
    if (cv !== undefined) return safeNum(cv, fallback);
    return safeNum(deepGet(d, verbosePath), fallback);
  }
  function strPath(canonical, verbosePath, fallback = '') {
    const cv = d[canonical];
    if (cv !== undefined) return String(cv);
    const vv = deepGet(d, verbosePath);
    return vv !== undefined ? String(vv) : fallback;
  }

  const fp = clamp('fault_probability',
    numPath('fault_probability', 'prediction.fault_probability', 0));

  let risk = strPath('risk_level', 'prediction.risk_level', 'LOW').toUpperCase();
  if (!VALID_RISK_LEVELS.has(risk)) risk = 'LOW';

  return { fault_probability: fp, risk_level: risk };
}

// ── Step 5: Extract network ────────────────────────────────────────────────
function extractNetwork(d) {
  function boolPath(canonical, verbosePath) {
    const cv = d[canonical];
    if (cv !== undefined) return safeBool(cv);
    return safeBool(deepGet(d, verbosePath));
  }
  function numPath(canonical, verbosePath, fallback = 0) {
    const cv = d[canonical];
    if (cv !== undefined) return safeNum(cv, fallback);
    return safeNum(deepGet(d, verbosePath), fallback);
  }
  function strPath(canonical, verbosePath, fallback = '') {
    const cv = d[canonical];
    if (cv !== undefined) return String(cv);
    const vv = deepGet(d, verbosePath);
    return vv !== undefined ? String(vv) : fallback;
  }

  return {
    wifi: {
      connected: boolPath('wifi_connected', 'network.wifi_connected'),
      rssi:      clamp('rssi', numPath('wifi_rssi', 'network.wifi_rssi', -99)),
      ip:        strPath('ip', 'network.ip', '0.0.0.0'),
    },
    mqtt: {
      connected:         boolPath('mqtt_connected', 'network.mqtt_connected'),
      tls:               boolPath('mqtt_tls', 'network.mqtt_tls_verified'),
      publish_total:     numPath('mqtt_publish_total',    'network.mqtt_publish_total', 0),
      publish_failed:    numPath('mqtt_publish_failed',   'network.mqtt_publish_failed', 0),
      connect_attempts:  numPath('mqtt_connect_attempts', 'network.mqtt_connect_attempts', 0),
      connect_successes: numPath('mqtt_connect_successes','network.mqtt_connect_successes', 0),
    },
  };
}

// ── Step 6: Extract system vitals ──────────────────────────────────────────
function extractSystem(d) {
  function numPath(canonical, verbosePath, fallback = 0) {
    const cv = d[canonical];
    if (cv !== undefined) return safeNum(cv, fallback);
    return safeNum(deepGet(d, verbosePath), fallback);
  }
  function strPath(canonical, verbosePath, fallback = '') {
    const cv = d[canonical];
    if (cv !== undefined) return String(cv);
    const vv = deepGet(d, verbosePath);
    return vv !== undefined ? String(vv) : fallback;
  }
  function boolPath(canonical, verbosePath) {
    const cv = d[canonical];
    if (cv !== undefined) return safeBool(cv);
    return safeBool(deepGet(d, verbosePath));
  }

  return {
    uptime_s:       numPath('uptime', 'system.uptime_s', 0),
    free_heap:      numPath('free_heap', 'system.free_heap', 0),
    cpu_load_pct:   numPath('cpu_load_pct', 'diagnostics.system_health.cpu_load_estimate_pct', 0),
    health_score:   clamp('health', numPath('health_score', 'diagnostics.system_health.overall_health_score', 100)),
    health_status:  strPath('health_status', 'diagnostics.system_health.health_status', 'HEALTHY'),
    uptime_quality: strPath('uptime_quality', 'diagnostics.system_health.uptime_quality', 'STABLE'),
    heap_healthy:   boolPath('heap_healthy', 'diagnostics.system_health.heap_healthy'),
  };
}

// ── Step 7: Extract diagnostics (sensor health scores) ────────────────────
function extractDiagnostics(d) {
  function numPath(canonical, verbosePath, fallback = 100) {
    const cv = d[canonical];
    if (cv !== undefined) return safeNum(cv, fallback);
    return safeNum(deepGet(d, verbosePath), fallback);
  }
  function strPath(canonical, verbosePath, fallback = '') {
    const cv = d[canonical];
    if (cv !== undefined) return String(cv);
    const vv = deepGet(d, verbosePath);
    return vv !== undefined ? String(vv) : fallback;
  }

  return {
    voltage_stability:   clamp('health', numPath('voltage_stability',  'diagnostics.sensor_health.voltage.stability_score', 100)),
    current_stability:   clamp('health', numPath('current_stability',  'diagnostics.sensor_health.current.stability_score', 100)),
    temp_stability:      clamp('health', numPath('temp_stability',     'diagnostics.sensor_health.temperature.stability_score', 100)),
    adc_health:          clamp('health', numPath('adc_health',         'diagnostics.adc_health.health_score', 100)),
    system_health:       clamp('health', numPath('system_health',      'diagnostics.system_health.overall_health_score', 100)),
    power_quality_label: strPath('power_quality_label', 'diagnostics.power_quality.power_quality_label', 'GOOD'),
  };
}

// ── Main public function ───────────────────────────────────────────────────

/**
 * Parse and validate a raw telemetry payload.
 *
 * Accepts any of three input formats (verbose v1.3, short-key minified,
 * or already-canonical) and always returns the same canonical flat shape.
 *
 * Canonical output shape:
 * {
 *   v, i, t, p, va, e, pf, freq,       — primary measurements
 *   state, relay, health, uptime,       — protection/status
 *   faults: { active, trip_count, ... warnings },
 *   prediction: { fault_probability, risk_level },
 *   wifi: { connected, rssi, ip },
 *   mqtt: { connected, tls, ... },
 *   sys:  { uptime_s, free_heap, ... },
 *   diagnostics: { voltage_stability, ... },
 *   schema_v, device, ts
 * }
 *
 * @param {unknown} raw — anything received from WebSocket or HTTP
 * @returns {object|null} canonical telemetry object, or null if invalid
 */
export function parse(raw) {
  // ── Guard: must be a non-null object ─────────────────────────────────
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  try {
    // ── Step 1: Handle short-key expansion ──────────────────────────────
    const d = remapShortKeys(raw);

    // ── Step 2–7: Extract all field groups ───────────────────────────────
    const measurements = extractMeasurements(d);
    const protection   = extractProtection(d);
    const prediction   = extractPrediction(d);
    const network      = extractNetwork(d);
    const sys          = extractSystem(d);
    const diagnostics  = extractDiagnostics(d);

    // ── Required-field guard: voltage must be a non-zero value ───────────
    // This is the simplest liveness check — a zero payload from a stale
    // response is rejected rather than displayed as "0 V".
    // (Skip guard when in BOOT state where v=0 is legitimate.)
    if (measurements.v === 0 && protection.state !== 'BOOT') {
      // Possible stale or empty response — still return it (display last
      // known value rule from DESIGN.md §16.17). Do not null-reject here
      // unless ALL primary fields are zero, which indicates a bad frame.
      const allZero = measurements.v === 0 && measurements.i === 0 && measurements.t === 0;
      if (allZero && protection.state !== 'BOOT') {
        return null;
      }
    }

    // ── Assemble canonical object ────────────────────────────────────────
    return {
      // Primary measurements
      v:    measurements.v,
      i:    measurements.i,
      t:    measurements.t,
      p:    measurements.p,
      va:   measurements.va,
      e:    measurements.e,
      pf:   measurements.pf,
      freq: measurements.freq,

      // Protection / FSM
      state:  protection.state,
      relay:  protection.relay,
      health: protection.health,
      uptime: sys.uptime_s,

      // Fault flags
      faults: protection.faults,

      // Prediction
      prediction,

      // Network
      wifi: network.wifi,
      mqtt: network.mqtt,

      // System vitals
      sys,

      // Sensor diagnostics
      diagnostics,

      // Metadata passthrough
      schema_v: String(d.schema_v || '1.3'),
      device:   String(d.device   || ''),
      ts:       typeof d.ts === 'number' ? d.ts : Date.now(),
    };

  } catch (_err) {
    // Never throw — return null for any unexpected error.
    // The caller (telemetryPoller) will log and discard the frame.
    return null;
  }
}
