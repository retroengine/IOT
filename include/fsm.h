#pragma once
// ============================================================
//  fsm.h — Self-healing Protection Finite State Machine
// ============================================================
// fsmStateName() and faultTypeName() are defined in types.h,
// which is included transitively via every module header.
#include "types.h"

namespace FSM {
    void       init();
    // temp_c   : DS18B20 reading — used for thermal guard and reset blocking
    // voltage_v: ADC voltage — used for recovery band confirmation (EC-14)
    void       tick(float temp_c, float voltage_v);
    FSMContext getContext();
    void       requestReset();  // Called by API — sets reset_requested flag
}