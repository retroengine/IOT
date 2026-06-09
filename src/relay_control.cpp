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
#include "serial_log.h"
#include "fault_engine.h"
#include <atomic>

namespace {
    bool r1_closed = false;
    bool r2_closed = false;

    // ── API override (set by POST /api/relay from web handler) ────────────
    // Two separate volatile bools are not atomically visible to
    // another core.  Core 1 writes api_override_active=true THEN writes
    // api_override_state — Core 0 can observe active=true with the old state
    // value between the two stores, commanding the relay in the wrong direction.
    //
    // Fix: encode both fields in a single std::atomic<uint32_t>:
    //   Bit 0 (0x1): override active flag
    //   Bit 1 (0x2): desired state (1 = close, 0 = open)
    //
    // A single atomic store/load is always coherent on Xtensa dual-core.
    // memory_order_release on write / memory_order_acquire on read ensures
    // the payload (desired state) is visible together with the active flag.
    std::atomic<uint32_t> api_override{0};
    //   Encoding helpers:
    //     inactive  : 0x0
    //     active+open : 0x1  (bit0=active, bit1=0=open)
    //     active+close: 0x3  (bit0=active, bit1=1=close)

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
        LOG_RELAY("init — both OPEN (HIGH/safe, active-LOW convention)");
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
                // Single atomic store with release ordering so Core 1
                // sees the cleared state immediately.
                api_override.store(0u, std::memory_order_release);
                break;
        }

        // Apply API override only when FSM permits the relay to be on/off
        // (i.e. we are in NORMAL or WARNING — the two states where
        //  the operator might legitimately need manual control).
        // Single acquire load — both active flag and desired state
        // are read atomically; no torn observation between the two writes
        // that the old two-bool scheme allowed.
        {
            uint32_t ovr = api_override.load(std::memory_order_acquire);
            if ((ovr & 0x1u) &&
                (state == FSM_NORMAL || state == FSM_WARNING)) {
                want_r1 = want_r2 = (bool)(ovr & 0x2u);
            }
        }

        // Only change if state differs (avoid unnecessary relay chatter)
        if (want_r1 != r1_closed) {
            want_r1 ? relayClose(PIN_RELAY_LOAD1) : relayOpen(PIN_RELAY_LOAD1);
            if (want_r1) {
                // Relay just closed — arm inrush blank window in FaultEngine
                FaultEngine::notifyRelayClosed();
            }
            r1_closed = want_r1;
            LOG_RELAY("Load1 → %s", want_r1 ? "CLOSED" : "OPEN");
        }
        if (want_r2 != r2_closed) {
            want_r2 ? relayClose(PIN_RELAY_LOAD2) : relayOpen(PIN_RELAY_LOAD2);
            r2_closed = want_r2;
            LOG_RELAY("Load2 → %s", want_r2 ? "CLOSED" : "OPEN");
        }
    }

    bool isLoad1Closed() { return r1_closed; }
    bool isLoad2Closed() { return r2_closed; }

    // Called from POST /api/relay — sets a one-shot operator override.
    // The FSM protection task will clear this override on any FAULT/LOCKOUT/BOOT.
    // Encodes both the active flag (bit 0) and desired state (bit 1) in
    // a single atomic store so Core 0 can never observe active=true with a
    // stale desired-state value between the two old separate writes.
    void setAPIOverride(bool desired_state) {
        if (desired_state && FaultEngine::isInLockoutDOB()) {
            LOG_RELAY("API override ignored: DOB active. Compressor equalize required.");
            return;
        }
        // Bit 0 = active, Bit 1 = desired state (close=1, open=0)
        uint32_t val = 0x1u | (desired_state ? 0x2u : 0x0u);
        api_override.store(val, std::memory_order_release);
        LOG_RELAY("API override set: %s",
                  desired_state ? "CLOSE" : "OPEN");
    }
}