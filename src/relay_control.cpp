// ============================================================
//  relay_control.cpp
//  Active-LOW relay modules (LOW = CLOSED = load connected,
//                             HIGH = OPEN  = safe/disconnected).
//
//  GPIO HIGH = relay coil de-energized = contacts open = SAFE.
//  GPIO HIGH is NOT the ESP32 power-on default — GPIOs float low
//  until explicitly driven. For active-LOW relays this means a
//  brief closure glitch is possible between reset and firmware
//  driving the pin. CRITICAL FIX: pre-set HIGH before pinMode so
//  the output driver powers up into the safe (OPEN) state:
//    digitalWrite(pin, HIGH);  ← pre-set BEFORE OUTPUT mode
//    pinMode(pin, OUTPUT);
//
//  User convention: pin HIGH = "off" = disconnected = safe state.
//                   pin LOW  = "on"  = connected = normal state.
// ============================================================
#include "relay_control.h"
#include "config.h"
#include "fault_engine.h"

namespace {
    bool r1_closed = false;
    bool r2_closed = false;

    // ── API override (set by POST /api/relay from web handler) ────────────
    // volatile: written from Core-1 async handler, read from Core-0 task.
    // Single bool write is atomic on ESP32 (32-bit Xtensa).
    // Safety contract: FSM FAULT/LOCKOUT/BOOT always clears the override,
    // so protection trips cannot be masked by an operator relay command.
    volatile bool api_override_active = false;
    volatile bool api_override_state  = false;

    // Active-LOW helpers
    // LOW  = coil energized = relay contacts CLOSED = load connected
    // HIGH = coil de-energized = relay contacts OPEN  = load disconnected (safe)
    inline void relayClose(uint8_t pin) { digitalWrite(pin, LOW);  }
    inline void relayOpen (uint8_t pin) { digitalWrite(pin, HIGH); }
}

namespace RelayControl {

    void init() {
        // Active-LOW modules: HIGH = relay open = safe.
        // ESP32 GPIO power-on default is LOW (input), which would energize
        // an active-LOW relay immediately. Pre-set HIGH before switching to
        // OUTPUT mode so the coil is never energized during init.
        digitalWrite(PIN_RELAY_LOAD1, HIGH);  // pre-set OPEN before OUTPUT
        digitalWrite(PIN_RELAY_LOAD2, HIGH);
        pinMode(PIN_RELAY_LOAD1, OUTPUT);
        pinMode(PIN_RELAY_LOAD2, OUTPUT);
        r1_closed = false;
        r2_closed = false;
        Serial.println("[RELAY] init — both OPEN (HIGH/safe, active-LOW convention)");
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
                // SAFETY: clear any pending API override — a fault/lockout/boot
                // must NEVER be overridden by a dashboard operator command.
                api_override_active = false;
                break;
        }

        // Apply API override only when FSM permits the relay to be on/off
        // (i.e. we are in NORMAL or WARNING — the two states where
        //  the operator might legitimately need manual control).
        if (api_override_active &&
            (state == FSM_NORMAL || state == FSM_WARNING)) {
            want_r1 = api_override_state;
            want_r2 = api_override_state;
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

    // Called from POST /api/relay — sets a one-shot operator override.
    // The FSM protection task will clear this override on any FAULT/LOCKOUT/BOOT.
    void setAPIOverride(bool desired_state) {
        api_override_active = true;
        api_override_state  = desired_state;
        Serial.printf("[RELAY] API override set: %s\n",
                      desired_state ? "CLOSE" : "OPEN");
    }
}