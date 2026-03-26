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
//  THREAD SAFETY (Tier 1 fix — Finding #3):
//    buildJSON() is called ONLY from task_comms (Core 1 RTOS task).
//    task_comms calls buildSnapshot() immediately after buildJSON()
//    to cache the result in a second static buffer protected by a
//    seqlock. All async paths (HTTP handlers, WS connect event)
//    call getSnapshot() instead of buildJSON() — they read the
//    cached string with no serialisation in the lwIP context.
//
//    buildJSON()     — called exclusively from task_comms
//    buildSnapshot() — called exclusively from task_comms after buildJSON()
//    getSnapshot()   — safe to call from any context (seqlock-protected read)
//
//  Used by:
//    - task_comms (main.cpp)  → buildJSON() + buildSnapshot()
//    - api_server.cpp         → getSnapshot() for /api/telemetry
//    - ws_server.cpp          → getSnapshot() for WS push + connect frame
// ============================================================
#include "types.h"
#include <stdint.h>

namespace TelemetryBuilder {

    // Maximum serialized JSON size. Keep < 3KB per spec.
    static constexpr size_t TELEMETRY_BUF_SIZE = 4096;

    // ── Main serialiser — call only from task_comms ───────────────────────────
    // Builds complete telemetry JSON into internal static buffer s_buf.
    // Returns pointer to s_buf (valid until next call). Returns nullptr on overflow.
    const char* buildJSON(const SensorReading& reading,
                          const FSMContext&    ctx);

    // ── Snapshot cache — call only from task_comms, immediately after buildJSON()
    // Copies the result of the last buildJSON() call into a second static buffer
    // (s_snapshot) under seqlock protection so async readers get a consistent copy.
    void buildSnapshot();

    // ── Async-safe snapshot reader — safe to call from any context ───────────
    // Returns a pointer to the last committed snapshot string.
    // Uses a seqlock retry loop (wait-free in practice) to guarantee
    // the returned string was not being written to at time of copy.
    // Copies into caller-supplied buf of at least TELEMETRY_BUF_SIZE bytes.
    // Returns false if the snapshot is not yet available.
    bool getSnapshot(char* buf, size_t buf_size);

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
