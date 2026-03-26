#pragma once
// ============================================================
//  api_server.h — ESPAsyncWebServer JSON REST API
//
//  Thread safety (Tier 1 fix — Finding #17):
//    init() now accepts a seqlock pointer used by all HTTP handlers
//    that read shared g_reading / g_ctx state. Handlers use the
//    seqlock retry loop instead of taking g_state_mutex, which is
//    forbidden in the lwIP async callback context.
//    See api_server.cpp for full rationale.
// ============================================================
#include "types.h"
#include <ESPAsyncWebServer.h>
#include <atomic>

namespace APIServer {
    void   init(AsyncWebServer*         server,
                SensorReading*          reading_ptr,
                FSMContext*             fsm_ptr,
                std::atomic<uint32_t>*  seqlock_ptr);

    String generateApiKey();
    String getApiKey();
}
