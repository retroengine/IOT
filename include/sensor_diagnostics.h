// ============================================================
//  sensor_diagnostics.h — Sensor Intelligence & Health Scoring
//
//  This module reads from ADCSampler and DS18B20 public APIs
//  and computes comprehensive health, stability, and quality
//  metrics for all sensing channels.
//
//  Design: stateless API — all state is internal to the module.
//  compute() is called once per telemetry build cycle.
//  No heap allocation. All state in static storage.
//
//  Scoring methodology:
//    All scores are 0–100 (uint8_t).
//    100 = ideal / fully healthy.
//    0   = completely degraded / sensor failure.
//    Deductions are additive penalties from a 100 base.
//    Bonuses exist but final score is clamped [0, 100].
// ============================================================
#pragma once
#include <Arduino.h>

// ─── Voltage Channel Health ────────────────────────────────────────────────
struct VoltageHealth {
    float   noise_floor_v;          // RMS noise in volts (ideal < 1.0V)
    float   drift_rate_v_per_s;     // V/s trend (|< 0.5| = stable)
    float   min_seen_v;             // all-time minimum since boot
    float   max_seen_v;             // all-time maximum since boot
    float   peak_to_peak_v;         // max - min in recent power quality window
    bool    saturated;              // ADC rail hit detected
    float   snr_db;                 // Signal/Noise ratio in dB
    float   variance;               // rolling window variance (V²)
    uint8_t stability_score;        // 0–100 composite score
    const char* stability_label;    // "EXCELLENT" / "GOOD" / "DEGRADED" / "FAULT"
};

// ─── Current Channel Health ────────────────────────────────────────────────
struct CurrentHealth {
    float   noise_floor_a;          // RMS noise in amps (ideal < 0.05A)
    float   drift_rate_a_per_s;     // A/s trend
    float   min_seen_a;             // all-time minimum since boot
    float   max_seen_a;             // all-time maximum since boot
    bool    saturated;              // ADC rail hit detected
    float   snr_db;                 // Signal/Noise ratio in dB
    float   variance;               // rolling window variance (A²)
    uint8_t stability_score;        // 0–100 composite score
    const char* stability_label;
};

// ─── Thermal Sensor Health ────────────────────────────────────────────────
struct ThermalHealth {
    uint8_t  read_success_rate;     // % of valid reads (no -127, no disconnect)
    uint16_t disconnect_count;      // total sensor disconnect events since boot
    uint32_t reading_age_ms;        // ms since last valid reading
    bool     sensor_present;        // DS18B20 responding
    float    temp_variance;         // temperature variance over recent window
    bool     temp_stable;           // variance below stability threshold
    uint8_t  stability_score;       // 0–100 composite score
    const char* stability_label;
};

// ─── ADC Hardware Health ─────────────────────────────────────────────────
struct ADCHealth {
    uint8_t  calibration_type;          // 0=none, 1=efuse_vref, 2=efuse_tp
    const char* calibration_label;      // "NONE" / "EFUSE_VREF" / "EFUSE_TP"
    float    linearity_error_pct;       // estimated % deviation from ideal linear
    float    actual_sample_rate_hz;     // measured sample rate
    float    expected_sample_rate_hz;   // from config (1000/SENSOR_LOOP_MS)
    float    sample_rate_deviation_pct; // how far actual is from expected
    uint32_t saturation_events;         // total ADC rail hits since boot
    bool     voltage_saturated;
    bool     current_saturated;
    uint8_t  health_score;              // 0–100
};

// ─── Power Quality Metrics ────────────────────────────────────────────────
// NOTE: This system uses DC-scaled representations of voltage/current.
// True AC power quality (FFT-based THD, ITIC curve) requires high-frequency
// AC waveform sampling. The metrics below are DC-proxy equivalents:
//   ripple_pct        ≈ DC ripple / average (proxy for AC distortion content)
//   flicker_index     = variance / mean² (coefficient of variation squared)
//   sag_depth_v       = how far below NOMINAL_VOLTAGE_V in the window
//   swell_height_v    = how far above NOMINAL_VOLTAGE_V in the window
struct PowerQuality {
    float   nominal_voltage_v;          // configured nominal (from config.h)
    float   mean_voltage_v;             // mean over quality window
    float   voltage_deviation_pct;      // |mean - nominal| / nominal * 100
    float   sag_depth_v;                // max drop below nominal in window (0 if none)
    float   swell_height_v;             // max rise above nominal in window (0 if none)
    float   ripple_pct;                 // (peak-to-peak / mean) * 100
    float   flicker_index;              // variance / mean² — dimensionless
    float   power_factor_estimated;     // 0.85 assumed (not measured)
    float   real_power_w;               // V * I * PF
    float   apparent_power_va;          // V * I
    uint8_t voltage_stability_score;    // 0–100
    const char* power_quality_label;    // "EXCELLENT" / "GOOD" / "FAIR" / "POOR"
};

// ─── Overall System Diagnostics ──────────────────────────────────────────
struct SystemDiagnostics {
    uint8_t  overall_health_score;      // weighted average of all sub-scores
    const char* health_status;          // "HEALTHY" / "DEGRADED" / "CRITICAL"
    uint32_t uptime_s;                  // seconds since boot
    const char* uptime_quality;         // "STABLE"(>1h) / "WARMING_UP"(<5m) / "SETTLING"
    uint32_t free_heap_bytes;
    bool     heap_healthy;              // > HEAP_WARN_BYTES
    float    cpu_load_estimate_pct;     // from actual vs expected sample rate deviation
};

// ─── Full Diagnostics Snapshot ───────────────────────────────────────────
struct DiagnosticsSnapshot {
    VoltageHealth    voltage;
    CurrentHealth    current;
    ThermalHealth    thermal;
    ADCHealth        adc;
    PowerQuality     power_quality;
    SystemDiagnostics system;
    uint32_t         computed_at_ms;
};

// ─── Public API ───────────────────────────────────────────────────────────
namespace SensorDiagnostics {

    // Called once per telemetry cycle (from telemetry_builder).
    // Reads current state from ADCSampler and DS18B20 public APIs.
    // Returns a fully populated snapshot. No heap allocation.
    DiagnosticsSnapshot compute(float voltage_v, float current_a, float temp_c);

    // Optional: get last computed snapshot without recomputing.
    const DiagnosticsSnapshot& lastSnapshot();
}
