// ============================================================
//  main.cpp — Smart Grid Sentinel
//  Dual-core FreeRTOS task split:
//    Core 0 (task_protection) — ADC, DS18B20, FaultEngine, FSM,
//                               RelayControl, LedAlert
//    Core 1 (task_comms)      — OLED, MQTT, Buzzer, WSServer
//    Core 1 async             — ESPAsyncWebServer (event-driven)
// ============================================================
#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include <ESPAsyncWebServer.h>
#include <esp_task_wdt.h>
#include <esp_system.h>

#include "config.h"
#include "types.h"
#include "adc_sampler.h"
#include "ds18b20.h"
#include "fault_engine.h"
#include "fsm.h"
#include "relay_control.h"
#include "led_alert.h"
#include "oled_display.h"
#include "buzzer.h"
#include "nvs_log.h"
#include "wifi_manager.h"
#include "api_server.h"
#include "mqtt_client.h"
#include "ws_server.h"

// ─── Shared state ─────────────────────────────────────────────────────────────
static SensorReading     g_reading;
static FSMContext        g_ctx;
static SemaphoreHandle_t g_state_mutex;

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────
static AsyncWebServer g_server(API_PORT);

// ─── Core-0: Protection Task ──────────────────────────────────────────────────
void task_protection(void* pvParam) {
    Serial.printf("[PROT] task on core %d\n", xPortGetCoreID());
    esp_task_wdt_add(nullptr);

    ADCSampler::init();
    DS18B20::init();
    FaultEngine::init();
    FSM::init();
    RelayControl::init();
    LedAlert::init();

    while (true) {
        esp_task_wdt_reset();

        ADCSampler::tick();
        DS18B20::tick();

        float v       = ADCSampler::getVoltage();
        float i       = ADCSampler::getCurrent();
        float t       = DS18B20::getTemp();
        int   raw_v   = ADCSampler::getLastRawV();
        int   raw_i   = ADCSampler::getLastRawI();

        FaultEngine::evaluate(v, i, t, raw_v, raw_i);
        FSM::tick(t, v);

        FSMContext ctx = FSM::getContext();

        RelayControl::update(ctx.state);
        LedAlert::tick(ctx.state);
        LedAlert::updateLoadLEDs(
            RelayControl::isLoad1Closed(),
            RelayControl::isLoad2Closed()
        );

        if (xSemaphoreTake(g_state_mutex, pdMS_TO_TICKS(5)) == pdTRUE) {
            g_reading.voltage_v     = v;
            g_reading.current_a     = i;
            g_reading.temp_c        = t;
            g_reading.power_va      = v * i;
            g_reading.ts_ms         = millis();
            g_reading.relay1_closed = RelayControl::isLoad1Closed();
            g_reading.relay2_closed = RelayControl::isLoad2Closed();
            g_reading.fault_bits    = FaultEngine::getActiveFaultBits();
            g_ctx = ctx;
            xSemaphoreGive(g_state_mutex);
        }

        vTaskDelay(pdMS_TO_TICKS(SENSOR_LOOP_MS));
    }
}

// ─── Core-1: Comms Task ───────────────────────────────────────────────────────
void task_comms(void* pvParam) {
    Serial.printf("[COMMS] task on core %d\n", xPortGetCoreID());
    esp_task_wdt_add(nullptr);

    OLEDDisplay::init();
    Buzzer::init();
    MQTTClient::init();

    while (true) {
        esp_task_wdt_reset();

        SensorReading r;
        FSMContext    ctx;

        if (xSemaphoreTake(g_state_mutex, pdMS_TO_TICKS(5)) == pdTRUE) {
            r   = g_reading;
            ctx = g_ctx;
            xSemaphoreGive(g_state_mutex);
        }

        OLEDDisplay::update(r, ctx);
        Buzzer::tick(ctx.state);
        MQTTClient::tick(r, ctx);
        WSServer::tick(r, ctx);         // push to browser WebSocket clients

        vTaskDelay(pdMS_TO_TICKS(COMMS_LOOP_MS));
    }
}

// ─── Core-1: Health Monitor Task ──────────────────────────────────────────────
void task_health(void* pvParam) {
    TaskHandle_t h_prot  = (TaskHandle_t)((void**)pvParam)[0];
    TaskHandle_t h_comms = (TaskHandle_t)((void**)pvParam)[1];

    while (true) {
        uint32_t free_heap = esp_get_free_heap_size();
        uint32_t min_heap  = esp_get_minimum_free_heap_size();

        UBaseType_t hwm_prot  = uxTaskGetStackHighWaterMark(h_prot);
        UBaseType_t hwm_comms = uxTaskGetStackHighWaterMark(h_comms);

        Serial.printf("[HEALTH] heap=%lu min=%lu  stk_prot=%u stk_comms=%u\n",
                      free_heap, min_heap, hwm_prot, hwm_comms);

        if (free_heap < HEAP_WARN_BYTES)
            Serial.printf("[HEALTH] WARNING: low heap %lu bytes!\n", free_heap);
        if (hwm_prot  < 512)
            Serial.printf("[HEALTH] WARNING: PROT stack low HWM=%u\n",  hwm_prot);
        if (hwm_comms < 512)
            Serial.printf("[HEALTH] WARNING: COMMS stack low HWM=%u\n", hwm_comms);

        vTaskDelay(pdMS_TO_TICKS(HEALTH_LOOP_MS));
    }
}

// ─── Setup ────────────────────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(200);
    Serial.println("\n[SGS] Smart Grid Sentinel — boot");

    esp_reset_reason_t reason = esp_reset_reason();
    Serial.printf("[SGS] Reset reason: %d (%s)\n", reason,
        reason == ESP_RST_WDT      ? "WATCHDOG"   :
        reason == ESP_RST_PANIC    ? "PANIC/CRASH" :
        reason == ESP_RST_BROWNOUT ? "BROWNOUT"    :
        reason == ESP_RST_POWERON  ? "POWER_ON"    : "OTHER");

    esp_task_wdt_init(WDT_TIMEOUT_S, true);
    Serial.printf("[WDT] configured: %ds\n", WDT_TIMEOUT_S);

    NVSLog::init();

    g_state_mutex = xSemaphoreCreateMutex();

    WiFiManager::init();

    // Register REST API routes
    APIServer::init(&g_server, &g_reading, &g_ctx);

    // Register WebSocket handler — must be before g_server.begin()
    WSServer::init(&g_server, &g_reading, &g_ctx);

    // CORS headers for REST endpoints
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Origin",  "*");
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");

    g_server.onNotFound([](AsyncWebServerRequest* req) {
        if (req->method() == HTTP_OPTIONS) { req->send(204); return; }
        req->send(404);
    });

    g_server.begin();

    Serial.printf("[HTTP] http://%s:%d\n", WiFiManager::getIP(), API_PORT);
    Serial.printf("[WS]   ws://%s/ws/telemetry\n", WiFiManager::getIP());
    Serial.printf("[API]  key: %s\n", APIServer::getApiKey().c_str());

    EventEntry boot_event = { millis(), FSM_BOOT, FAULT_NONE, (float)reason, "BOOT" };
    NVSLog::append(boot_event);

    static TaskHandle_t h_prot  = nullptr;
    static TaskHandle_t h_comms = nullptr;
    static void*        health_params[2];

    xTaskCreatePinnedToCore(
        task_protection, "PROT",
        TASK_PROT_STACK_WORDS, nullptr,
        TASK_PROT_PRIORITY, &h_prot, 0);

    xTaskCreatePinnedToCore(
        task_comms, "COMMS",
        TASK_COMMS_STACK_WORDS, nullptr,
        TASK_COMMS_PRIORITY, &h_comms, 1);

    health_params[0] = h_prot;
    health_params[1] = h_comms;
    xTaskCreatePinnedToCore(
        task_health, "HEALTH",
        TASK_HEALTH_STACK_WORDS, health_params,
        TASK_HEALTH_PRIORITY, nullptr, 1);

    Serial.println("[SGS] All tasks launched");
}

void loop() {
    vTaskDelete(nullptr);
}
