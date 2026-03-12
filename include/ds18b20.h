#pragma once
// ============================================================
//  ds18b20.h — Non-blocking DS18B20 temperature sensor
// ============================================================

namespace DS18B20 {
    void  init();
    void  tick();
    float getTemp();    // Returns last valid reading in °C (-127 if no sensor)
    bool  isReady();    // True once first valid reading is available
}
