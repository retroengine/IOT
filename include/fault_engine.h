#pragma once
// ============================================================
//  fault_engine.h — Production-hardened fault detection engine
// ============================================================
#include "types.h"
#include <stdint.h>

namespace FaultEngine {
    void      init();
    void      evaluate(float v, float raw_i, float t,
                       int raw_v_int, int raw_i_int);

    // Primary fault query — returns highest-priority active FaultType
    FaultType getActiveFault();

    // Returns raw warning bitmask (WarnFlags bits)
    uint8_t   getWarnFlags();

    // Returns full multi-fault bitmask (FAULT_BIT_* values from config.h)
    // Used by FSM and dashboard for detailed fault state
    uint16_t  getActiveFaultBits();

    // True if any fault bit is set
    bool      hasFault();

    // True if a LOCKOUT-class fault is active (thermal / SC / sensor)
    // FSM uses this to bypass auto-reclose and route directly to LOCKOUT
    bool      isLockoutClass();

    // Called by RelayControl when a relay closes — arms inrush blank window
    void      notifyRelayClosed();
    bool      isInrushBlankActive();

    // Clears non-latched (reclose-eligible) fault bits and resets IDMT
    // Called by FSM when relay opens after a recoverable fault
    void      clearLatched();

    // Full clear including sensor and thermal faults
    // Called only from the LOCKOUT manual-reset path
    void      clearAll();
}