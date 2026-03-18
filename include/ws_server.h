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
//  Public API:
//    init(server, reading_ptr, ctx_ptr)  — register WS handler
//    tick(reading, ctx)                  — call from task_comms loop
// ============================================================
#include <ESPAsyncWebServer.h>
#include "types.h"

namespace WSServer {
    void init(AsyncWebServer* server,
              SensorReading* reading_ptr,
              FSMContext*    ctx_ptr);

    void tick(const SensorReading& r, const FSMContext& ctx);
}
