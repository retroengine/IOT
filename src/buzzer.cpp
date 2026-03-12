// ============================================================
//  buzzer.cpp — Non-blocking LEDC buzzer
// ============================================================
#include "buzzer.h"
#include "config.h"

namespace {
    FSMState last_state = FSM_BOOT;
    uint32_t next_change_ms = 0;
    bool     tone_on = false;

    void setTone(uint32_t freq, uint8_t duty) {
        ledcSetup(BUZZER_LEDC_CHANNEL, freq, BUZZER_LEDC_RES_BITS);
        ledcAttachPin(PIN_BUZZER, BUZZER_LEDC_CHANNEL);
        ledcWrite(BUZZER_LEDC_CHANNEL, duty);
        tone_on = true;
    }

    void stopTone() {
        ledcWrite(BUZZER_LEDC_CHANNEL, 0);
        tone_on = false;
    }
}

namespace Buzzer {

    void init() {
        ledcSetup(BUZZER_LEDC_CHANNEL, BUZZER_FREQ_WARN, BUZZER_LEDC_RES_BITS);
        ledcAttachPin(PIN_BUZZER, BUZZER_LEDC_CHANNEL);
        ledcWrite(BUZZER_LEDC_CHANNEL, 0);
        Serial.println("[BUZZER] init");
    }

    void tick(FSMState state) {
        uint32_t now = millis();

        switch (state) {
            case FSM_NORMAL:
            case FSM_BOOT:
            case FSM_RECOVERY:
                stopTone();
                next_change_ms = 0;
                break;

            case FSM_WARNING:
                // 1 kHz, 50 ms ON / 450 ms OFF
                if (now >= next_change_ms) {
                    if (!tone_on) {
                        setTone(BUZZER_FREQ_WARN, BUZZER_DUTY_50);
                        next_change_ms = now + 50;
                    } else {
                        stopTone();
                        next_change_ms = now + 450;
                    }
                }
                break;

            case FSM_FAULT:
                // 2 kHz, 200 ms ON / 200 ms OFF
                if (now >= next_change_ms) {
                    if (!tone_on) {
                        setTone(BUZZER_FREQ_FAULT, BUZZER_DUTY_50);
                        next_change_ms = now + 200;
                    } else {
                        stopTone();
                        next_change_ms = now + 200;
                    }
                }
                break;

            case FSM_LOCKOUT:
                // 500 Hz continuous
                if (!tone_on || last_state != FSM_LOCKOUT) {
                    setTone(BUZZER_FREQ_LOCK, BUZZER_DUTY_50);
                }
                break;
        }

        last_state = state;
    }

    void silence() { stopTone(); }
}
