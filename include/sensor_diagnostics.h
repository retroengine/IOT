// ============================================================
//  sensor_diagnostics.h — Sensor Intelligence & Health Scoring
//
//  This module reads from ADCSampler and DS18B20 public APIs
//  and computes comprehensive health, stability, and quality
//  metrics for all sensing channels.
//
//  Tier 1 fix — Finding #4: SensorDiagnostics::compute() Mutates
//  Shared Static State From Multiple Concurrent Contexts
//
//  PROBLEM (original):
//    compute() advanced sliding windows (pq_v_buf, temp_hist,
//    thermal counters) on every call. It was called from both
//    task_comms (via buildJSON) and from the lwIP async HTTP
//    handler (/api/diagnostics). Concurrent calls double-counted
//    fault events, corrupted the 60-sample power quality window,
//    and produced torn reads of the DiagnosticsSnapshot struct.
//
//  FIX — Lock-Free Double-Buffer with Atomic Pointer Swap:
//    (Approach A per research document — definitively optimal)
//
//    update(v, i, t)  — EXCLUSIVE MUTATOR. Called only from
//                       task_comms, once per comms loop BEFORE
//                       buildJSON(). Advances all sliding windows,
//                       writes the new snapshot into the inactive
//                       buffer, then atomically swaps the active
//                       buffer index with memory_order_release.
//                       The writer never blocks.
//
//    lastSnapshot()   — PURE OBSERVER. Loads the active buffer
//                       index with memory_order_acquire (Xtensa
//                       MEMW barrier) and returns a copy of the
//                       active snapshot. Never mutates state.
//                       Safe to call from any context including
//                       the lwIP async callback.
//
//    compute(v, i, t) — BACKWARD-COMPATIBLE SHIM. Calls update()
//                       then returns lastSnapshot(). Kept so
//                       telemetry_builder.cpp compiles unchanged.
//                       Must only be called from task_comms.
//
//  MEMORY COST:
//    Two DiagnosticsSnapshot buffers ≈ 2 × ~260 bytes = ~520 bytes.
//    Negligible against ESP32's 320KB SRAM pool.
//
//  SCORING METHODOLOGY (unchanged):
//    All scores are 0–100 (uint8_t).
//    100 = ideal / fully healthy.
//    0   = completely degraded / sensor failure.
//    Deductions are additive penalties from a 100 base.
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
    uint8_t  calibration_type;          // 0=none, 1=line_fitting, 2=curve_fitting
    const char* calibration_label;      // "NONE" / "LINE_FITTING" / "CURVE_FITTING"
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
    VoltageHealth     voltage;
    CurrentHealth     current;
    ThermalHealth     thermal;
    ADCHealth         adc;
    PowerQuality      power_quality;
    SystemDiagnostics system;
    uint32_t          computed_at_ms;
};

// ─── Public API ───────────────────────────────────────────────────────────
namespace SensorDiagnostics {

    // ── MUTATOR — call ONLY from task_comms, once per comms loop ─────────
    // Advances all sliding windows (power quality buffer, thermal history,
    // thermal counters), builds a complete DiagnosticsSnapshot into the
    // inactive double-buffer, then atomically swaps it as the active buffer.
    // Uses memory_order_release on the swap — guarantees all payload writes
    // are globally visible (Xtensa MEMW barrier) before the index flips.
    //
    // configASSERT guards in debug builds prevent double-calling within
    // the minimum expected interval (800ms).
    void update(float voltage_v, float current_a, float temp_c);

    // ── OBSERVER — safe to call from any context including lwIP ──────────
    // Loads the active buffer index with memory_order_acquire (Xtensa MEMW
    // barrier) and returns a copy of the active snapshot. Completely
    // lock-free. Never mutates any state. No torn reads possible.
    DiagnosticsSnapshot lastSnapshot();

    // ── BACKWARD-COMPATIBLE SHIM — call only from task_comms ─────────────
    // Calls update(v, i, t) then returns lastSnapshot(). Kept so existing
    // callers (telemetry_builder.cpp) compile without modification.
    // Must only be called from task_comms — it calls update() internally.
    DiagnosticsSnapshot compute(float voltage_v, float current_a, float temp_c);
}
