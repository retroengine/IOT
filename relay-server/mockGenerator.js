// ============================================================
//  mockGenerator.js — Synthetic Telemetry for Offline Mode
//
//  Generates realistic telemetry objects that match the firmware's
//  schema v1.3 structure exactly. Used by dataRouter when both
//  HTTP and MQTT sources are unavailable.
//
//  Output shape matches telemetry_builder.cpp buildJSON() output:
//    sensors.voltage.filtered_value
//    sensors.current.filtered_value
//    sensors.temperature.filtered_value
//    power.real_power_w, .apparent_power_va, .power_factor, .energy_estimate_wh
//    loads.relay1.state, loads.relay2.state
//    alerts.fsm_state, .active_fault, .trip_count, .over_voltage, ...
//    prediction.fault_probability, .risk_level
//    network.wifi_connected, .wifi_rssi, .mqtt_connected, .ip
//    system.uptime_s, .free_heap
//    diagnostics.system_health.overall_health_score
//    diagnostics.sensor_health.voltage.stability_score, etc.
//    schema_v: "1.3-local"
// ============================================================

let _tick       = 0;
let _startMs    = Date.now();
let _energyWh   = 0;
let _state      = 'NORMAL';
let _stateTick  = 0;
let _tripCount  = 0;

const NORMAL_TICKS   = 60;
const NONNORM_TICKS  = 16;

function _gaussian(mean, sd) {
  const u = 1 - Math.random();
  const v = 1 - Math.random();
  return mean + Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sd;
}

function _updateState() {
  const elapsed = _tick - _stateTick;
  if (_state === 'NORMAL') {
    if (elapsed >= NORMAL_TICKS) {
      const opts = ['WARNING', 'FAULT', 'RECOVERY'];
      _state     = opts[Math.floor(Math.random() * opts.length)];
      _stateTick = _tick;
      if (_state === 'FAULT') _tripCount = Math.min(_tripCount + 1, 3);
    }
  } else {
    if (elapsed >= NONNORM_TICKS) {
      _state     = 'NORMAL';
      _stateTick = _tick;
    }
  }
}

export function generate() {
  _tick++;
  _updateState();

  const t      = _tick;
  const isFlt  = _state === 'FAULT';
  const isWarn = _state === 'WARNING';

  // Voltage: 228–232V with sine drift
  let v = 230 + 2 * Math.sin((2 * Math.PI * t) / 120) + _gaussian(0, 0.15);
  if (isFlt)  v = 245 + _gaussian(0, 2);
  if (isWarn) v = 225 + _gaussian(0, 1);
  v = Math.max(0, Math.min(300, v));

  // Current: 10–15A
  let i = 12 + 1.5 * Math.sin((2 * Math.PI * t) / 80) + _gaussian(0, 0.08);
  if (isFlt) i = 20 + _gaussian(0, 1);
  i = Math.max(0, Math.min(30, i));

  // Temperature: 38–48°C
  let temp = 43 + 5 * Math.sin((2 * Math.PI * t) / 600) + _gaussian(0, 0.3);
  if (isFlt) temp = 55 + _gaussian(0, 1);
  temp = Math.max(-40, Math.min(125, temp));

  const pf  = Math.max(0.85, Math.min(1.0, 0.92 + _gaussian(0, 0.01)));
  const va  = v * i;
  const pw  = va * pf;
  _energyWh += pw / 3600000 * 2000; // 2s tick

  const uptimeS  = Math.floor((Date.now() - _startMs) / 1000);
  const faultProb = isFlt ? 95 : isWarn ? 45 : 5;
  const riskLevel = isFlt ? 'CRITICAL' : isWarn ? 'MODERATE' : 'LOW';
  const relay     = !isFlt && _state !== 'LOCKOUT';

  // Build the exact v1.3 firmware schema shape
  return {
    device:   'sgs-MOCK00',
    ts:       Date.now(),
    schema_v: '1.3-local',

    sensors: {
      voltage:     { pin: 34, raw_value: Math.round(v / 300 * 4095), filtered_value: +v.toFixed(2), confidence: 90, unit: 'V' },
      current:     { pin: 35, raw_value: Math.round(i / 30  * 4095), filtered_value: +i.toFixed(3), confidence: 88, unit: 'A' },
      temperature: { pin:  4, raw_value: Math.round(temp * 16),      filtered_value: +temp.toFixed(1), confidence: 95, unit: 'C' },
    },

    power: {
      real_power_w:       +pw.toFixed(1),
      apparent_power_va:  +va.toFixed(1),
      power_factor:       +pf.toFixed(2),
      energy_estimate_wh: +_energyWh.toFixed(3),
      pf_estimated:       true,
      frequency_hz:       50.0,
    },

    loads: {
      relay1: { pin: 26, state: relay },
      relay2: { pin: 27, state: relay },
    },

    alerts: {
      fsm_state:          _state,
      active_fault:       isFlt ? (i > 18 ? 'OVERCURRENT' : v > 235 ? 'OVERVOLTAGE' : 'THERMAL') : 'NONE',
      trip_count:         _tripCount,
      over_voltage:       isFlt && v > 235,
      under_voltage:      false,
      over_current:       isFlt && i > 18,
      over_temperature:   isFlt && temp > 50,
      short_circuit_risk: false,
      inrush_event:       false,
      warnings: {
        ov:          isWarn && v > 233,
        uv:          isWarn && v < 227,
        oc:          isWarn && i > 14,
        thermal:     isWarn && temp > 45,
        curr_rising: isWarn,
      },
    },

    prediction: {
      fault_probability: faultProb,
      risk_level:        riskLevel,
    },

    network: {
      wifi_rssi:      -55,
      wifi_connected: true,
      mqtt_connected: false,
      ip:             '192.168.1.100',
    },

    system: {
      uptime_s:     uptimeS,
      free_heap:    Math.max(50000, 180000 - _tick * 5),
      reset_reason: 1,
      cpu_freq_mhz: 240,
      wdt_timeout_s: 10,
    },

    diagnostics: {
      sensor_health: {
        voltage:     { stability_score: 91, stability_label: 'STABLE' },
        current:     { stability_score: 89, stability_label: 'STABLE' },
        temperature: { stability_score: 94, stability_label: 'STABLE', sensor_present: true, read_success_rate_pct: 100, disconnect_count: 0 },
      },
      adc_health: {
        health_score: 92, calibration_label: 'FACTORY',
      },
      power_quality: {
        power_quality_label: isFlt ? 'POOR' : isWarn ? 'FAIR' : 'GOOD',
        voltage_stability_score: isFlt ? 40 : 88,
      },
      system_health: {
        overall_health_score: isFlt ? 35 : isWarn ? 60 : 87,
        health_status:        isFlt ? 'CRITICAL' : isWarn ? 'DEGRADED' : 'HEALTHY',
        uptime_s:             uptimeS,
        uptime_quality:       uptimeS < 300 ? 'WARMING_UP' : 'STABLE',
        free_heap_bytes:      Math.max(50000, 180000 - _tick * 5),
        heap_healthy:         true,
        cpu_load_estimate_pct: +(12 + _gaussian(0, 2)).toFixed(1),
      },
    },
  };
}
