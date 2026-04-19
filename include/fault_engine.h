#pragma once
// ============================================================
//  fault_engine.h — Production-hardened fault detection engine
// ============================================================
#include "types.h"
#include <stdint.h>

namespace FaultEngine {
    void      init();
    void      evaluate(float v, float raw_i, float t,
                       int raw_v_int, int raw_i_int, uint32_t spoofed_now_ms = 0);

    // Forces the internal Asymmetric IIR filter state memory to exactly match the 
    // target value. Critical for preventing math-transient ghost currents during 
    // Phantom Grid API injection testing.
    void      forceFilterState(float new_i);

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

    // Load State Machine (Motor Startup Support)
    LoadState getLoadState();

    // Delay on Break (DOB) Lockout
    // FSM and RelayControl use this to enforce the 3-minute compressor rule
    void      initiateLockout(uint32_t duration_ms);
    bool      isInLockoutDOB();

    // Called by RelayControl when a relay closes — arms startup state machine
    void      notifyRelayClosed();
    
    // Backwards compatibility for telemetry
    bool      isInrushBlankActive();
    bool      isVoltageRecoveryActive();

    // Clears non-latched (reclose-eligible) fault bits and resets IDMT
    // Called by FSM when relay opens after a recoverable fault
    void      clearLatched();

    // Full clear including sensor and thermal faults
    // Called only from the LOCKOUT manual-reset path
    void      clearAll();
}