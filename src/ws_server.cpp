// ============================================================
//  ws_server.cpp — ESP32 WebSocket Telemetry Push Server
//
//  Mounts at: ws://<esp32_ip>/ws/telemetry
//  (Same path the relay server connects to)
//
//  Push rate: WS_PUSH_INTERVAL_MS (defined in config.h)
//  Payload:   Full telemetry JSON from TelemetryBuilder::buildJSON()
//             — identical to /api/telemetry response.
//
//  Client handling:
//    - On connect: immediately sends one frame (no wait for interval)
//    - On ping frame: ESPAsyncWebServer handles pong automatically
//    - On disconnect: client removed from the internal client list
//    - On text message (e.g. relay-server ping): ignored gracefully
//
//  Thread safety:
//    AsyncWebSocket events fire on Core-1 (ESPAsync event loop).
//    tick() is called from task_comms also on Core-1.
//    Both on same core — no mutex needed for the WS object itself.
//    SensorReading/FSMContext are read via the g_state_mutex in
//    task_comms before calling tick() — already safe.
// ============================================================
#include "ws_server.h"
#include "telemetry_builder.h"
#include "config.h"
#include <Arduino.h>

namespace {
    AsyncWebSocket*  g_ws      = nullptr;
    SensorReading*   g_reading = nullptr;
    FSMContext*      g_ctx     = nullptr;
    uint32_t         g_last_push_ms = 0;

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
                // Send one frame immediately — client should not wait
                if (g_reading && g_ctx) {
                    const char* payload =
                        TelemetryBuilder::buildJSON(*g_reading, *g_ctx);
                    if (payload) {
                        client->text(payload);
                    }
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
              FSMContext*     ctx_ptr)
    {
        g_reading = reading_ptr;
        g_ctx     = ctx_ptr;

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

        // Build telemetry JSON — uses static buffer, zero heap allocation
        const char* payload = TelemetryBuilder::buildJSON(r, ctx);
        if (!payload) return;

        // Broadcast to all connected clients
        // textAll() sends to every client in one pass
        g_ws->textAll(payload);
    }
}
