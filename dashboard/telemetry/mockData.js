/**
 * mockData.js — Smart Grid Sentinel Mock Telemetry Generator
 * Phase 2 deliverable — local development only.
 *
 * Provides realistic sensor data that mimics live ESP32 output:
 *   - Voltage: 228–232 V with sine-wave drift + noise
 *   - Current: 10–15 A with gradual load variation
 *   - Temperature: 38–48 °C with slow thermal drift
 *   - State machine: NORMAL for 30 s, then brief non-normal state, repeating
 *
 * SEPARATION RULE: No document.* calls. No imports from /components or /pages.
 *
 * Public API:
 *   generateMockTelemetry()             → canonical telemetry object
 *   startMockPoller(intervalMs, cb)     → stopFn — replaces real poller for local dev
 *   stopMockPoller()                    — stop the running mock poller
 */

// ── Module-level mock state ───────────────────────────────────────────────
// Persists across generateMockTelemetry() calls to produce realistic
// continuous drift rather than independent random samples.

let _mockStartTime   = Date.now();
let _mockTick        = 0;           // incremented on every call
let _currentState    = 'NORMAL';
let _stateStartTick  = 0;           // tick when current state began
let _faultProb       = 3;
let _tripCount       = 0;

// Base values (nominal operating point)
const V_NOMINAL   = 230.0;          // V
const I_BASE      = 12.0;           // A
const T_BASE      = 43.0;           // °C
let   _energyWh   = 0;             // accumulated since mock start
let   _pubCount   = 0;              // simulated MQTT publish count

// ── FSM state cycle ───────────────────────────────────────────────────────
// Cycle: 30 ticks NORMAL → 8 ticks non-normal → back to NORMAL (38-tick cycle)
// At the default 500ms interval this is 15s normal + 4s non-normal.
// At 100ms interval it's 3s normal + 0.8s non-normal.
const NORMAL_TICKS  = 60;   // ticks in NORMAL before transitioning
const NONNORM_TICKS = 16;   // ticks in non-normal state

const NON_NORMAL_STATES = ['WARNING', 'FAULT', 'RECOVERY'];

function _updateFsmState() {
  const elapsed = _mockTick - _stateStartTick;

  if (_currentState === 'NORMAL') {
    if (elapsed >= NORMAL_TICKS) {
      // Transition to a random non-normal state
      _currentState   = NON_NORMAL_STATES[Math.floor(Math.random() * NON_NORMAL_STATES.length)];
      _stateStartTick = _mockTick;
      if (_currentState === 'FAULT') {
        _tripCount = Math.min(_tripCount + 1, 3);
        _faultProb = 70 + Math.random() * 25;
      } else if (_currentState === 'WARNING') {
        _faultProb = 25 + Math.random() * 20;
      } else {
        _faultProb = Math.max(5, _faultProb - 10);
      }
    }
  } else {
    if (elapsed >= NONNORM_TICKS) {
      _currentState   = 'NORMAL';
      _stateStartTick = _mockTick;
      _faultProb      = Math.max(2, _faultProb - 30);
    }
  }
}

// ── Noise helper ──────────────────────────────────────────────────────────
/** Gaussian-ish noise via Box-Muller approximation (no external lib). */
function _gaussian(mean, stddev) {
  const u = 1 - Math.random();
  const v = 1 - Math.random();
  const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + n * stddev;
}

/** Linear interpolation helper. */
function _lerp(a, b, t) { return a + (b - a) * t; }

// ── generateMockTelemetry ─────────────────────────────────────────────────

/**
 * Generate one canonical telemetry object representing the current
 * mock system state.
 *
 * Values stay within realistic sensor ranges:
 *   Voltage:     228–232 V (sine drift + noise)
 *   Current:     10–15 A   (slow load variation + noise)
 *   Temperature: 38–48 °C  (slow thermal drift)
 *
 * @returns {object} canonical telemetry (matches telemetryParser output shape)
 */
export function generateMockTelemetry() {
  _mockTick++;
  _updateFsmState();

  const now = Date.now();
  const t   = _mockTick;

  // ── Voltage: 228–232V with 50Hz-ish sine wave representation ───────────
  // The sine oscillates around the nominal with a slow drift component.
  const vDrift   = 2.0 * Math.sin((2 * Math.PI * t) / 120);  // slow drift ±2V
  const vNoise   = _gaussian(0, 0.15);
  let   voltage  = V_NOMINAL + vDrift + vNoise;

  // Inject fault-state voltage excursions
  if (_currentState === 'FAULT') {
    voltage = _lerp(voltage, 245 + _gaussian(0, 2), 0.8); // overvoltage
  } else if (_currentState === 'WARNING') {
    voltage = _lerp(voltage, 225 + _gaussian(0, 1), 0.5); // undervoltage warning
  }
  voltage = Math.max(0, Math.min(300, voltage));

  // ── Current: 10–15A with slow load variation ────────────────────────────
  const iBase  = I_BASE + 1.5 * Math.sin((2 * Math.PI * t) / 80); // ±1.5A swing
  const iNoise = _gaussian(0, 0.08);
  let current  = iBase + iNoise;
  if (_currentState === 'FAULT') {
    current = _lerp(current, 20 + _gaussian(0, 1), 0.7); // overcurrent
  }
  current = Math.max(0, Math.min(100, current));

  // ── Temperature: 38–48°C slow thermal drift ─────────────────────────────
  const tempDrift = 5.0 * Math.sin((2 * Math.PI * t) / 600); // ±5°C slow cycle
  const tNoise    = _gaussian(0, 0.3);
  let temperature = T_BASE + tempDrift + tNoise;
  if (_currentState === 'FAULT') {
    temperature = _lerp(temperature, 55 + _gaussian(0, 1), 0.4); // overtemp
  }
  temperature = Math.max(-40, Math.min(150, temperature));

  // ── Power calculations ──────────────────────────────────────────────────
  const pf          = Math.max(0.85, Math.min(1.0, 0.92 + _gaussian(0, 0.01)));
  const realPower   = voltage * current * pf;
  const apparentPow = voltage * current;
  const freqHz      = 50.0 + _gaussian(0, 0.02); // 50Hz ± tiny jitter

  // Energy accumulates each tick (assume intervalMs matches)
  _energyWh += (realPower / 3600000) * 1000; // rough kWh→Wh
  _pubCount++;

  // ── Fault flags ─────────────────────────────────────────────────────────
  const isFault    = _currentState === 'FAULT';
  const isWarning  = _currentState === 'WARNING';
  const isRecovery = _currentState === 'RECOVERY';

  const activeFault = isFault
    ? (current > 15 ? 'OVERCURRENT' : voltage > 235 ? 'OVERVOLTAGE' : 'THERMAL')
    : 'NONE';

  const riskLevel   = isFault ? 'HIGH' : isWarning ? 'MODERATE' : 'LOW';
  const faultProb   = Math.max(0, Math.min(100, Math.round(_faultProb + _gaussian(0, 2))));

  // ── Uptime ───────────────────────────────────────────────────────────────
  const uptimeS = Math.floor((now - _mockStartTime) / 1000);

  // ── Health score (degrades in fault/warning) ─────────────────────────────
  let healthScore = 87;
  if (isFault)    healthScore = 30 + Math.floor(Math.random() * 20);
  if (isWarning)  healthScore = 55 + Math.floor(Math.random() * 15);
  if (isRecovery) healthScore = 65 + Math.floor(Math.random() * 10);

  const relay = !isFault && _currentState !== 'LOCKOUT';

  // ── Sensor health scores ─────────────────────────────────────────────────
  const vStability = isFault ? 40 + Math.floor(Math.random() * 20) : 90 + Math.floor(Math.random() * 10);
  const iStability = isFault ? 45 + Math.floor(Math.random() * 20) : 88 + Math.floor(Math.random() * 10);
  const tStability = 93 + Math.floor(Math.random() * 6);
  const adcHealth  = 91 + Math.floor(Math.random() * 8);

  // ── Assemble canonical telemetry object ──────────────────────────────────
  return {
    // Primary measurements
    v:    +voltage.toFixed(2),
    i:    +current.toFixed(3),
    t:    +temperature.toFixed(1),
    p:    +realPower.toFixed(2),
    va:   +apparentPow.toFixed(2),
    e:    +_energyWh.toFixed(4),
    pf:   +pf.toFixed(3),
    freq: +freqHz.toFixed(3),

    // Protection / FSM
    state:  _currentState,
    relay,
    health: healthScore,
    uptime: uptimeS,

    // Fault flags
    faults: {
      active:        activeFault,
      trip_count:    _tripCount,
      over_voltage:  isFault && voltage > 235,
      over_current:  isFault && current > 15,
      over_temp:     isFault && temperature > 50,
      short_circuit: false,
      inrush:        false,
      warnings: {
        ov:          isWarning && voltage > 233,
        uv:          isWarning && voltage < 227,
        oc:          isWarning && current > 14,
        thermal:     isWarning && temperature > 45,
        curr_rising: isWarning,
      },
    },

    // Prediction
    prediction: {
      fault_probability: faultProb,
      risk_level:        riskLevel,
    },

    // Network (simulated stable connection)
    wifi: {
      connected: true,
      rssi:      Math.round(-52 + _gaussian(0, 3)),
      ip:        '192.168.1.100',
    },
    mqtt: {
      connected:         true,
      tls:               true,
      publish_total:     _pubCount,
      publish_failed:    0,
      connect_attempts:  1,
      connect_successes: 1,
    },

    // System vitals
    sys: {
      uptime_s:       uptimeS,
      free_heap:      Math.max(50000, 180000 - _mockTick * 10 + Math.round(_gaussian(0, 500))),
      cpu_load_pct:   +(12 + _gaussian(0, 2)).toFixed(1),
      health_score:   healthScore,
      health_status:  isFault ? 'CRITICAL' : isWarning ? 'DEGRADED' : 'HEALTHY',
      uptime_quality: uptimeS < 300 ? 'WARMING_UP' : uptimeS < 3600 ? 'SETTLING' : 'STABLE',
      heap_healthy:   true,
    },

    // Sensor diagnostics
    diagnostics: {
      voltage_stability:   vStability,
      current_stability:   iStability,
      temp_stability:      tStability,
      adc_health:          adcHealth,
      system_health:       healthScore,
      power_quality_label: isFault ? 'POOR' : isWarning ? 'FAIR' : 'GOOD',
    },

    // Metadata
    schema_v: '1.3',
    device:   'sgs-MOCK00',
    ts:       now,
  };
}

// ── Mock poller ───────────────────────────────────────────────────────────
let _mockPollerTimer   = null;
let _mockPollerCallback = null;

/**
 * Start generating mock telemetry at a given interval.
 *
 * This replaces the real telemetryPoller for local development — call it
 * instead of telemetryPoller.connect() when the ESP32 is not available.
 *
 * The provided callback receives canonical telemetry objects identical
 * to what telemetryPoller's onMessage() would deliver.
 *
 * @param {number}   [intervalMs=500]  — generation interval in milliseconds
 * @param {function} [callback]        — receives (canonicalTelemetry) on each tick
 *                                       (can also be registered via onMockMessage)
 * @returns {function} stop function — call to halt the mock poller
 *
 * @example
 * // In main.js during development:
 * import { startMockPoller } from './telemetry/mockData.js';
 * startMockPoller(500, (data) => page.update(data));
 */
export function startMockPoller(intervalMs = 500, callback = null) {
  if (_mockPollerTimer) {
    stopMockPoller();
  }

  // Reset mock state for a clean session
  _mockStartTime  = Date.now();
  _mockTick       = 0;
  _currentState   = 'NORMAL';
  _stateStartTick = 0;
  _faultProb      = 3;
  _tripCount      = 0;
  _energyWh       = 0;
  _pubCount       = 0;

  if (callback) {
    _mockPollerCallback = callback;
  }

  // Fire one frame immediately before the interval kicks in
  _dispatchMockFrame();

  _mockPollerTimer = setInterval(_dispatchMockFrame, intervalMs);

  console.info(`[mockData] Mock poller started at ${intervalMs}ms interval`);

  // Return a stop function for convenience
  return stopMockPoller;
}

/**
 * Stop the running mock poller.
 */
export function stopMockPoller() {
  clearInterval(_mockPollerTimer);
  _mockPollerTimer    = null;
  _mockPollerCallback = null;
  console.info('[mockData] Mock poller stopped');
}

/**
 * Register a callback for mock frames after startMockPoller() has been called.
 * @param {function} callback
 */
export function onMockMessage(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('[mockData] onMockMessage() requires a function');
  }
  _mockPollerCallback = callback;
}

function _dispatchMockFrame() {
  const data = generateMockTelemetry();
  if (_mockPollerCallback) {
    try {
      _mockPollerCallback(data);
    } catch (err) {
      console.error('[mockData] callback error:', err);
    }
  }
}
