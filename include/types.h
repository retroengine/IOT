#pragma once
// ============================================================
//  types.h — Shared data types for Smart Grid Sentinel
//  UPGRADED: Added TelemetrySnapshot, SensorMeta, PowerMetrics,
//            FaultSnapshot structs for structured telemetry.
// ============================================================
#include <Arduino.h>
#include <stdint.h>
#include <string.h>

// ─── FSM States ───────────────────────────────────────────────────────────────
enum FSMState : uint8_t {
    FSM_BOOT     = 0,
    FSM_NORMAL   = 1,
    FSM_WARNING  = 2,
    FSM_FAULT    = 3,
    FSM_RECOVERY = 4,
    FSM_LOCKOUT  = 5
};

// ─── Fault Types ──────────────────────────────────────────────────────────────
enum FaultType : uint8_t {
    FAULT_NONE        = 0,
    FAULT_OVERVOLTAGE = 1,
    FAULT_UNDERVOLT   = 2,
    FAULT_OVERCURRENT = 3,
    FAULT_THERMAL     = 4
};

// ─── Warning Flag Bitmasks ────────────────────────────────────────────────────
enum WarnFlags : uint8_t {
    WARN_NONE        = 0x00,
    WARN_OV          = 0x01,
    WARN_UV          = 0x02,
    WARN_OC          = 0x04,
    WARN_THERMAL     = 0x08,
    WARN_CURR_RISING = 0x10
};

// ─── Risk Levels ──────────────────────────────────────────────────────────────
enum RiskLevel : uint8_t {
    RISK_LOW      = 0,
    RISK_MODERATE = 1,
    RISK_HIGH     = 2,
    RISK_CRITICAL = 3
};

// ─── Name helpers ─────────────────────────────────────────────────────────────
inline const char* fsmStateName(FSMState s) {
    switch (s) {
        case FSM_BOOT:     return "BOOT";
        case FSM_NORMAL:   return "NORMAL";
        case FSM_WARNING:  return "WARNING";
        case FSM_FAULT:    return "FAULT";
        case FSM_RECOVERY: return "RECOVERY";
        case FSM_LOCKOUT:  return "LOCKOUT";
        default:           return "UNKNOWN";
    }
}

inline const char* faultTypeName(FaultType f) {
    switch (f) {
        case FAULT_NONE:        return "NONE";
        case FAULT_OVERVOLTAGE: return "OV";
        case FAULT_UNDERVOLT:   return "UV";
        case FAULT_OVERCURRENT: return "OC";
        case FAULT_THERMAL:     return "THERMAL";
        default:                return "UNKNOWN";
    }
}

inline const char* riskLevelName(RiskLevel r) {
    switch (r) {
        case RISK_LOW:      return "LOW";
        case RISK_MODERATE: return "MODERATE";
        case RISK_HIGH:     return "HIGH";
        case RISK_CRITICAL: return "CRITICAL";
        default:            return "UNKNOWN";
    }
}

// ─── FSM Context (shared between FSM, API, OLED, MQTT) ───────────────────────
struct FSMContext {
    FSMState  state;
    FaultType fault_type;
    uint8_t   warn_flags;
    int       trip_count;
    uint32_t  fault_ts_ms;
    uint32_t  recovery_ts_ms;
    bool      reset_requested;
};

// ─── Sensor Reading (packed by protection task, read by comms task) ───────────
struct SensorReading {
    float    voltage_v;
    float    current_a;
    float    temp_c;
    float    power_va;
    uint32_t ts_ms;
    bool     relay1_closed;
    bool     relay2_closed;
};

// ─── Per-sensor metadata for telemetry ───────────────────────────────────────
struct SensorMeta {
    int         pin;
    int         raw_value;
    float       filtered_value;
    uint8_t     confidence;
    const char* unit;
};

// ─── Derived power metrics ────────────────────────────────────────────────────
struct PowerMetrics {
    float real_power_w;
    float apparent_power_va;
    float power_factor;
    float energy_estimate_wh;
};

// ─── Fault snapshot for telemetry ─────────────────────────────────────────────
struct FaultSnapshot {
    bool    over_voltage;
    bool    over_current;
    bool    over_temperature;
    bool    short_circuit_risk;
    bool    inrush_event;
    uint8_t warn_flags;
};

// ─── Sampling diagnostics ─────────────────────────────────────────────────────
struct SamplingDiagnostics {
    uint32_t adc_sample_count;
    uint8_t  filter_window;
    uint32_t sensor_latency_us;
    bool     adc_calibrated;
};

// ─── NVS Event Log Entry ──────────────────────────────────────────────────────
struct EventEntry {
    uint32_t  ts_ms;
    FSMState  state;
    FaultType fault_type;
    float     value;
    char      note[16];

    EventEntry()
        : ts_ms(0), state(FSM_BOOT), fault_type(FAULT_NONE), value(0.0f) {
        note[0] = '\0';
    }

    EventEntry(uint32_t ts, FSMState s, FaultType f, float v, const char* n)
        : ts_ms(ts), state(s), fault_type(f), value(v) {
        strncpy(note, n ? n : "", sizeof(note) - 1);
        note[sizeof(note) - 1] = '\0';
    }
};