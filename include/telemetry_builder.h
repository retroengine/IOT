#pragma once
// ============================================================
//  telemetry_builder.h — Centralized telemetry JSON assembler
//
//  Responsibilities:
//    - Collect sensor readings (ADCSampler, DS18B20)
//    - Collect fault engine status (FaultEngine)
//    - Collect FSM/actuator state
//    - Collect system diagnostics (heap, uptime, RSSI)
//    - Serialize to a static 2KB char buffer (zero heap alloc)
//
//  Used by:
//    - mqtt_client.cpp  → publish full telemetry payload
//    - api_server.cpp   → GET /api/telemetry endpoint
//
//  IMPORTANT: buildJSON() is NOT thread-safe. Both callers must
//  serialize access or accept that the buffer may be overwritten.
//  In practice: MQTT runs in task_comms, API runs in the async
//  server callback. The async callback is also on Core 1 and
//  runs between task_comms yields — no additional locking needed
//  as long as callers do not hold pointers to the buffer across
//  a vTaskDelay boundary.
// ============================================================
#include "types.h"
#include <stdint.h>

namespace TelemetryBuilder {

    // Maximum serialized JSON size. Keep < 3KB per spec.
    static constexpr size_t TELEMETRY_BUF_SIZE = 4096;

    // ── Main entry point ─────────────────────────────────────────────────────
    // Builds complete telemetry JSON into an internal static buffer.
    // Returns a pointer to that buffer (valid until next call).
    // Returns nullptr if serialization overflows the buffer.
    const char* buildJSON(const SensorReading& reading,
                          const FSMContext&    ctx);

    // ── Accessors for sub-components (used by specialized callers) ───────────
    PowerMetrics    computePower(float v, float i);
    FaultSnapshot   buildFaultSnapshot(const FSMContext& ctx);
    RiskLevel       computeRiskLevel(const FSMContext& ctx,
                                     const FaultSnapshot& fs);
    uint8_t         computeConfidence(bool calibrated, uint32_t sample_count,
                                      float value, float full_scale);

    // ── Buffer size check utility ────────────────────────────────────────────
    // Returns the byte length of the last built payload. Use in health task
    // to verify payload stays within MQTT buffer limits.
    size_t lastPayloadSize();
}
