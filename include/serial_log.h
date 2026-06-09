#pragma once
// ============================================================
//  serial_log.h — Timestamped Serial Output for Testing
//
//  Every serial line starts with [T+xxxxx.xxx] showing seconds
//  since boot with millisecond precision. This makes it trivial
//  to correlate events when testing with the playbook.
//
//  Usage:
//    LOG_FSM("NORMAL → FAULT  fault=%s  trips=%d", faultTypeName(ft), ctx.trip_count);
//    LOG_FAULT("OV: V=%.1fV ≥ 253V (IS 12360 +10%%)", v);
//    LOG_RELAY("Load1 → CLOSED");
//
//  Output format:
//    [T+    3.142] [FSM] NORMAL → FAULT  fault=OV  trips=1
//    [T+    3.142] [FAULT] OV: V=255.0V ≥ 253V (IS 12360 +10%)
//    [T+    3.145] [RELAY] Load1 → CLOSED
// ============================================================

#include <Arduino.h>

// ── Timestamp prefix — seconds.milliseconds since boot ──────────
// Format: [T+SSSSS.sss] — right-aligned seconds, always 3 decimal places
// Total width: 14 chars including brackets

#define _LOG_FMT(tag, fmt, ...) do { \
    unsigned long _ms = (unsigned long)millis(); \
    Serial.printf("[T+%5lu.%03lu] [" tag "] " fmt "\n", _ms / 1000, _ms % 1000, ##__VA_ARGS__); \
} while(0)

// ── Module-tagged log macros ─────────────────────────────────────
// Each macro: timestamp + tag + formatted message + newline
// Uses a single Serial.printf to guarantee thread-safe (atomic) line output

#define LOG_FSM(fmt, ...)       _LOG_FMT("FSM", fmt, ##__VA_ARGS__)
#define LOG_FAULT(fmt, ...)     _LOG_FMT("FAULT", fmt, ##__VA_ARGS__)
#define LOG_FAULT_ENG(fmt, ...) _LOG_FMT("FAULT_ENG", fmt, ##__VA_ARGS__)
#define LOG_RELAY(fmt, ...)     _LOG_FMT("RELAY", fmt, ##__VA_ARGS__)
#define LOG_ADC(fmt, ...)       _LOG_FMT("ADC", fmt, ##__VA_ARGS__)
#define LOG_DS18B20(fmt, ...)   _LOG_FMT("DS18B20", fmt, ##__VA_ARGS__)
#define LOG_SGS(fmt, ...)       _LOG_FMT("SGS", fmt, ##__VA_ARGS__)
#define LOG_PROT(fmt, ...)      _LOG_FMT("PROT", fmt, ##__VA_ARGS__)
#define LOG_COMMS(fmt, ...)     _LOG_FMT("COMMS", fmt, ##__VA_ARGS__)
#define LOG_HEALTH(fmt, ...)    _LOG_FMT("HEALTH", fmt, ##__VA_ARGS__)
#define LOG_WIFI(fmt, ...)      _LOG_FMT("WiFi", fmt, ##__VA_ARGS__)
#define LOG_MQTT(fmt, ...)      _LOG_FMT("MQTT", fmt, ##__VA_ARGS__)
#define LOG_WDT(fmt, ...)       _LOG_FMT("WDT", fmt, ##__VA_ARGS__)
#define LOG_LED(fmt, ...)       _LOG_FMT("LED", fmt, ##__VA_ARGS__)
#define LOG_BUZZER(fmt, ...)    _LOG_FMT("BUZZER", fmt, ##__VA_ARGS__)
#define LOG_NVS(fmt, ...)       _LOG_FMT("NVS", fmt, ##__VA_ARGS__)
#define LOG_MAIN(fmt, ...)      _LOG_FMT("MAIN", fmt, ##__VA_ARGS__)
#define LOG_WS(fmt, ...)        _LOG_FMT("WS", fmt, ##__VA_ARGS__)
#define LOG_OLED(fmt, ...)      _LOG_FMT("OLED", fmt, ##__VA_ARGS__)
#define LOG_TELEM(fmt, ...)     _LOG_FMT("TELEMETRY", fmt, ##__VA_ARGS__)
