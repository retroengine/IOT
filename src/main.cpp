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
#include <atomic>

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
#include "telemetry_builder.h"
#include "sensor_diagnostics.h"

// ─── Shared state ─────────────────────────────────────────────────────────────
static SensorReading     g_reading;
static FSMContext        g_ctx;
static SemaphoreHandle_t g_state_mutex;

// ─── Seqlock for async readers (Findings #2, #17) ─────────────────────────────
// Protects g_reading and g_ctx against torn reads from lwIP async callbacks
// (WS_EVT_CONNECT, HTTP handlers) without blocking the lwIP thread.
//
// Seqlock contract:
//   Writer (task_protection): odd seq → write → even seq
//   Reader (lwIP callbacks):  loop { read seq0; copy; fence; read seq1 }
//                             retry while seq0 is odd or seq0 != seq1
//
// task_comms continues to use g_state_mutex — it is a real RTOS task that
// can legitimately block for a tick, not an async callback.
std::atomic<uint32_t> g_seqlock{0};

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

        float v       = ADCSampler::getVoltage();     // filtered — for telemetry/display
        float i       = ADCSampler::getCurrent();     // filtered — for telemetry/display
        float t       = DS18B20::getTemp();
        int   raw_v   = ADCSampler::getLastRawV();    // integer ADC counts — for sensor checks
        int   raw_i   = ADCSampler::getLastRawI();    // integer ADC counts — for sensor checks

        // Finding #6 / #20 fix: pass pre-IIR physical current to FaultEngine.
        // FaultEngine::evaluate() receives raw_i_phys (4× oversample + calibrate only,
        // no IIR, no MA) so its own asymmetric IIR is the SINGLE filter stage on
        // the protection signal path. This ensures 50ms SC spikes are NOT attenuated
        // across 4 cascaded low-pass stages before the SC comparator sees them.
        float raw_i_phys = ADCSampler::getRawCurrentPhys();

        FaultEngine::evaluate(v, raw_i_phys, t, raw_v, raw_i);
        FSM::tick(t, v);

        FSMContext ctx = FSM::getContext();

        RelayControl::update(ctx.state);
        LedAlert::tick(ctx.state);
        LedAlert::updateLoadLEDs(
            RelayControl::isLoad1Closed(),
            RelayControl::isLoad2Closed()
        );

        if (xSemaphoreTake(g_state_mutex, pdMS_TO_TICKS(5)) == pdTRUE) {
            // Seqlock: mark write in progress (odd) before modifying shared state.
            // memory_order_release ensures the seq store is globally visible
            // before any payload byte is written (Xtensa MEMW barrier).
            uint32_t seq = g_seqlock.load(std::memory_order_relaxed);
            g_seqlock.store(seq + 1, std::memory_order_release);

            g_reading.voltage_v     = v;
            g_reading.current_a     = i;
            g_reading.temp_c        = t;
            g_reading.power_va      = v * i;
            g_reading.ts_ms         = millis();
            g_reading.relay1_closed = RelayControl::isLoad1Closed();
            g_reading.relay2_closed = RelayControl::isLoad2Closed();
            g_reading.fault_bits    = FaultEngine::getActiveFaultBits();
            g_ctx = ctx;

            // Seqlock: mark write complete (even).
            // memory_order_release ensures all payload stores are globally
            // committed before seq turns even — readers see a consistent struct.
            g_seqlock.store(seq + 2, std::memory_order_release);

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

        // Finding #4 fix: advance all diagnostic sliding windows ONCE per
        // comms loop, exclusively here. update() is the sole mutator.
        // It must run BEFORE buildJSON() so the snapshot it commits is
        // the one telemetry_builder serialises in this same cycle.
        SensorDiagnostics::update(r.voltage_v, r.current_a, r.temp_c);

        MQTTClient::tick(r, ctx);
        WSServer::tick(r, ctx);         // push to browser WebSocket clients

        // Build and commit snapshot for async readers (HTTP handlers, WS connect).
        // Called once per comms loop after buildJSON is done inside WSServer/MQTT.
        // All lwIP async paths call TelemetryBuilder::getSnapshot() instead.
        TelemetryBuilder::buildSnapshot();

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

    // ── FINDING #5 FIX: Launch protection tasks BEFORE any WiFi work ──────
    //
    // Original code called WiFiManager::init() here, which could block
    // setup() for 30+ seconds in a captive portal loop — task_protection
    // was never created, the relay was never armed.
    //
    // Correct sequence (per IEC 60255-1 and SGS Roadmap Tier 1):
    //   1. Create the mutex and shared state
    //   2. Register API routes (non-blocking — just register handlers)
    //   3. Start the HTTP server (non-blocking)
    //   4. Launch task_protection (Core 0) — UNCONDITIONAL
    //   5. Launch task_comms (Core 1)      — UNCONDITIONAL
    //   6. Launch task_health (Core 1)
    //   7. Launch task_wifi_provision (Core 1) — BACKGROUND, never blocks

    // Register REST API routes — pass seqlock for async-safe state reads
    APIServer::init(&g_server, &g_reading, &g_ctx, &g_seqlock);

    // Register WebSocket handler — pass seqlock for WS_EVT_CONNECT
    WSServer::init(&g_server, &g_reading, &g_ctx, &g_seqlock);

    // CORS headers for REST endpoints
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Origin",  "*");
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");

    g_server.onNotFound([](AsyncWebServerRequest* req) {
        if (req->method() == HTTP_OPTIONS) { req->send(204); return; }
        req->send(404);
    });

    g_server.begin();
    Serial.printf("[API]  key: %s****\n", APIServer::getApiKey().substring(0, 4).c_str());

    EventEntry boot_event = { millis(), FSM_BOOT, FAULT_NONE, (float)reason, "BOOT" };
    NVSLog::append(boot_event);

    static TaskHandle_t h_prot  = nullptr;
    static TaskHandle_t h_comms = nullptr;
    static void*        health_params[2];

    // Step 4: Launch protection task — ALWAYS, with no WiFi dependency
    xTaskCreatePinnedToCore(
        task_protection, "PROT",
        TASK_PROT_STACK_WORDS, nullptr,
        TASK_PROT_PRIORITY, &h_prot, 0);

    // Step 5: Launch comms task
    xTaskCreatePinnedToCore(
        task_comms, "COMMS",
        TASK_COMMS_STACK_WORDS, nullptr,
        TASK_COMMS_PRIORITY, &h_comms, 1);

    // Step 6: Launch health monitor
    health_params[0] = h_prot;
    health_params[1] = h_comms;
    xTaskCreatePinnedToCore(
        task_health, "HEALTH",
        TASK_HEALTH_STACK_WORDS, health_params,
        TASK_HEALTH_PRIORITY, nullptr, 1);

    // Step 7: Launch WiFi provisioning as a background task on Core 1.
    // This replaces the old WiFiManager::init() call. It returns immediately.
    // If WiFi fails, the captive portal runs inside this task — Core 0 is
    // completely unaffected. Protection runs unconditionally from step 4.
    WiFiManager::startProvisionTask();

    Serial.println("[SGS] All tasks launched — protection is active");
}

void loop() {
    vTaskDelete(nullptr);
}
