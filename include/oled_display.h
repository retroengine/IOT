#pragma once
// ============================================================
//  oled_display.h — SSD1306 128×64 two-page display
// ============================================================
#include "types.h"

namespace OLEDDisplay {
    void init();
    void update(const SensorReading& r, const FSMContext& ctx);
}
