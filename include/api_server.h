#pragma once
// ============================================================
//  api_server.h — ESPAsyncWebServer JSON REST API
// ============================================================
#include "types.h"
#include <ESPAsyncWebServer.h>

namespace APIServer {
    void   init(AsyncWebServer* server,
                SensorReading* reading_ptr,
                FSMContext*    fsm_ptr);

    String generateApiKey();
    String getApiKey();
}
