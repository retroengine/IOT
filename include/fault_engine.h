#pragma once
// ============================================================
//  fault_engine.h — Production-hardened fault detection engine
// ============================================================
#include "types.h"
#include <stdint.h>

namespace FaultEngine {
    void      init();
    void      evaluate(float v, float raw_i, float t);

    FaultType getActiveFault();
    uint8_t   getWarnFlags();

    // Called by RelayControl when a relay closes — arms inrush blank window
    void      notifyRelayClosed();
    bool      isInrushBlankActive();

    // Clears latched fault state and resets debounce counters
    void      clearLatched();
}
