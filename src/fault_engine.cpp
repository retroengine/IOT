// ============================================================
//  fault_engine.cpp — Production Protection Engine
//  REVISION: 3.0 — Full Indian Grid / IS 12360 Compliance
//
//  ARCHITECTURE:
//
//  evaluate() is called every SENSOR_LOOP_MS (10ms) from the
//  Core-0 protection task. It processes voltage, current, and
//  temperature through a multi-stage pipeline:
//
//  Stage 1 — Signal pre-processing
//    - 3-sample median on current (EMI / commutation spike rejection)
//    - Asymmetric IIR: fast rise (α=0.50), slow fall (α=0.10)
//    - Slope buffer update (5-sample linear regression for trend)
//
//  Stage 2 — Sensor hardware validation (HIGHEST PRIORITY)
//    - ADC saturation detection (EC-06)
//    - ADC frozen/stuck detection (EC-07)
//    - Physics cross-channel sanity check (EC-08)
//    → Any failure: FAULT_BIT_SENSOR set → triggers LOCKOUT
//
//  Stage 3 — Instantaneous fault detection (NO debounce / blanking)
//    - Short circuit: I ≥ CURR_SC_INSTANT_A (EC-11)
//      Inside inrush blank: only trips if slope is RISING (adaptive)
//    - Severe overvoltage: V ≥ VOLT_OV_INSTANT_V (MOV protection)
//    → FAULT_BIT_SC or FAULT_BIT_OV_INSTANT set
//
//  Stage 4 — Debounced sustained fault detection
//    - Sustained OV: V ≥ VOLT_OV_FAULT_V for N consecutive samples
//    - IDMT overcurrent: accumulator ≥ 1.0 (IEC 60255 Standard Inverse)
//      Inside inrush blank: accumulator frozen at 0 (not incremented)
//    - Thermal: T ≥ TEMP_FAULT_C for N consecutive samples
//    - Sustained UV: V ≤ VOLT_UV_FAULT_V for N consecutive samples
//      Inside inrush blank: UV fault suppressed (EC-09 motor-induced sag)
//      UV_INSTANT (<150V) bypasses suppression always
//
//  Stage 5 — Warning detection
//    - OV warn, UV warn, OC warn, thermal warn, current-rising slope
//    - OC warn and UV warn suppressed during inrush blank window
//
//  Stage 6 — Hysteresis clear logic
//    - Active faults are NOT cleared just because threshold is no
//      longer exceeded. They clear only when the signal drops below
//      the corresponding hysteresis dropout threshold.
//    - This prevents relay chattering at threshold boundaries.
//
//  FAULT PRIORITY BITMASK (uint16_t):
//    Multiple faults can be simultaneously active.
//    getHighestPriorityFault() returns the FaultType of the
//    highest-priority active bit for FSM state machine display.
//    getActiveFaultBits() returns the full bitmask for logging.
//
//  EDGE CASES HANDLED:
//    EC-06  ADC saturation → FAULT_BIT_SENSOR → LOCKOUT
//    EC-07  Frozen ADC reading → FAULT_BIT_SENSOR → LOCKOUT
//    EC-08  Physics impossibility → FAULT_BIT_SENSOR → LOCKOUT
//    EC-09  Motor UV sag during inrush → suppressed
//    EC-10  OV >270V → zero-debounce FAULT_BIT_OV_INSTANT
//    EC-11  SC >27A → bypasses inrush blank (slope check)
//    EC-12  Thermal → FAULT_BIT_THERMAL (FSM routes to LOCKOUT)
//    EC-13  SC → FAULT_BIT_SC (FSM routes to LOCKOUT, no reclose)
//    EC-14  All threshold hysteresis bands (prevents chattering)
//    EC-15  IDMT accumulator decays slowly below pickup (thermal memory)
//    EC-01  Motor inrush: 3500ms blank window protects against nuisance
//    EC-02  SMPS inrush: SC slope detection catches genuine SC in <30ms
//    EC-03  Resistive cold inrush: covered by 3500ms blank window
// ============================================================
#include "fault_engine.h"
#include "config.h"
#include <cmath>
#include <cstring>
#include <Arduino.h>

namespace {

    // ── Debounce counters ──────────────────────────────────────────────────
    int cnt_ov          = 0;
    int cnt_uv          = 0;
    int cnt_oc_idmt_arm = 0;   // arms IDMT accumulator (consecutive above pickup)
    int cnt_temp_fault  = 0;
    int cnt_ov_w        = 0;
    int cnt_uv_w        = 0;
    int cnt_oc_w        = 0;
    int cnt_temp_w      = 0;

    // ── Multi-fault bitmask ────────────────────────────────────────────────
    uint16_t fault_bits = FAULT_BIT_NONE;  // active fault bitmask
    uint8_t  warn_bits  = WARN_NONE;       // active warning bitmask

    // ── Hysteresis state ───────────────────────────────────────────────────
    // Tracks whether each fault is currently "latched" and waiting for
    // the signal to clear its hysteresis dropout threshold before resetting.
    bool hyst_ov_active   = false;
    bool hyst_uv_active   = false;
    bool hyst_oc_active   = false;
    bool hyst_temp_active = false;

    // ── Inrush blanking ────────────────────────────────────────────────────
    uint32_t inrush_blank_until_ms      = 0;   // OC fault + UV fault suppressed
    uint32_t inrush_blank_warn_until_ms = 0;   // OC warn + UV warn suppressed

    // ── IDMT accumulator (IEC 60255 Standard Inverse) ─────────────────────
    float idmt_accumulator = 0.0f;

    // ── Asymmetric IIR state ───────────────────────────────────────────────
    float iir_i = 0.0f;

    // ── 3-sample median buffer ─────────────────────────────────────────────
    float med_buf[3] = {};
    int   med_idx    = 0;
    bool  med_full   = false;

    // ── Slope buffer (5 samples) ───────────────────────────────────────────
    static constexpr int SLOPE_N = 5;
    float slope_buf[SLOPE_N] = {};
    int   slope_idx  = 0;
    bool  slope_full = false;

    // ── Saturation tracking (EC-06) ────────────────────────────────────────
    // Saturation = ADC reading stuck at 0 or 4095.
    // We track how long the saturation condition persists.
    uint32_t v_sat_start_ms = 0;
    uint32_t i_sat_start_ms = 0;
    bool     v_was_sat      = false;
    bool     i_was_sat      = false;

    // ── Frozen sensor tracking (EC-07) ─────────────────────────────────────
    // Track last N RAW ADC integer values (not IIR-smoothed physical values).
    // Raw ADC always has ≥1 LSB quantisation noise on a live signal (variance
    // typically 2–15 LSB²). A genuinely stuck ADC returns a constant integer
    // → variance exactly 0. IIR-smoothed values are unsuitable here because
    // the slow-fall IIR (α=0.10) collapses variance to near-zero even on a
    // healthy sensor, causing 100% false-positive rate. Fixed: EC-07 rev1.
    static constexpr int FROZEN_N = 20;
    int frozen_v_buf[FROZEN_N] = {};
    int frozen_i_buf[FROZEN_N] = {};
    int   frozen_idx = 0;
    bool  frozen_full = false;

    // ── Last raw ADC values (passed from adc_sampler for sensor checks) ────
    int last_raw_v = 2048;
    int last_raw_i = 0;

    // ─────────────────────────────────────────────────────────────────────
    //  HELPERS
    // ─────────────────────────────────────────────────────────────────────

    float median3(float a, float b, float c) {
        if (a > b) { float t = a; a = b; b = t; }
        if (b > c) { float t = b; b = c; c = t; }
        if (a > b) { float t = a; a = b; b = t; }
        return b;
    }

    float asymIIR(float new_val, float prev, float alpha_rise, float alpha_fall) {
        float alpha = (new_val >= prev) ? alpha_rise : alpha_fall;
        return alpha * new_val + (1.0f - alpha) * prev;
    }

    float currentSlope() {
        if (!slope_full) return 0.0f;
        // Simple first-last difference across buffer window
        int tail = (slope_idx + 1) % SLOPE_N;
        return (slope_buf[slope_idx] - slope_buf[tail]) /
               static_cast<float>(SLOPE_N);
    }

    // Debounce: returns true when condition has been true for N consecutive ticks
    bool debounce(bool condition, int& counter, int threshold) {
        if (condition) {
            if (++counter >= threshold) { counter = threshold; return true; }
        } else {
            counter = 0;
        }
        return false;
    }

    // Buffer variance computation (for frozen sensor detection)
    float bufferVariance(const float* buf, int n) {
        if (n < 2) return 1.0f;  // insufficient data — assume non-frozen
        float sum = 0.0f, sq = 0.0f;
        for (int k = 0; k < n; k++) { sum += buf[k]; sq += buf[k] * buf[k]; }
        float mean = sum / n;
        float var  = (sq / n) - (mean * mean);
        return (var > 0.0f) ? var : 0.0f;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  STAGE 2: SENSOR HARDWARE VALIDATION
    // ─────────────────────────────────────────────────────────────────────

    // EC-06: ADC saturation (open wire / op-amp short to rail)
    // Input: raw ADC integer (0–4095)
    // Returns true if fault should be raised (saturation persists >50ms)
    bool checkSaturation(int raw_v_int, int raw_i_int) {
        uint32_t now = millis();

        // Voltage channel saturation
        bool v_sat = (raw_v_int <= 5 || raw_v_int >= 4090);
        if (v_sat) {
            if (!v_was_sat) { v_sat_start_ms = now; v_was_sat = true; }
            if ((now - v_sat_start_ms) >= SENSOR_SAT_WINDOW_MS) {
                Serial.printf("[FAULT] SENSOR: voltage ADC saturation %dms raw=%d\n",
                              now - v_sat_start_ms, raw_v_int);
                return true;
            }
        } else {
            v_was_sat = false;
            v_sat_start_ms = 0;
        }

        // Current channel saturation
        bool i_sat = (raw_i_int <= 5 || raw_i_int >= 4090);
        if (i_sat) {
            if (!i_was_sat) { i_sat_start_ms = now; i_was_sat = true; }
            if ((now - i_sat_start_ms) >= SENSOR_SAT_WINDOW_MS) {
                Serial.printf("[FAULT] SENSOR: current ADC saturation %dms raw=%d\n",
                              now - i_sat_start_ms, raw_i_int);
                return true;
            }
        } else {
            i_was_sat = false;
            i_sat_start_ms = 0;
        }

        return false;
    }

    // EC-07: Frozen/stuck sensor (ADC multiplexer hang)
    // Receives RAW ADC integers (0–4095), NOT IIR-smoothed physical values.
    // Threshold: 1.0 LSB² — live sensor variance is 2–15×, stuck ADC is 0.
    bool checkFrozen(int raw_v_int, int raw_i_int) {
        frozen_v_buf[frozen_idx] = raw_v_int;
        frozen_i_buf[frozen_idx] = raw_i_int;
        if (frozen_idx == FROZEN_N - 1) frozen_full = true;
        frozen_idx = (frozen_idx + 1) % FROZEN_N;

        if (!frozen_full) return false;

        auto intBufVariance = [](const int* buf, int n) -> float {
            float sum = 0.0f, sq = 0.0f;
            for (int k = 0; k < n; k++) {
                float v = static_cast<float>(buf[k]);
                sum += v; sq += v * v;
            }
            float mean = sum / n;
            float var  = (sq / n) - (mean * mean);
            return (var > 0.0f) ? var : 0.0f;
        };

        float var_v = intBufVariance(frozen_v_buf, FROZEN_N);
        float var_i = intBufVariance(frozen_i_buf, FROZEN_N);

        if (var_v < 1.0f && var_i < 1.0f) {
            Serial.printf("[FAULT] SENSOR: frozen ADC — raw_v_var=%.2f raw_i_var=%.2f\n",
                          var_v, var_i);
            return true;
        }
        return false;
    }

    // EC-08: Physics impossibility cross-check
    // Significant current flow while voltage reads near zero is impossible
    // on AC mains — indicates at least one sensor has catastrophically failed.
    bool checkPhysicsImpossibility(float v, float i) {
        if (i >= SENSOR_PHYSICS_I_MIN && v < SENSOR_PHYSICS_V_MAX) {
            Serial.printf("[FAULT] SENSOR: physics impossibility — "
                          "V=%.1fV I=%.2fA (impossible on AC mains)\n", v, i);
            return true;
        }
        return false;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  STAGE 3: IDMT ACCUMULATOR (IEC 60255 Standard Inverse)
    // ─────────────────────────────────────────────────────────────────────
    //
    //  Formula: t(I) = TMS × k / ((I/Is)^α - 1)
    //  Accumulator increments by SENSOR_LOOP_MS / t(I) each tick.
    //  Trips when accumulator >= 1.0.
    //
    //  Thermal memory (EC-15): accumulator decays at IDMT_ACCUMULATOR_DECAY
    //  per tick below pickup. This means a sustained overload that cleared
    //  before tripping still has a "memory" — next overload trips faster.
    //  This correctly models wire insulation thermal stress accumulation.
    //
    //  Reset: accumulator resets to 0 when relay opens (clearLatched()).
    //  This models thermal cooling when the load is removed.

    void tickIDMT(float i_filtered, bool blank_active) {
        if (blank_active) {
            // During inrush blank: freeze accumulator at 0
            // Do NOT accumulate inrush energy into thermal memory
            idmt_accumulator = 0.0f;
            return;
        }

        if (i_filtered <= IDMT_IS) {
            // Below pickup: thermal memory decay (EC-15)
            idmt_accumulator *= IDMT_ACCUMULATOR_DECAY;
            if (idmt_accumulator < 0.0f) idmt_accumulator = 0.0f;
            return;
        }

        // Above pickup: increment accumulator
        float ratio = i_filtered / IDMT_IS;
        // (ratio)^α using natural log: ratio^α = e^(α × ln(ratio))
        float denom = expf(IDMT_ALPHA * logf(ratio)) - 1.0f;

        if (denom <= 1e-6f) {
            // Ratio is too close to 1.0 — avoid division by near-zero
            // This happens when I is only fractionally above Is
            // Apply maximum trip time effectively
            idmt_accumulator += (float)SENSOR_LOOP_MS / (float)IDMT_MAX_TRIP_MS;
            return;
        }

        float t_trip_ms = IDMT_TMS * IDMT_K / denom * 1000.0f;

        // Clamp to physically meaningful range
        if (t_trip_ms < IDMT_MIN_TRIP_MS) t_trip_ms = IDMT_MIN_TRIP_MS;
        if (t_trip_ms > IDMT_MAX_TRIP_MS) t_trip_ms = IDMT_MAX_TRIP_MS;

        idmt_accumulator += (float)SENSOR_LOOP_MS / t_trip_ms;

        // Cap at 2.0 to prevent infinite wind-up during sustained faults
        if (idmt_accumulator > 2.0f) idmt_accumulator = 2.0f;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  HYSTERESIS HELPERS
    // ─────────────────────────────────────────────────────────────────────
    //
    //  Each fault has a PICKUP threshold (where it sets) and a DROPOUT
    //  threshold (where it clears). The fault remains active between
    //  pickup and dropout to prevent relay chattering at the boundary.
    //
    //  Example OV: sets at 253V, clears at 245V.
    //  If voltage hovers at 252V, fault stays active until 244V is reached.

    // OV: pickup ≥ VOLT_OV_FAULT_V, dropout < VOLT_OV_FAULT_HYST_V
    bool hysteresisOV(float v) {
        if (!hyst_ov_active && v >= VOLT_OV_FAULT_V)      hyst_ov_active = true;
        if ( hyst_ov_active && v <  VOLT_OV_FAULT_HYST_V) hyst_ov_active = false;
        return hyst_ov_active;
    }

    // UV: pickup ≤ VOLT_UV_FAULT_V, dropout > VOLT_UV_FAULT_HYST_V
    bool hysteresisUV(float v) {
        if (!hyst_uv_active && v <= VOLT_UV_FAULT_V)      hyst_uv_active = true;
        if ( hyst_uv_active && v >  VOLT_UV_FAULT_HYST_V) hyst_uv_active = false;
        return hyst_uv_active;
    }

    // OC: pickup ≥ CURR_OC_FAULT_A, dropout < CURR_OC_FAULT_HYST_A
    bool hysteresisOC(float i) {
        if (!hyst_oc_active && i >= CURR_OC_FAULT_A)       hyst_oc_active = true;
        if ( hyst_oc_active && i <  CURR_OC_FAULT_HYST_A)  hyst_oc_active = false;
        return hyst_oc_active;
    }

    // Thermal: pickup ≥ TEMP_FAULT_C, dropout < TEMP_FAULT_HYST_C
    bool hysteresisTemp(float t) {
        if (!hyst_temp_active && t >= TEMP_FAULT_C)        hyst_temp_active = true;
        if ( hyst_temp_active && t <  TEMP_FAULT_HYST_C)   hyst_temp_active = false;
        return hyst_temp_active;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  FAULT BIT HELPERS
    // ─────────────────────────────────────────────────────────────────────
    // Returns the highest-priority active fault as a FaultType enum.
    // Priority order matches Section 8 of reference document.
    FaultType highestPriorityFault() {
        // FAULT_BIT_SENSOR removed — sensor fail no longer reported
        if (fault_bits & FAULT_BIT_SC)         return FAULT_SHORT_CIRCUIT;
        if (fault_bits & FAULT_BIT_OV_INSTANT) return FAULT_OVERVOLTAGE;
        if (fault_bits & FAULT_BIT_THERMAL)    return FAULT_THERMAL;
        if (fault_bits & FAULT_BIT_OV)         return FAULT_OVERVOLTAGE;
        if (fault_bits & FAULT_BIT_OC_IDMT)    return FAULT_OVERCURRENT;
        if (fault_bits & FAULT_BIT_UV)         return FAULT_UNDERVOLT;
        return FAULT_NONE;
    }

} // namespace

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────
namespace FaultEngine {

    void init() {
        fault_bits       = FAULT_BIT_NONE;
        warn_bits        = WARN_NONE;
        idmt_accumulator = 0.0f;
        iir_i            = 0.0f;

        // Reset all counters
        cnt_ov = cnt_uv = cnt_oc_idmt_arm = cnt_temp_fault = 0;
        cnt_ov_w = cnt_uv_w = cnt_oc_w = cnt_temp_w = 0;

        // Reset hysteresis state
        hyst_ov_active = hyst_uv_active = hyst_oc_active = hyst_temp_active = false;

        // Reset buffers
        memset(slope_buf,   0, sizeof(slope_buf));
        memset(med_buf,     0, sizeof(med_buf));
        memset(frozen_v_buf, 0, sizeof(frozen_v_buf));
        memset(frozen_i_buf, 0, sizeof(frozen_i_buf));

        inrush_blank_until_ms      = 0;
        inrush_blank_warn_until_ms = 0;

        Serial.println("[FAULT_ENG] v3.0 init — IS 12360 / IEC 60255 IDMT ready");
    }

    // Called by RelayControl when relay CLOSES (load energised)
    // Arms the inrush blank window for Indian load startup profiles
    void notifyRelayClosed() {
        uint32_t now = millis();
        inrush_blank_until_ms      = now + INRUSH_BLANK_MS;
        inrush_blank_warn_until_ms = now + INRUSH_BLANK_WARN_MS;

        // Reset IDMT accumulator — cooling model: relay was open, load removed
        idmt_accumulator = 0.0f;
        cnt_oc_idmt_arm  = 0;
        cnt_oc_w         = 0;

        Serial.printf("[FAULT_ENG] relay closed — inrush blank armed: "
                      "fault suppressed %dms, warn suppressed %dms\n",
                      INRUSH_BLANK_MS, INRUSH_BLANK_WARN_MS);
        Serial.println("[FAULT_ENG] EC-01/02/03: motor/SMPS/resistive inrush protected");
        Serial.println("[FAULT_ENG] EC-11: SC_INSTANT (>27A) + slope check always active");
    }

    bool isInrushBlankActive() {
        return millis() < inrush_blank_until_ms;
    }

    float getIDMTAccumulator() { return idmt_accumulator; }

    // ─────────────────────────────────────────────────────────────────────
    //  MAIN EVALUATION — called every SENSOR_LOOP_MS (10ms)
    //
    //  Parameters:
    //    v        : filtered voltage in Volts (from ADCSampler)
    //    raw_i    : raw current reading in Amps (BEFORE asymmetric IIR)
    //    t        : temperature in °C (from DS18B20)
    //    raw_v_int: raw ADC integer for voltage channel (for saturation check)
    //    raw_i_int: raw ADC integer for current channel (for saturation check)
    // ─────────────────────────────────────────────────────────────────────
    void evaluate(float v, float raw_i, float t,
                  int raw_v_int, int raw_i_int) {

        uint32_t now = millis();

        // ── Stage 1: Signal pre-processing ───────────────────────────────

        // 3-sample median on raw current (reject single-sample EMI spikes)
        med_buf[med_idx % 3] = raw_i;
        med_idx++;
        bool med_ready = (med_idx >= 3);
        float i_med = med_ready
            ? median3(med_buf[0], med_buf[1], med_buf[2])
            : raw_i;

        // Asymmetric IIR: fast rise (α=0.50) catches real load steps quickly
        //                 slow fall (α=0.10) rejects brief 50–200ms transients
        float i = asymIIR(i_med, iir_i, 0.50f, 0.10f);
        iir_i = i;

        // Update slope buffer for rising current trend detection
        slope_buf[slope_idx] = i;
        if (slope_idx == SLOPE_N - 1) slope_full = true;
        slope_idx = (slope_idx + 1) % SLOPE_N;
        float slope = currentSlope();  // A per tick (positive = rising)

        // Store raw values for sensor checks
        last_raw_v = raw_v_int;
        last_raw_i = raw_i_int;

        // ── Stage 2: Sensor hardware validation — REMOVED ────────────────
        // EC-06 (saturation), EC-07 (frozen), EC-08 (physics impossibility)
        // have been removed. FAULT_BIT_SENSOR is never set.
        // Protection continues regardless of ADC signal quality.

        // Determine inrush blanking state
        bool oc_fault_blanked = (now < inrush_blank_until_ms);
        bool oc_warn_blanked  = (now < inrush_blank_warn_until_ms);
        // EC-09: UV also suppressed during inrush (motor-induced sag)
        bool uv_fault_blanked = oc_fault_blanked;
        bool uv_warn_blanked  = oc_warn_blanked;

        // Adaptive debounce: heavy load mode
        bool heavy_load   = (i >= LOAD_HEAVY_A);
        int  fault_thresh = heavy_load ? FAULT_DEBOUNCE_HEAVY : FAULT_DEBOUNCE_N;
        int  warn_thresh  = heavy_load ? WARN_DEBOUNCE_HEAVY  : WARN_DEBOUNCE_N;

        // ── Stage 3: Instantaneous faults (no debounce or blanking) ──────

        // P3: Severe overvoltage >270V (EC-10) — zero debounce
        // Protects MOV (MCOV 275V) and semiconductor SOA
        if (debounce(v >= VOLT_OV_INSTANT_V, cnt_ov, FAULT_DEBOUNCE_INSTANT)) {
            if (!(fault_bits & FAULT_BIT_OV_INSTANT)) {
                fault_bits |= FAULT_BIT_OV_INSTANT;
                Serial.printf("[FAULT] OV_INSTANT: V=%.1fV ≥ %.0fV — MOV protection\n",
                              v, VOLT_OV_INSTANT_V);
            }
        } else if (v < VOLT_OV_INSTANT_V - 5.0f) {
            // Clear with 5V hysteresis below instant threshold
            fault_bits &= ~FAULT_BIT_OV_INSTANT;
        }

        // UV_INSTANT <150V — near supply collapse, always trip (EC-09 exception)
        if (debounce(v <= VOLT_UV_INSTANT_V, cnt_uv, FAULT_DEBOUNCE_INSTANT)) {
            if (!(fault_bits & FAULT_BIT_UV)) {
                fault_bits |= FAULT_BIT_UV;
                Serial.printf("[FAULT] UV_INSTANT: V=%.1fV ≤ %.0fV — supply collapse\n",
                              v, VOLT_UV_INSTANT_V);
            }
        }

        // P2: Short circuit ANSI 50 (EC-11) — bypasses inrush blank
        // Condition A: outside inrush window AND I ≥ SC threshold
        // Condition B: inside inrush window BUT current is RISING (not decaying)
        //   → Rising current during inrush = real SC, not motor startup
        //   → Decaying current = normal inrush exponential — allow it
        bool sc_outside_blank = !oc_fault_blanked && (i >= CURR_SC_INSTANT_A);
        bool sc_inside_rising = oc_fault_blanked  &&
                                (i >= CURR_SC_INSTANT_A) &&
                                (slope >= INRUSH_SC_SLOPE_A_PER_TICK);

        if (debounce(sc_outside_blank || sc_inside_rising, cnt_oc_idmt_arm,
                     FAULT_DEBOUNCE_INSTANT)) {
            if (!(fault_bits & FAULT_BIT_SC)) {
                fault_bits |= FAULT_BIT_SC;
                Serial.printf("[FAULT] SC: I=%.1fA ≥ %.0fA  slope=%.3f  "
                              "blank=%s  → LOCKOUT\n",
                              i, CURR_SC_INSTANT_A, slope,
                              oc_fault_blanked ? "ACTIVE" : "CLEAR");
            }
        }

        // ── Stage 4: Debounced sustained fault detection ──────────────────

        // P5: Sustained overvoltage — IS 12360 +10%
        // Hysteresis: fault holds until V drops below VOLT_OV_FAULT_HYST_V (EC-14)
        bool ov_pickup   = debounce(v >= VOLT_OV_FAULT_V, cnt_ov, fault_thresh);
        bool ov_latched  = hysteresisOV(v);
        if (ov_pickup || ov_latched) {
            if (!(fault_bits & FAULT_BIT_OV)) {
                fault_bits |= FAULT_BIT_OV;
                Serial.printf("[FAULT] OV: V=%.1fV ≥ %.0fV (IS 12360 +10%%)\n",
                              v, VOLT_OV_FAULT_V);
            }
        } else {
            fault_bits &= ~FAULT_BIT_OV;
            cnt_ov = 0;
        }

        // P6: IDMT overcurrent ANSI 51
        // Accumulator ticks when I > IDMT_IS (= CURR_OC_FAULT_A)
        // Suppressed during inrush blank (EC-01/02/03)
        tickIDMT(i, oc_fault_blanked);

        bool oc_latched = hysteresisOC(i);
        if (idmt_accumulator >= 1.0f || oc_latched) {
            if (!(fault_bits & FAULT_BIT_OC_IDMT)) {
                fault_bits |= FAULT_BIT_OC_IDMT;
                Serial.printf("[FAULT] OC_IDMT: I=%.1fA  accum=%.3f  "
                              "IDMT tripped (IEC 60255)\n",
                              i, idmt_accumulator);
            }
        } else if (!oc_latched && idmt_accumulator < 0.05f) {
            // Only clear the OC fault bit when accumulator has substantially
            // decayed AND current is below hysteresis dropout
            fault_bits &= ~FAULT_BIT_OC_IDMT;
        }

        // P4: Thermal limit (EC-12)
        // Hysteresis: fault holds until temp drops below TEMP_FAULT_HYST_C
        bool temp_pickup  = debounce(t >= TEMP_FAULT_C, cnt_temp_fault, fault_thresh);
        bool temp_latched = hysteresisTemp(t);
        if (temp_pickup || temp_latched) {
            if (!(fault_bits & FAULT_BIT_THERMAL)) {
                fault_bits |= FAULT_BIT_THERMAL;
                Serial.printf("[FAULT] THERMAL: T=%.1f°C ≥ %.0f°C → LOCKOUT\n",
                              t, TEMP_FAULT_C);
            }
        } else {
            fault_bits &= ~FAULT_BIT_THERMAL;
            cnt_temp_fault = 0;
        }

        // P7: Sustained undervoltage — IS 12360 -10%
        // Suppressed during inrush blank (EC-09: motor-induced sag)
        // Hysteresis: fault holds until V rises above VOLT_UV_FAULT_HYST_V (EC-14)
        bool uv_condition = !uv_fault_blanked && (v <= VOLT_UV_FAULT_V);
        bool uv_pickup    = debounce(uv_condition, cnt_uv, fault_thresh);
        bool uv_latched   = hysteresisUV(v) && !uv_fault_blanked;

        if (uv_pickup || uv_latched) {
            if (!(fault_bits & FAULT_BIT_UV)) {
                fault_bits |= FAULT_BIT_UV;
                Serial.printf("[FAULT] UV: V=%.1fV ≤ %.0fV (IS 12360 -10%%)\n",
                              v, VOLT_UV_FAULT_V);
            }
        } else if (!uv_latched && v > VOLT_UV_FAULT_HYST_V) {
            fault_bits &= ~FAULT_BIT_UV;
            cnt_uv = 0;
        }

        // ── Stage 5: Warning detection ────────────────────────────────────

        uint8_t w = WARN_NONE;

        // OV warning (CEA +6%)
        bool ov_warn_cond = (v >= VOLT_OV_WARN_V && v < VOLT_OV_FAULT_V);
        if (debounce(ov_warn_cond, cnt_ov_w, warn_thresh))
            w |= WARN_OV;
        else if (v < VOLT_OV_WARN_HYST_V)
            cnt_ov_w = 0;

        // UV warning (CEA -6%) — suppressed during inrush (EC-09)
        bool uv_warn_cond = !uv_warn_blanked &&
                            (v <= VOLT_UV_WARN_V && v > VOLT_UV_FAULT_V);
        if (debounce(uv_warn_cond, cnt_uv_w, warn_thresh))
            w |= WARN_UV;
        else if (!uv_warn_blanked && v > VOLT_UV_WARN_HYST_V)
            cnt_uv_w = 0;

        // OC warning — suppressed during inrush blank
        bool oc_warn_cond = !oc_warn_blanked &&
                            (i >= CURR_OC_WARN_A && i < CURR_OC_FAULT_A);
        if (debounce(oc_warn_cond, cnt_oc_w, warn_thresh))
            w |= WARN_OC;
        else if (oc_warn_blanked || i < CURR_OC_WARN_HYST_A)
            cnt_oc_w = 0;

        // Thermal warning
        bool temp_warn_cond = (t >= TEMP_WARN_C && t < TEMP_FAULT_C);
        if (debounce(temp_warn_cond, cnt_temp_w, warn_thresh))
            w |= WARN_THERMAL;
        else if (t < TEMP_WARN_C - 5.0f)
            cnt_temp_w = 0;

        // Predictive: rising current trend (WARN_CURR_RISING)
        // Only active when:
        //   - Outside inrush blank (inrush always has initially rising current)
        //   - Current is above 0.5A (above noise floor)
        //   - Slope is positive (current increasing over last 5 samples)
        //   - Current is not already in fault zone
        if (!oc_fault_blanked &&
            slope >= 0.05f &&
            i > 0.5f &&
            i < CURR_OC_FAULT_A) {
            w |= WARN_CURR_RISING;
        }

        warn_bits = w;

        // ── Periodic diagnostics ──────────────────────────────────────────
        // Log IDMT accumulator progress when approaching trip
        static uint32_t last_idmt_log_ms = 0;
        if (idmt_accumulator > 0.5f && (now - last_idmt_log_ms) > 1000) {
            Serial.printf("[FAULT_ENG] IDMT accumulator: %.3f / 1.000  "
                          "I=%.1fA  trip=%s\n",
                          idmt_accumulator, i,
                          idmt_accumulator >= 1.0f ? "TRIPPED" : "PENDING");
            last_idmt_log_ms = now;
        }
    }

    // ── Public accessors ──────────────────────────────────────────────────

    // Returns the FaultType of the highest-priority active fault
    FaultType getActiveFault() { return highestPriorityFault(); }

    // Returns raw warning bitmask
    uint8_t   getWarnFlags()   { return warn_bits; }

    // Returns full multi-fault bitmask (for logging and dashboard)
    uint16_t  getActiveFaultBits() { return fault_bits; }

    // True if any fault bit is set
    bool      hasFault()  { return fault_bits != FAULT_BIT_NONE; }

    // True if a LOCKOUT-class fault is active (thermal, SC)
    // FSM uses this to route directly to LOCKOUT bypassing auto-reclose
    // FAULT_BIT_SENSOR removed — sensor fail no longer causes lockout
    bool      isLockoutClass() {
        return (fault_bits & FAULT_BIT_THERMAL) ||
               (fault_bits & FAULT_BIT_SC);
    }

    bool isInrushBlankActive_public() {
        return millis() < inrush_blank_until_ms;
    }

    // Called by FSM when relay opens (fault cleared, relay opened)
    // Resets IDMT accumulator (thermal cooling when load removed)
    void clearLatched() {
        fault_bits       &= ~(FAULT_BIT_OV | FAULT_BIT_UV |
                              FAULT_BIT_OC_IDMT | FAULT_BIT_SC |
                              FAULT_BIT_OV_INSTANT);
        // Sensor fault and thermal fault NOT cleared here —
        // they require physical inspection (done by FSM LOCKOUT reset path)
        idmt_accumulator  = 0.0f;
        cnt_ov = cnt_uv = cnt_oc_idmt_arm = 0;
        // Reset hysteresis state for cleared faults
        hyst_ov_active = hyst_uv_active = hyst_oc_active = false;
        Serial.println("[FAULT_ENG] latched faults cleared — IDMT accumulator reset");
    }

    // Full clear including sensor and thermal — called only from LOCKOUT reset
    void clearAll() {
        fault_bits       = FAULT_BIT_NONE;
        warn_bits        = WARN_NONE;
        idmt_accumulator = 0.0f;
        cnt_ov = cnt_uv = cnt_oc_idmt_arm = cnt_temp_fault = 0;
        cnt_ov_w = cnt_uv_w = cnt_oc_w = cnt_temp_w = 0;
        hyst_ov_active = hyst_uv_active =
        hyst_oc_active = hyst_temp_active = false;
        Serial.println("[FAULT_ENG] ALL faults cleared (LOCKOUT reset path)");
    }

} // namespace FaultEngine