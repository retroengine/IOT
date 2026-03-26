#pragma once
// ============================================================
//  ws_server.h — ESP32 WebSocket Telemetry Push Server
//
//  Pushes full telemetry JSON to all connected browser clients
//  every WS_PUSH_INTERVAL_MS milliseconds.
//
//  Uses AsyncWebSocket (part of ESPAsyncWebServer — no new lib).
//  Runs on the same AsyncWebServer instance as the REST API.
//
//  Thread safety (Tier 1 fix — Finding #2):
//    init() now accepts a seqlock pointer used by WS_EVT_CONNECT
//    to read shared state safely from the lwIP async context.
//    See ws_server.cpp for full rationale.
//
//  Public API:
//    init(server, reading_ptr, ctx_ptr, seqlock_ptr) — register WS handler
//    tick(reading, ctx)                               — call from task_comms loop
// ============================================================
#include <ESPAsyncWebServer.h>
#include <atomic>
#include "types.h"

namespace WSServer {
    void init(AsyncWebServer*         server,
              SensorReading*          reading_ptr,
              FSMContext*             ctx_ptr,
              std::atomic<uint32_t>*  seqlock_ptr);

    void tick(const SensorReading& r, const FSMContext& ctx);
}
