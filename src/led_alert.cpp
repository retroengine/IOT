// ============================================================
//  led_alert.cpp — Non-blocking LED blink + load indicators
//  UPDATED: Added Load1 / Load2 green+yellow status LEDs
// ============================================================
#include "led_alert.h"
#include "relay_control.h"
#include "config.h"
#include "serial_log.h"

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

    void setLoadLeds(uint8_t pin_green, uint8_t pin_yellow, bool closed) {
        digitalWrite(pin_green,  closed ? HIGH : LOW);
        digitalWrite(pin_yellow, closed ? LOW  : HIGH);
    }
}

namespace LedAlert {

    void init() {
        digitalWrite(PIN_ALERT_LED, LOW);
        pinMode(PIN_ALERT_LED, OUTPUT);

        digitalWrite(PIN_LED_LOAD1_GREEN,  LOW);
        digitalWrite(PIN_LED_LOAD1_YELLOW, HIGH);
        digitalWrite(PIN_LED_LOAD2_GREEN,  LOW);
        digitalWrite(PIN_LED_LOAD2_YELLOW, HIGH);

        pinMode(PIN_LED_LOAD1_GREEN,  OUTPUT);
        pinMode(PIN_LED_LOAD1_YELLOW, OUTPUT);
        pinMode(PIN_LED_LOAD2_GREEN,  OUTPUT);
        pinMode(PIN_LED_LOAD2_YELLOW, OUTPUT);

        LOG_LED("init -- alert + 4-LED load indicators ready");
    }

    void tick(FSMState state) {
        switch (state) {
            case FSM_NORMAL:
            case FSM_BOOT:
            case FSM_RECOVERY:
                set(false);
                break;
            case FSM_WARNING:
                blink(500, 500);
                break;
            case FSM_FAULT:
                blink(125, 125);
                break;
            case FSM_LOCKOUT:
                set(true);
                break;
        }

        setLoadLeds(PIN_LED_LOAD1_GREEN, PIN_LED_LOAD1_YELLOW, RelayControl::isLoad1Closed());
        setLoadLeds(PIN_LED_LOAD2_GREEN, PIN_LED_LOAD2_YELLOW, RelayControl::isLoad2Closed());
    }
}