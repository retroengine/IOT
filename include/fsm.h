#pragma once
// ============================================================
//  fsm.h — Self-healing Protection Finite State Machine
// ============================================================
// fsmStateName() and faultTypeName() are defined in types.h,
// which is included transitively via every module header.
#include "types.h"

namespace FSM {
    void       init();
    void       tick(float temp_c);
    FSMContext getContext();
    void       requestReset();  // Called by API — sets reset_requested flag
}
