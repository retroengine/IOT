// ============================================================
//  ws_server.cpp — ESP32 WebSocket Telemetry Push Server
//
//  Mounts at: ws://<esp32_ip>/ws/telemetry
//  (Same path the relay server connects to)
//
//  Push rate: WS_PUSH_INTERVAL_MS (defined in config.h)
//  Payload:   Full telemetry JSON from TelemetryBuilder::getSnapshot()
//             — identical to /api/telemetry response.
//
//  Client handling:
//    - On connect: immediately sends one frame (no wait for interval)
//    - On ping frame: ESPAsyncWebServer handles pong automatically
//    - On disconnect: client removed from the internal client list
//    - On text message (e.g. relay-server ping): ignored gracefully
//
//  Thread safety (Tier 1 fix — Findings #2 and #3):
//    WS_EVT_CONNECT fires from the lwIP/AsyncTCP task context on Core-1.
//    It must never block, take a mutex, or call buildJSON() (static buffer race).
//
//    Fix #2: WS_EVT_CONNECT reads g_reading/g_ctx via a seqlock retry loop
//    (Option C from research doc). Zero blocking time. No torn reads.
//
//    Fix #3: tick() now calls TelemetryBuilder::getSnapshot() instead of
//    buildJSON() directly. The snapshot was built once by task_comms and
//    cached under seqlock protection — no concurrent serialisation possible.
//
//    tick() is called from task_comms (Core-1 RTOS task) — not an async
//    callback — so it can safely call buildJSON() internally if needed.
//    We still prefer getSnapshot() to avoid double-serialisation.
// ============================================================
#include "ws_server.h"
#include "telemetry_builder.h"
#include "config.h"
#include <Arduino.h>
#include <atomic>
#include <cstring>

namespace {
    AsyncWebSocket*  g_ws      = nullptr;
    SensorReading*   g_reading = nullptr;
    FSMContext*      g_ctx     = nullptr;
    uint32_t         g_last_push_ms = 0;

    // Seqlock pointer — set during init(), used in WS_EVT_CONNECT (Finding #2)
    std::atomic<uint32_t>* g_seqlock = nullptr;

    // Per-client send buffer — reused across WS_EVT_CONNECT calls.
    // Lives in the module namespace (not on the lwIP stack) to avoid
    // stack overflow risk in the async callback context.
    static char s_connect_buf[TelemetryBuilder::TELEMETRY_BUF_SIZE];

    // ── WebSocket event handler ───────────────────────────────────────────
    void onWsEvent(AsyncWebSocket*       server,
                   AsyncWebSocketClient* client,
                   AwsEventType          type,
                   void*                 arg,
                   uint8_t*              data,
                   size_t                len)
    {
        switch (type) {

            case WS_EVT_CONNECT:
                Serial.printf("[WS] client #%u connected from %s\n",
                              client->id(),
                              client->remoteIP().toString().c_str());
                // Send one frame immediately — client should not wait.
                //
                // Finding #2 fix: we are in the lwIP async callback context.
                // We must NOT call buildJSON() (static buffer race — Finding #3)
                // and must NOT take g_state_mutex (pdMS_TO_TICKS(5) = 0 at 100Hz
                // tick rate due to integer truncation — the research document
                // confirms this is a non-blocking poll, not a 5ms wait).
                //
                // Correct approach: read the pre-built snapshot from
                // TelemetryBuilder::getSnapshot() which uses a seqlock retry loop.
                // The snapshot was committed by task_comms in the previous cycle.
                // No blocking. No torn reads. No static buffer race.
                if (TelemetryBuilder::getSnapshot(s_connect_buf,
                                                   sizeof(s_connect_buf))) {
                    client->text(s_connect_buf);
                }
                break;

            case WS_EVT_DISCONNECT:
                Serial.printf("[WS] client #%u disconnected\n", client->id());
                break;

            case WS_EVT_ERROR:
                Serial.printf("[WS] client #%u error %u: %s\n",
                              client->id(),
                              *((uint16_t*)arg),
                              (char*)data);
                break;

            case WS_EVT_DATA: {
                // Only handle ping messages from relay server
                // All other messages are silently ignored
                AwsFrameInfo* info = (AwsFrameInfo*)arg;
                if (info->opcode == WS_TEXT && len >= 4) {
                    // {"type":"ping"} → send pong
                    // ESPAsyncWebServer handles binary PING frames automatically
                    if (strncmp((char*)data, "{\"type\":\"ping\"}", len) == 0 ||
                        strncmp((char*)data, "{\"type\": \"ping\"}", len) == 0) {
                        char pong[48];
                        snprintf(pong, sizeof(pong),
                                 "{\"type\":\"pong\",\"ts\":%lu}", millis());
                        client->text(pong);
                    }
                }
                break;
            }

            case WS_EVT_PONG:
                // Binary pong received — connection is alive, nothing to do
                break;
        }
    }
}

namespace WSServer {

    void init(AsyncWebServer* server,
              SensorReading*  reading_ptr,
              FSMContext*     ctx_ptr,
              std::atomic<uint32_t>* seqlock_ptr)
    {
        g_reading = reading_ptr;
        g_ctx     = ctx_ptr;
        g_seqlock = seqlock_ptr;

        // Allocate WebSocket handler — mounted at /ws/telemetry
        // (relay server connects to this exact path)
        g_ws = new AsyncWebSocket("/ws/telemetry");
        g_ws->onEvent(onWsEvent);
        server->addHandler(g_ws);

        Serial.printf("[WS] WebSocket server mounted at ws://%%s/ws/telemetry\n");
        Serial.printf("[WS] Push interval: %dms\n", WS_PUSH_INTERVAL_MS);
    }

    void tick(const SensorReading& r, const FSMContext& ctx) {
        if (!g_ws) return;

        // Clean up disconnected clients (prevents memory leak on long uptime)
        g_ws->cleanupClients();

        // Nothing to do if no clients connected
        if (g_ws->count() == 0) return;

        uint32_t now = millis();
        if (now - g_last_push_ms < WS_PUSH_INTERVAL_MS) return;
        g_last_push_ms = now;

        // Finding #3 fix: use the pre-built snapshot instead of calling
        // buildJSON() here. buildJSON() writes into a static buffer; if
        // an HTTP handler fires between tick() calls it would corrupt that
        // buffer mid-serialisation. The snapshot was committed by task_comms
        // via buildSnapshot() after the last buildJSON() call — consistent
        // and safe to read here.
        static char s_tick_buf[TelemetryBuilder::TELEMETRY_BUF_SIZE];
        if (!TelemetryBuilder::getSnapshot(s_tick_buf, sizeof(s_tick_buf))) {
            return; // No snapshot available yet (first few comms cycles)
        }

        // Broadcast to all connected clients
        g_ws->textAll(s_tick_buf);
    }
}
