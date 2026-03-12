// ============================================================
//  relay_control.cpp
//  Active-LOW relay modules (HIGH = OPEN = safe).
//  IMPORTANT: pin set HIGH *before* pinMode(OUTPUT) to
//  prevent glitch on pin direction change (bootloader guard fix).
// ============================================================
#include "relay_control.h"
#include "config.h"
#include "fault_engine.h"

namespace {
    bool r1_closed = false;
    bool r2_closed = false;

    // Active-LOW helpers
    inline void relayClose(uint8_t pin) { digitalWrite(pin, LOW);  }
    inline void relayOpen (uint8_t pin) { digitalWrite(pin, HIGH); }
}

namespace RelayControl {

    void init() {
        // Drive pins HIGH (safe/open) BEFORE setting as OUTPUT
        // This prevents the ~200 ms bootloader glitch (Fix 3 from documentation)
        digitalWrite(PIN_RELAY_LOAD1, HIGH);
        digitalWrite(PIN_RELAY_LOAD2, HIGH);
        pinMode(PIN_RELAY_LOAD1, OUTPUT);
        pinMode(PIN_RELAY_LOAD2, OUTPUT);
        r1_closed = false;
        r2_closed = false;
        Serial.println("[RELAY] init — both OPEN (safe)");
    }

    void update(FSMState state) {
        bool want_r1 = false; // Load1: close only in NORMAL, WARNING, RECOVERY
        bool want_r2 = false; // Load2: close only in NORMAL, RECOVERY

        switch (state) {
            case FSM_NORMAL:
                want_r1 = true;
                want_r2 = true;
                break;
            case FSM_WARNING:
                want_r1 = true;   // main load stays on during warning
                want_r2 = false;  // shed auxiliary load at first sign of trouble
                break;
            case FSM_RECOVERY:
                want_r1 = true;   // re-energize main load for recovery test
                want_r2 = true;
                break;
            case FSM_FAULT:
            case FSM_LOCKOUT:
            case FSM_BOOT:
            default:
                want_r1 = false;
                want_r2 = false;
                break;
        }

        // Only change if state differs (avoid unnecessary relay chatter)
        if (want_r1 != r1_closed) {
            want_r1 ? relayClose(PIN_RELAY_LOAD1) : relayOpen(PIN_RELAY_LOAD1);
            if (want_r1) {
                // Relay just closed — arm inrush blank window in FaultEngine
                FaultEngine::notifyRelayClosed();
            }
            r1_closed = want_r1;
            Serial.printf("[RELAY] Load1 → %s\n", want_r1 ? "CLOSED" : "OPEN");
        }
        if (want_r2 != r2_closed) {
            want_r2 ? relayClose(PIN_RELAY_LOAD2) : relayOpen(PIN_RELAY_LOAD2);
            r2_closed = want_r2;
            Serial.printf("[RELAY] Load2 → %s\n", want_r2 ? "CLOSED" : "OPEN");
        }
    }

    bool isLoad1Closed() { return r1_closed; }
    bool isLoad2Closed() { return r2_closed; }
}
