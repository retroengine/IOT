#pragma once
// ============================================================
//  relay_control.h — Active-LOW relay driver
// ============================================================
#include "types.h"

namespace RelayControl {
    void init();
    void update(FSMState state);
    bool isLoad1Closed();
    bool isLoad2Closed();
}
