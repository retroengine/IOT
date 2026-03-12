#pragma once
// ============================================================
//  ds18b20.h — Non-blocking DS18B20 temperature sensor
// ============================================================

namespace DS18B20 {
    void  init();
    void  tick();
    float getTemp();             // Last valid reading in °C (-127 if no sensor)
    bool  isReady();             // True once first valid reading is available

    // True when sensor wire is disconnected (reads -127°C)
    // FSM uses this to trigger immediate LOCKOUT (EC-05)
    bool  isDisconnected();

    // True for one tick after sensor transitions disconnected → connected
    // FSM logs the reconnection event then calls clearReconnectedFlag()
    bool  wasReconnected();

    // Clears the one-shot reconnection flag — call after handling the event
    void  clearReconnectedFlag();
}