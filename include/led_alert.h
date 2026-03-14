#pragma once
// ============================================================
//  led_alert.h — Non-blocking LED alert indicator
// ============================================================
#include "types.h"

namespace LedAlert {
    void init();
    void tick(FSMState state);
    void updateLoadLEDs(bool load1_closed, bool load2_closed);
}