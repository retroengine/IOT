#pragma once
// ============================================================
//  fsm.h — Self-healing Protection Finite State Machine
// ============================================================
// fsmStateName() and faultTypeName() are defined in types.h,
// which is included transitively via every module header.
#include "types.h"

namespace FSM {
    // Must be called in setup() BEFORE g_server.begin() and before any task launch.
    // Creates the FSM mutex so API handlers (registered before tasks start) cannot
    // call xSemaphoreTake(nullptr) during the 50–200ms window before FSM::init() runs.
    void       earlyInit();
    void       init();
    // temp_c   : DS18B20 reading — used for thermal guard and reset blocking
    // voltage_v: ADC voltage — used for recovery band confirmation (EC-14)
    // now_ms   : BUG-18 FIX — optional simulated time for HIL loop.
    //            When 0 (default), uses real millis(). When non-zero,
    //            uses the provided value to evaluate all time-dependent
    //            state transitions (lockout timers, reclose delays, etc).
    void       tick(float temp_c, float voltage_v, uint32_t now_ms = 0);
    FSMContext getContext();
    void       requestReset();  // Called by API — sets reset_requested flag
}