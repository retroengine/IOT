// ============================================================
//  fsm.cpp — Self-healing Protection FSM
//
//  BOOT     → NORMAL     : after sensors stabilize
//  NORMAL   → WARNING    : any warn flag set
//  WARNING  → NORMAL     : all warn flags clear
//  WARNING  → FAULT      : any fault declared by FaultEngine
//  FAULT    → RECOVERY   : auto after RECOVERY_DELAY_MS
//            (or immediate on API reset if temp < 40°C)
//  RECOVERY → NORMAL     : all clear after re-energize
//  RECOVERY → FAULT      : fault still present → re-trip
//  FAULT (3rd trip) → LOCKOUT
//  LOCKOUT  → NORMAL     : manual reset only (API, temp guard)
//
//  Relay duties delegated to relay_control module.
//  FSM only sets its own context fields.
// ============================================================
#include "fsm.h"
#include "config.h"
#include "fault_engine.h"
#include "nvs_log.h"
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

namespace {
    FSMContext ctx;
    SemaphoreHandle_t mtx = nullptr;

    // Safe context copy under mutex
    FSMContext snapshot() {
        FSMContext c;
        if (xSemaphoreTake(mtx, pdMS_TO_TICKS(5)) == pdTRUE) {
            c = ctx;
            xSemaphoreGive(mtx);
        }
        return c;
    }

    void transition(FSMState to, FaultType ft = FAULT_NONE) {
        FSMState from = ctx.state;
        ctx.state      = to;
        ctx.fault_type = ft;

        Serial.printf("[FSM] %s → %s  fault=%s\n",
            fsmStateName(from), fsmStateName(to), faultTypeName(ft));

        // Log every state transition to NVS ring buffer
        float val = 0.0f;
        if (ft == FAULT_OVERVOLTAGE || ft == FAULT_UNDERVOLT) {
            // value stored by caller context — best-effort
        }
        NVSLog::append({ millis(), to, ft, val, fsmStateName(to) });
    }
}

namespace FSM {

    void init() {
        mtx = xSemaphoreCreateMutex();
        ctx = { FSM_BOOT, FAULT_NONE, WARN_NONE, 0, 0, 0, false };
        Serial.println("[FSM] init");
    }

    void tick(float temp_c) {
        if (xSemaphoreTake(mtx, pdMS_TO_TICKS(10)) != pdTRUE) return;

        uint32_t now      = millis();
        FaultType ft      = FaultEngine::getActiveFault();
        uint8_t  warns    = FaultEngine::getWarnFlags();
        bool     any_fault = (ft != FAULT_NONE);
        bool     any_warn  = (warns != WARN_NONE);

        ctx.warn_flags = warns;

        switch (ctx.state) {

            // ── BOOT → NORMAL after 1 s sensor warm-up ──────────────────────
            case FSM_BOOT:
                if (now >= 1000) {
                    transition(FSM_NORMAL);
                }
                break;

            // ── NORMAL ──────────────────────────────────────────────────────
            case FSM_NORMAL:
                if (any_fault) {
                    ctx.trip_count++;
                    ctx.fault_ts_ms = now;
                    if (ctx.trip_count >= MAX_TRIP_COUNT) {
                        transition(FSM_LOCKOUT, ft);
                    } else {
                        transition(FSM_FAULT, ft);
                    }
                } else if (any_warn) {
                    transition(FSM_WARNING);
                }
                break;

            // ── WARNING ─────────────────────────────────────────────────────
            case FSM_WARNING:
                if (any_fault) {
                    ctx.trip_count++;
                    ctx.fault_ts_ms = now;
                    if (ctx.trip_count >= MAX_TRIP_COUNT) {
                        transition(FSM_LOCKOUT, ft);
                    } else {
                        transition(FSM_FAULT, ft);
                    }
                } else if (!any_warn) {
                    transition(FSM_NORMAL);
                    FaultEngine::clearLatched();
                }
                break;

            // ── FAULT ────────────────────────────────────────────────────────
            case FSM_FAULT:
                // Manual reset via API (subject to thermal guard)
                if (ctx.reset_requested) {
                    ctx.reset_requested = false;
                    if (temp_c >= TEMP_RESET_BLOCK_C) {
                        Serial.printf("[FSM] RESET BLOCKED: temp %.1f°C ≥ %.0f°C\n",
                            temp_c, TEMP_RESET_BLOCK_C);
                    } else {
                        ctx.recovery_ts_ms = now;
                        transition(FSM_RECOVERY);
                        FaultEngine::clearLatched();
                    }
                }
                // Auto-recover after RECOVERY_DELAY_MS
                else if ((now - ctx.fault_ts_ms) >= RECOVERY_DELAY_MS) {
                    if (temp_c < TEMP_RESET_BLOCK_C) {
                        ctx.recovery_ts_ms = now;
                        transition(FSM_RECOVERY);
                        FaultEngine::clearLatched();
                    }
                }
                break;

            // ── RECOVERY ────────────────────────────────────────────────────
            case FSM_RECOVERY:
                // Give 500 ms after re-energize for sensors to settle, then check
                if ((now - ctx.recovery_ts_ms) >= 500) {
                    if (any_fault) {
                        // Fault still present — re-trip
                        ctx.trip_count++;
                        ctx.fault_ts_ms = now;
                        if (ctx.trip_count >= MAX_TRIP_COUNT) {
                            transition(FSM_LOCKOUT, ft);
                        } else {
                            transition(FSM_FAULT, ft);
                        }
                    } else {
                        // All clear — back to NORMAL
                        transition(FSM_NORMAL);
                        ctx.trip_count = 0;   // reset trip counter on clean recovery
                    }
                }
                break;

            // ── LOCKOUT ─────────────────────────────────────────────────────
            case FSM_LOCKOUT:
                if (ctx.reset_requested) {
                    ctx.reset_requested = false;
                    if (temp_c >= TEMP_RESET_BLOCK_C) {
                        Serial.printf("[FSM] LOCKOUT RESET BLOCKED: temp %.1f°C\n", temp_c);
                    } else {
                        FaultEngine::clearLatched();
                        ctx.trip_count     = 0;
                        ctx.recovery_ts_ms = now;
                        transition(FSM_RECOVERY);
                    }
                }
                break;
        }

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
