#pragma once
// ============================================================
//  config.h — Project-wide constants for Smart Grid Sentinel
// ============================================================

// ─── GPIO Pins ────────────────────────────────────────────────────────────────
#define PIN_RELAY_LOAD1     26
#define PIN_RELAY_LOAD2     27
#define PIN_ALERT_LED       2
#define PIN_BUZZER          25
#define PIN_DS18B20         4
#define PIN_OLED_SDA        21
#define PIN_OLED_SCL        22

// ─── ADC ──────────────────────────────────────────────────────────────────────
#define ADC_OVERSAMPLE      4
#define ADC_MAX_RAW         4095.0f
#define VOLTAGE_FULL_SCALE  300.0f      // V
#define CURRENT_FULL_SCALE  5.0f        // A
#define IIR_ALPHA_VOLTAGE   0.2f
#define IIR_ALPHA_CURRENT   0.3f
#define CURR_DEADBAND_A     0.05f       // snap to 0 below this (A)
#define MOVING_AVG_DEPTH    10

// ─── Fault / Warning Thresholds ──────────────────────────────────────────────
#define VOLT_OV_WARN_V      250.0f
#define VOLT_OV_FAULT_V     260.0f
#define VOLT_UV_WARN_V      200.0f
#define VOLT_UV_FAULT_V     190.0f
#define CURR_OC_WARN_A      4.0f
#define CURR_OC_FAULT_A     4.5f
#define TEMP_WARN_C         70.0f
#define TEMP_FAULT_C        85.0f
#define TEMP_RESET_BLOCK_C  60.0f       // manual reset blocked above this

// ─── Fault Engine ─────────────────────────────────────────────────────────────
#define FAULT_DEBOUNCE_N    3           // consecutive samples to trip (normal load)
#define FAULT_DEBOUNCE_HEAVY 5          // consecutive samples to trip (heavy load)
#define WARN_DEBOUNCE_N     2
#define WARN_DEBOUNCE_HEAVY 4
#define LOAD_HEAVY_A        2.5f        // threshold for "heavy load" debounce mode
#define INRUSH_BLANK_MS     500         // OC fault suppressed after relay closes
#define INRUSH_BLANK_WARN_MS 300        // OC warn suppressed after relay closes

// ─── FSM ──────────────────────────────────────────────────────────────────────
#define RECOVERY_DELAY_MS   10000       // auto-recover after 10 s in FAULT
#define MAX_TRIP_COUNT      3           // trips before LOCKOUT

// ─── Temperature Sensor ───────────────────────────────────────────────────────
#define TEMP_READ_INTERVAL_MS 2000

// ─── OLED ─────────────────────────────────────────────────────────────────────
#define OLED_WIDTH          128
#define OLED_HEIGHT         64
#define OLED_RESET_PIN      -1          // shared reset
#define OLED_I2C_ADDR       0x3C
#define OLED_PAGE_FLIP_MS   4000        // flip display page every 4 s

// ─── Buzzer (LEDC) ────────────────────────────────────────────────────────────
#define BUZZER_LEDC_CHANNEL 0
#define BUZZER_LEDC_RES_BITS 8
#define BUZZER_FREQ_WARN    1000        // Hz
#define BUZZER_FREQ_FAULT   2000        // Hz
#define BUZZER_FREQ_LOCK    500         // Hz
#define BUZZER_DUTY_50      128         // 50% duty at 8-bit resolution

// ─── NVS / Preferences ────────────────────────────────────────────────────────
#define NVS_NAMESPACE       "sgs"
#define NVS_KEY_WIFI_SSID   "wifi_ssid"
#define NVS_KEY_WIFI_PASS   "wifi_pass"
#define NVS_KEY_API_KEY     "api_key"
#define NVS_KEY_MQTT_HOST   "mqtt_host"
#define NVS_KEY_MQTT_PORT   "mqtt_port"
#define NVS_KEY_MQTT_USER   "mqtt_user"
#define NVS_KEY_MQTT_PASS   "mqtt_pass"
#define NVS_KEY_LOG_HEAD    "log_head"
#define NVS_KEY_LOG_COUNT   "log_count"
#define NVS_KEY_LOG_ENTRY   "log_e"
#define EVENT_LOG_CAPACITY  50

// ─── MQTT ─────────────────────────────────────────────────────────────────────
#define MQTT_KEEPALIVE          60
#define MQTT_PUB_INTERVAL_MS    5000
#define MQTT_TOPIC_TELEMETRY    "sgs/telemetry"
#define MQTT_TOPIC_FAULT        "sgs/fault"
#define MQTT_TOPIC_STATE        "sgs/state"

// ─── HTTP API ─────────────────────────────────────────────────────────────────
#define API_PORT            80
#define API_KEY_LENGTH      16

// ─── FreeRTOS Tasks ───────────────────────────────────────────────────────────
#define SENSOR_LOOP_MS          10
#define COMMS_LOOP_MS           50
#define HEALTH_LOOP_MS          10000
#define SENSOR_QUEUE_LEN        1
#define TASK_PROT_STACK_WORDS   4096
#define TASK_COMMS_STACK_WORDS  6144
#define TASK_HEALTH_STACK_WORDS 2048
#define TASK_PROT_PRIORITY      5
#define TASK_COMMS_PRIORITY     3
#define TASK_HEALTH_PRIORITY    1

// ─── Watchdog ─────────────────────────────────────────────────────────────────
#define WDT_TIMEOUT_S       10

// ─── Health Monitor ───────────────────────────────────────────────────────────
#define HEAP_WARN_BYTES     20000

// ============================================================
//  config_additions.h
//  ADD THESE LINES TO YOUR EXISTING config.h
//  Find the MQTT section and add the new fields below.
//  Find the Power section and add NOMINAL_VOLTAGE_V.
// ============================================================

// ── MQTT Section — ADD THESE (find existing MQTT defines) ────────────────
#define MQTT_DEFAULT_HOST   "e7fc2b846d3f4104914943838d5c7c27.s1.eu.hivemq.cloud"  // <-- FROM HIVEMQ DASHBOARD
#define MQTT_DEFAULT_PORT   8883                                // TLS port (was 1883)
#define MQTT_USERNAME       "sgs-device-01"                    // <-- FROM HIVEMQ CREDENTIALS
#define MQTT_PASSWORD       "Chicken@65"        // <-- FROM HIVEMQ CREDENTIALS

// Uncomment the line below ONLY during development to skip TLS cert check.
// NEVER leave this defined in production firmware.
// #define MQTT_SKIP_CERT_VERIFY

// ── Power Quality Section — ADD THIS ─────────────────────────────────────
// Nominal grid voltage for your region.
// Change to 120.0f if you are in North America / Japan.
#define NOMINAL_VOLTAGE_V   230.0f

// ── mqtt_client.h additions — ADD these new function declarations ─────────
// These are needed because telemetry_builder.cpp calls them.
// Add to your mqtt_client.h:
//
//   uint32_t getConnectAttempts();
//   uint32_t getConnectSuccesses();
//   uint32_t getPublishTotal();
//   uint32_t getPublishFailed();
//   bool     isCertVerified();
//   uint32_t getLastConnectMs();