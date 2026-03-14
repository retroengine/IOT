// ============================================================
//  fsm.cpp — Self-Healing Protection FSM
//  REVISION: 3.0 — Indian Grid / IS 12360 Compliance
//
//  STATE DIAGRAM:
//
//  BOOT ──(1s warm-up)──► NORMAL
//
//  NORMAL ──(any warn)──► WARNING
//  NORMAL ──(any fault)──► FAULT or LOCKOUT
//
//  WARNING ──(faults clear)──► NORMAL
//  WARNING ──(fault escalates)──► FAULT or LOCKOUT
//
//  FAULT ──(lockout-class fault)──────────────────────► LOCKOUT
//  FAULT ──(auto-reclose timer expires, V stable)──► RECOVERY
//  FAULT ──(API reset, temp guard OK)──────────────► RECOVERY
//
//  RECOVERY ──(voltage stable 500ms, no fault)──► NORMAL
//  RECOVERY ──(fault re-asserts)──────────────► FAULT → (escalate)
//
//  LOCKOUT ──(API reset, temp guard OK, sensor OK)──► RECOVERY
//
//  AUTO-RECLOSE DEAD TIMES (escalating — Section 7):
//    Trip 1 → RECLOSE_DELAY_1_MS (5s)
//    Trip 2 → RECLOSE_DELAY_2_MS (15s)
//    Trip 3 → RECLOSE_DELAY_3_MS (30s) then LOCKOUT
//
//  LOCKOUT BYPASS (direct to LOCKOUT, no auto-reclose):
//    FAULT_BIT_THERMAL  → fire risk, physical inspection required
//    FAULT_BIT_SC       → possible wiring damage, inspect before re-energise
//    FAULT_BIT_SENSOR   → cannot protect without sensors
//    DS18B20 disconnect → thermal blind, cannot operate safely
//
//  RECOVERY VALIDATION:
//    Before relay re-closes, voltage must hold within
//    VOLT_RECOVERY_LO..HI (±5% of 230V = 218.5–241.5V)
//    for VOLT_RECOVERY_CONFIRM_N consecutive samples (500ms).
//    If voltage drifts out during confirmation, timer restarts.
//
//  EDGE CASES:
//    EC-04  DS18B20 +85°C boot sentinel: FSM waits DS18B20_BOOT_IGNORE_MS
//           before trusting temperature readings
//    EC-05  DS18B20 -127°C disconnect: triggers LOCKOUT from ANY state,
//           even NORMAL or RECOVERY
//    EC-12  Thermal fault: routes to LOCKOUT, skips auto-reclose
//    EC-13  SC fault: routes to LOCKOUT, skips auto-reclose
//    EC-14  Recovery voltage hysteresis: prevents reclose into unstable grid
// ============================================================
#include "fsm.h"
#include "config.h"
#include "fault_engine.h"
#include "ds18b20.h"
#include "nvs_log.h"
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

namespace {
    FSMContext ctx;
    SemaphoreHandle_t mtx = nullptr;

    // ── Recovery voltage confirmation state ───────────────────────────────
    // Tracks consecutive samples where voltage is in the stable recovery band
    int recovery_v_confirm_count = 0;

    // ── Escalating reclose delay lookup ───────────────────────────────────
    // Index = (trip_count - 1), clamped to array bounds
    static const uint32_t RECLOSE_DELAYS_MS[3] = {
        RECLOSE_DELAY_1_MS,   // trip 1: 5s
        RECLOSE_DELAY_2_MS,   // trip 2: 15s
        RECLOSE_DELAY_3_MS    // trip 3: 30s (then LOCKOUT on next trip)
    };

    uint32_t reclosDelay() {
        int idx = ctx.trip_count - 1;
        if (idx < 0) idx = 0;
        if (idx > 2) idx = 2;
        return RECLOSE_DELAYS_MS[idx];
    }

    // ── Safe context copy under mutex ─────────────────────────────────────
    FSMContext snapshot() {
        FSMContext c = {};
        if (xSemaphoreTake(mtx, pdMS_TO_TICKS(5)) == pdTRUE) {
            c = ctx;
            xSemaphoreGive(mtx);
        }
        return c;
    }

    // ── State transition ──────────────────────────────────────────────────
    void transition(FSMState to, FaultType ft = FAULT_NONE) {
        FSMState from  = ctx.state;
        ctx.state      = to;
        ctx.fault_type = ft;

        Serial.printf("[FSM] %s → %s  fault=%s  trips=%d\n",
            fsmStateName(from), fsmStateName(to),
            faultTypeName(ft), ctx.trip_count);

        // Log every transition to NVS ring buffer
        NVSLog::append({ millis(), to, ft, 0.0f, fsmStateName(to) });

        // Reset recovery confirmation counter on any transition
        recovery_v_confirm_count = 0;
    }

    // ── Check if current voltage is in recovery-safe band ─────────────────
    // Returns true when voltage has been in the ±5% band long enough
    bool voltageStableForRecovery(float v) {
        bool in_band = (v >= VOLT_RECOVERY_LO_V && v <= VOLT_RECOVERY_HI_V);
        if (in_band) {
            if (++recovery_v_confirm_count >= VOLT_RECOVERY_CONFIRM_N) {
                return true;  // stable enough to re-close
            }
        } else {
            // Voltage drifted out — restart confirmation window
            if (recovery_v_confirm_count > 0) {
                Serial.printf("[FSM] Recovery V confirmation reset: "
                              "V=%.1fV out of band [%.1f–%.1f]\n",
                              v, VOLT_RECOVERY_LO_V, VOLT_RECOVERY_HI_V);
            }
            recovery_v_confirm_count = 0;
        }
        return false;
    }

} // namespace

namespace FSM {

    void init() {
        mtx = xSemaphoreCreateMutex();
        ctx = { FSM_BOOT, FAULT_NONE, WARN_NONE, 0, 0, 0, false };
        recovery_v_confirm_count = 0;
        Serial.println("[FSM] v3.0 init — IS 12360 / IEC 60255 escalating reclose");
    }

    // ── Main tick — called every SENSOR_LOOP_MS from Core-0 task ──────────
    //
    //  Parameters:
    //    temp_c   : current temperature (from DS18B20::getTemp())
    //    voltage_v: current voltage (from ADCSampler::getVoltage())
    //               used for recovery band confirmation
    void tick(float temp_c, float voltage_v) {

        if (xSemaphoreTake(mtx, pdMS_TO_TICKS(10)) != pdTRUE) return;

        uint32_t now        = millis();
        FaultType  ft       = FaultEngine::getActiveFault();
        uint8_t    warns    = FaultEngine::getWarnFlags();
        uint16_t   fbits    = FaultEngine::getActiveFaultBits();
        bool       any_fault = FaultEngine::hasFault();
        bool       any_warn  = (warns != WARN_NONE);

        ctx.warn_flags = warns;

        // EC-05 DS18B20 disconnect LOCKOUT — REMOVED.
        // Sensor fail no longer causes any FSM state change.

        // ══════════════════════════════════════════════════════════════════
        //  STATE MACHINE
        // ══════════════════════════════════════════════════════════════════
        switch (ctx.state) {

            // ── BOOT ─────────────────────────────────────────────────────
            // Waits for sensors to stabilise. DS18B20 boot ignore window
            // (EC-04) is enforced in ds18b20.cpp — we simply wait until
            // DS18B20::isReady() returns true before trusting temperature.
            // Minimum 1s always enforced (ADC IIR convergence).
            case FSM_BOOT: {
                bool adc_ready  = (now >= 1000);
                bool temp_ready = DS18B20::isReady() ||
                                  (now >= DS18B20_BOOT_IGNORE_MS + 500);
                if (adc_ready && temp_ready) {
                    Serial.printf("[FSM] BOOT complete — T=%.1f°C  V=%.1fV\n",
                                  temp_c, voltage_v);
                    transition(FSM_NORMAL);
                }
                break;
            }

            // ── NORMAL ───────────────────────────────────────────────────
            case FSM_NORMAL: {
                if (any_fault) {
                    ctx.trip_count++;
                    ctx.fault_ts_ms = now;

                    // Lockout-class faults (thermal, SC, sensor) bypass reclose
                    if (FaultEngine::isLockoutClass() ||
                        ctx.trip_count > MAX_TRIP_COUNT) {
                        Serial.printf("[FSM] NORMAL → LOCKOUT (fault=%s, trips=%d, "
                                      "lockout_class=%s)\n",
                                      faultTypeName(ft), ctx.trip_count,
                                      FaultEngine::isLockoutClass() ? "YES" : "NO");
                        transition(FSM_LOCKOUT, ft);
                    } else {
                        transition(FSM_FAULT, ft);
                    }
                } else if (any_warn) {
                    transition(FSM_WARNING);
                }
                break;
            }

            // ── WARNING ──────────────────────────────────────────────────
            case FSM_WARNING: {
                if (any_fault) {
                    ctx.trip_count++;
                    ctx.fault_ts_ms = now;

                    if (FaultEngine::isLockoutClass() ||
                        ctx.trip_count > MAX_TRIP_COUNT) {
                        transition(FSM_LOCKOUT, ft);
                    } else {
                        transition(FSM_FAULT, ft);
                    }
                } else if (!any_warn) {
                    transition(FSM_NORMAL);
                    FaultEngine::clearLatched();
                }
                break;
            }

            // ── FAULT ────────────────────────────────────────────────────
            // Two paths out:
            //   A) Manual reset via API (immediate, if temp guard OK)
            //   B) Auto-reclose after escalating dead time
            //
            // Before entering RECOVERY, voltage must be in stable band.
            // The dead-time wait is the minimum — voltage confirmation
            // may extend the wait if grid is still disturbed.
            case FSM_FAULT: {

                // Check if fault escalated to lockout class AFTER entering FAULT
                // (e.g. temperature rose above TEMP_FAULT_C while in FAULT state)
                if (FaultEngine::isLockoutClass()) {
                    Serial.println("[FSM] FAULT → LOCKOUT: lockout-class fault escalated");
                    transition(FSM_LOCKOUT, ft);
                    break;
                }

                // Path A: Manual reset via API
                if (ctx.reset_requested) {
                    ctx.reset_requested = false;
                    if (temp_c >= TEMP_RESET_BLOCK_C) {
                        Serial.printf("[FSM] RESET BLOCKED: T=%.1f°C ≥ %.0f°C\n",
                                      temp_c, TEMP_RESET_BLOCK_C);
                    } else {
                        Serial.println("[FSM] Manual reset in FAULT state");
                        ctx.recovery_ts_ms = now;
                        recovery_v_confirm_count = 0;
                        transition(FSM_RECOVERY, ft);
                        FaultEngine::clearLatched();
                    }
                    break;
                }

                // Path B: Auto-reclose after escalating dead time
                uint32_t delay = reclosDelay();
                uint32_t elapsed = now - ctx.fault_ts_ms;

                if (elapsed >= delay) {
                    if (temp_c >= TEMP_RESET_BLOCK_C) {
                        // Temperature too high — delay reclose until cooled
                        Serial.printf("[FSM] Auto-reclose blocked: T=%.1f°C ≥ %.0f°C\n",
                                      temp_c, TEMP_RESET_BLOCK_C);
                    } else {
                        Serial.printf("[FSM] Auto-reclose after %lums (trip %d, "
                                      "delay=%lums)\n",
                                      elapsed, ctx.trip_count, delay);
                        ctx.recovery_ts_ms = now;
                        recovery_v_confirm_count = 0;
                        transition(FSM_RECOVERY, ft);
                        FaultEngine::clearLatched();
                    }
                } else {
                    // Log countdown every 5 seconds
                    static uint32_t last_fault_log_ms = 0;
                    if (now - last_fault_log_ms >= 5000) {
                        Serial.printf("[FSM] FAULT: reclose in %lums "
                                      "(trip %d/%d, delay=%lums)\n",
                                      delay - elapsed, ctx.trip_count,
                                      MAX_TRIP_COUNT, delay);
                        last_fault_log_ms = now;
                    }
                }
                break;
            }

            // ── RECOVERY ─────────────────────────────────────────────────
            // Relay has been re-closed (or will be closed by RelayControl).
            // Wait for:
            //   1. Minimum 500ms for sensors to settle after re-energisation
            //   2. Voltage to stabilise in ±5% band for VOLT_RECOVERY_CONFIRM_N
            //      consecutive samples (EC-14: recovery validation)
            //
            // If a fault re-asserts → re-trip (increment trip counter)
            // If trip counter exhausted → LOCKOUT
            case FSM_RECOVERY: {
                uint32_t settle_elapsed = now - ctx.recovery_ts_ms;

                if (settle_elapsed < 500) {
                    // Sensor settle time — do not evaluate faults yet
                    break;
                }

                if (any_fault) {
                    // Fault still present / re-tripped → increment counter
                    ctx.trip_count++;
                    ctx.fault_ts_ms = now;

                    Serial.printf("[FSM] RECOVERY re-trip: fault=%s  trip=%d/%d\n",
                                  faultTypeName(ft), ctx.trip_count, MAX_TRIP_COUNT);

                    if (FaultEngine::isLockoutClass() ||
                        ctx.trip_count > MAX_TRIP_COUNT) {
                        transition(FSM_LOCKOUT, ft);
                    } else {
                        transition(FSM_FAULT, ft);
                    }
                    break;
                }

                // No fault active — confirm voltage stability before declaring NORMAL
                // EC-14: prevents re-closing into still-disturbed grid
                if (voltageStableForRecovery(voltage_v)) {
                    Serial.printf("[FSM] RECOVERY complete: V=%.1fV stable "
                                  "for %d samples — returning to NORMAL\n",
                                  voltage_v, VOLT_RECOVERY_CONFIRM_N);
                    transition(FSM_NORMAL);
                    ctx.trip_count = 0;    // clean recovery resets trip counter
                    FaultEngine::clearLatched();
                } else {
                    // Still confirming — log progress every 2s
                    static uint32_t last_rec_log_ms = 0;
                    if (now - last_rec_log_ms >= 2000) {
                        Serial.printf("[FSM] RECOVERY: V=%.1fV confirm=%d/%d "
                                      "band=[%.1f–%.1f]\n",
                                      voltage_v, recovery_v_confirm_count,
                                      VOLT_RECOVERY_CONFIRM_N,
                                      VOLT_RECOVERY_LO_V, VOLT_RECOVERY_HI_V);
                        last_rec_log_ms = now;
                    }
                }
                break;
            }

            // ── LOCKOUT ───────────────────────────────────────────────────
            // Terminal state. Only exits via:
            //   1. Manual API reset
            //   2. Temperature below TEMP_RESET_BLOCK_C
            //
            // Physical inspection SHOULD be performed before resetting.
            case FSM_LOCKOUT: {
                if (!ctx.reset_requested) break;

                ctx.reset_requested = false;

                // Block reset if temperature is still high
                if (temp_c >= TEMP_RESET_BLOCK_C) {
                    Serial.printf("[FSM] LOCKOUT RESET BLOCKED: T=%.1f°C ≥ %.0f°C\n",
                                  temp_c, TEMP_RESET_BLOCK_C);
                    break;
                }

                // All guards passed — allow reset
                Serial.println("[FSM] LOCKOUT reset approved — entering RECOVERY");
                FaultEngine::clearAll();
                ctx.trip_count     = 0;
                ctx.recovery_ts_ms = now;
                recovery_v_confirm_count = 0;
                transition(FSM_RECOVERY);
                break;
            }

        } // switch

        xSemaphoreGive(mtx);
    }

    FSMContext getContext() {
        return snapshot();
    }

    void requestReset() {
        if (xSemaphoreTake(mtx, pdMS_TO_TICKS(10)) == pdTRUE) {
            ctx.reset_requested = true;
            xSemaphoreGive(mtx);
            Serial.println("[FSM] reset requested via API");
        }
    }
}