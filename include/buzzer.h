#pragma once
// ============================================================
//  buzzer.h — Non-blocking LEDC buzzer driver
// ============================================================
#include "types.h"

namespace Buzzer {
    void init();
    void tick(FSMState state);
    void silence();
}
