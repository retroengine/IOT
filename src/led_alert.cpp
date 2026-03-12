// ============================================================
//  led_alert.cpp — Non-blocking LED blink
// ============================================================
#include "led_alert.h"
#include "config.h"

namespace {
    uint32_t next_ms = 0;
    bool     led_on  = false;

    void set(bool on) {
        digitalWrite(PIN_ALERT_LED, on ? HIGH : LOW);
        led_on = on;
    }

    void blink(uint32_t on_ms, uint32_t off_ms) {
        uint32_t now = millis();
        if (now >= next_ms) {
            if (!led_on) { set(true);  next_ms = now + on_ms;  }
            else         { set(false); next_ms = now + off_ms; }
        }
    }
}

namespace LedAlert {

    void init() {
        pinMode(PIN_ALERT_LED, OUTPUT);
        set(false);
        Serial.println("[LED] init");
    }

    void tick(FSMState state) {
        switch (state) {
            case FSM_NORMAL:
            case FSM_BOOT:
            case FSM_RECOVERY:
                set(false);
                break;
            case FSM_WARNING:
                blink(500, 500);   // 1 Hz
                break;
            case FSM_FAULT:
                blink(125, 125);   // 4 Hz
                break;
            case FSM_LOCKOUT:
                set(true);         // solid
                break;
        }
    }
}
