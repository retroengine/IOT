#pragma once
// ============================================================
//  mqtt_client.h — MQTT telemetry & event publisher
// ============================================================
#include "types.h"
namespace MQTTClient {
    void     init();
    void     tick(const SensorReading& r, const FSMContext& ctx);
    bool     isConnected();
    // ADD THESE:
    uint32_t getConnectAttempts();
    uint32_t getConnectSuccesses();
    uint32_t getPublishTotal();
    uint32_t getPublishFailed();
    bool     isCertVerified();
    uint32_t getLastConnectMs();
}