// ============================================================
//  main.cpp — Smart Grid Sentinel Demo
//  Dual-core FreeRTOS task split:
//    Core 0 (task_protection) — ADC, DS18B20, FaultEngine, FSM,
//                               RelayControl, LedAlert
//    Core 1 (task_comms)      — OLED, MQTT, Buzzer
//    Core 1 async             — ESPAsyncWebServer (event-driven)
// ============================================================
#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
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

// ─── Shared state (written by Core-0, read by Core-1) ────────────────────────
static SensorReading g_reading;
static FSMContext    g_ctx;
static SemaphoreHandle_t g_state_mutex;

// ─── FreeRTOS queue: pointer to g_reading (4 bytes, no copy) ─────────────────
static QueueHandle_t g_queue;

// ─── HTTP server (Core-1, ESPAsync is event-driven) ──────────────────────────
static AsyncWebServer g_server(API_PORT);

// ─── Core-0 Protection Task ──────────────────────────────────────────────────
void task_protection(void* pvParam) {
    Serial.printf("[PROT] task on core %d\n", xPortGetCoreID());

    // Register this task with the task watchdog
    esp_task_wdt_add(nullptr);

    ADCSampler::init();
    DS18B20::init();
    FaultEngine::init();
    FSM::init();
    RelayControl::init();
    LedAlert::init();

    while (true) {
        // Pet the watchdog — must happen within WDT_TIMEOUT_S
        esp_task_wdt_reset();

        // 1. Sample sensors
        ADCSampler::tick();
        DS18B20::tick();

        float v   = ADCSampler::getVoltage();
        float i   = ADCSampler::getCurrent();
        float t   = DS18B20::getTemp();

        // Raw ADC integers required by fault_engine v3.0:
        //   EC-06: saturation detection (open wire / op-amp rail short)
        //   EC-07: frozen sensor detection (ADC mux hang / IC lockup)
        int raw_v_int = ADCSampler::getLastRawV();
        int raw_i_int = ADCSampler::getLastRawI();

        // 2. Run fault engine
        // v3.0 signature: evaluate(voltage, current, temp, raw_v_adc, raw_i_adc)
        FaultEngine::evaluate(v, i, t, raw_v_int, raw_i_int);

        // 3. Run FSM
        // v3.0 signature: tick(temp_c, voltage_v)
        // voltage_v used for recovery confirmation (EC-14):
        // voltage must hold ±5% of 230V for 500ms before relay re-closes.
        FSM::tick(t, v);

        // 4. Get current FSM context
        FSMContext ctx = FSM::getContext();

        // 5. Update relays based on FSM state
        RelayControl::update(ctx.state);

        // 6. Update alert LED (blink pattern driven by FSM state)
        LedAlert::tick(ctx.state);

        // 6a. Update load indicator LEDs (GPIO 16 = green / GPIO 17 = yellow)
        //     Called AFTER RelayControl::update() so relay state is current.
        //     Green  (GPIO 16) → ON when Load 1 relay is CLOSED
        //     Yellow (GPIO 17) → ON when Load 2 relay is CLOSED
        LedAlert::updateLoadLEDs(
            RelayControl::isLoad1Closed(),
            RelayControl::isLoad2Closed()
        );

        // 7. Pack sensor reading
        if (xSemaphoreTake(g_state_mutex, pdMS_TO_TICKS(5)) == pdTRUE) {
            g_reading.voltage_v     = v;
            g_reading.current_a     = i;
            g_reading.temp_c        = t;
            g_reading.power_va      = v * i;
            g_reading.ts_ms         = millis();
            g_reading.relay1_closed = RelayControl::isLoad1Closed();
            g_reading.relay2_closed = RelayControl::isLoad2Closed();
            // fault_engine v3.0: full multi-fault bitmask for telemetry/dashboard.
            // Allows dashboard to display all simultaneous active faults, not
            // just the highest-priority one. Requires adding to SensorReading
            // in types.h:  uint16_t fault_bits;
            g_reading.fault_bits    = FaultEngine::getActiveFaultBits();
            g_ctx = ctx;
            xSemaphoreGive(g_state_mutex);
        }

        // 8. Push pointer to queue (non-blocking, overwrite oldest)
        SensorReading* ptr = &g_reading;
        xQueueOverwrite(g_queue, &ptr);

        vTaskDelay(pdMS_TO_TICKS(SENSOR_LOOP_MS));
    }
}

// ─── Core-1 Comms Task ───────────────────────────────────────────────────────
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

        vTaskDelay(pdMS_TO_TICKS(COMMS_LOOP_MS));
    }
}

// ─── Health Monitor Task (Core-1, lowest priority) ───────────────────────────
// Periodically prints stack high-water marks and heap usage.
// A shrinking stack HWM is an early warning of stack overflow.
// A shrinking heap warns of memory leaks (e.g., JSON buffer leaks).
void task_health(void* pvParam) {
    TaskHandle_t h_prot  = (TaskHandle_t)((void**)pvParam)[0];
    TaskHandle_t h_comms = (TaskHandle_t)((void**)pvParam)[1];

    while (true) {
        uint32_t free_heap  = esp_get_free_heap_size();
        uint32_t min_heap   = esp_get_minimum_free_heap_size();

        UBaseType_t hwm_prot  = uxTaskGetStackHighWaterMark(h_prot);
        UBaseType_t hwm_comms = uxTaskGetStackHighWaterMark(h_comms);
        UBaseType_t hwm_self  = uxTaskGetStackHighWaterMark(nullptr);

        Serial.printf("[HEALTH] heap=%lu min=%lu  stk_prot=%u stk_comms=%u stk_health=%u\n",
                      free_heap, min_heap, hwm_prot, hwm_comms, hwm_self);

        if (free_heap < HEAP_WARN_BYTES) {
            Serial.printf("[HEALTH] WARNING: low heap %lu bytes!\n", free_heap);
        }
        if (hwm_prot < 512) {
            Serial.printf("[HEALTH] WARNING: PROT task stack critically low! HWM=%u words\n",
                          hwm_prot);
        }
        if (hwm_comms < 512) {
            Serial.printf("[HEALTH] WARNING: COMMS task stack critically low! HWM=%u words\n",
                          hwm_comms);
        }

        vTaskDelay(pdMS_TO_TICKS(HEALTH_LOOP_MS));
    }
}

// ─── Arduino Setup ───────────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(200);
    Serial.println("\n[SGS] Smart Grid Sentinel Demo — boot");

    // Log the reset reason (tells us if last run crashed or was watchdog reset)
    esp_reset_reason_t reason = esp_reset_reason();
    Serial.printf("[SGS] Reset reason: %d (%s)\n", reason,
        reason == ESP_RST_WDT      ? "WATCHDOG"    :
        reason == ESP_RST_PANIC    ? "PANIC/CRASH"  :
        reason == ESP_RST_BROWNOUT ? "BROWNOUT"     :
        reason == ESP_RST_POWERON  ? "POWER_ON"     : "OTHER");

    // Configure task watchdog — both tasks must pet it every WDT_TIMEOUT_S
    // IDF v4.4.7 API: init(timeout_seconds, panic_on_timeout)
    esp_task_wdt_init(WDT_TIMEOUT_S, true);
    Serial.printf("[WDT] Task watchdog configured: %ds timeout\n", WDT_TIMEOUT_S);

    // Init persistent log first (other modules may log during init)
    NVSLog::init();

    // Create synchronization primitives
    g_state_mutex = xSemaphoreCreateMutex();
    g_queue       = xQueueCreate(SENSOR_QUEUE_LEN, sizeof(SensorReading*));

    // Connect to Wi-Fi (blocks until connected or captive portal)
    WiFiManager::init();

    // Start HTTP API server
    APIServer::init(&g_server, &g_reading, &g_ctx);
    g_server.begin();
    Serial.printf("[HTTP] Listening on http://%s:%d\n",
                  WiFiManager::getIP(), API_PORT);
    Serial.printf("[HTTP] API key: %s\n", APIServer::getApiKey().c_str());

    // Log boot event (with reset reason)
    EventEntry boot_event = { millis(), FSM_BOOT, FAULT_NONE, (float)reason, "BOOT" };
    NVSLog::append(boot_event);

    // Launch tasks — capture handles for health monitor
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

    // Health task gets handles of the other two tasks to monitor their stacks
    health_params[0] = h_prot;
    health_params[1] = h_comms;
    xTaskCreatePinnedToCore(
        task_health, "HEALTH",
        TASK_HEALTH_STACK_WORDS, health_params,
        TASK_HEALTH_PRIORITY, nullptr, 1);

    Serial.println("[SGS] All tasks launched");
}

// Arduino loop task is deleted — all work done in FreeRTOS tasks
void loop() {
    vTaskDelete(nullptr);
}