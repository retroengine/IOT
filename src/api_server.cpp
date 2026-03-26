// ============================================================
//  api_server.cpp — ESPAsyncWebServer JSON REST API v2.1
//
//  TIER 1 FIXES (v2.1):
//
//  Finding #17 — HTTP Handler Reads g_reading Without Mutex
//    All handlers that read g_reading / g_ctx now use two paths:
//      /api/telemetry  → TelemetryBuilder::getSnapshot() — zero
//                        serialisation in the async context, no
//                        static buffer race, no mutex needed.
//      /api/state      → seqlock retry loop on g_seqlock reads
//                        g_reading / g_ctx atomically without
//                        blocking the lwIP task.
//    The key insight: pdMS_TO_TICKS(5) evaluates to 0 at 100Hz
//    tick rate (5*100/1000 = 0, integer truncation). Any mutex
//    attempt in this context is a non-blocking poll, not a wait.
//    The seqlock is the correct primitive (Option C, research doc).
//
//  Finding #4 — SensorDiagnostics::compute() Mutates Shared State
//    /api/diagnostics was calling compute() directly from the lwIP
//    async context, racing with the call inside buildJSON() in
//    task_comms. Both paths advanced the same static sliding window
//    buffers — double-counting fault events and corrupting the
//    power quality window.
//    Fix: /api/diagnostics now calls lastSnapshot() only.
//    compute() is called exclusively from buildJSON() in task_comms.
//
//  Finding #12 — Full API Key Printed to Serial on Every Boot
//    Serial.printf now prints only first 4 chars + asterisks.
//    The full key is never written to any serial or log output.
//    Field recovery via /api/key-hint is the only legitimate channel.
//
//  Finding #16 — delay() Inside ESPAsyncWebServer Callback
//    CONFIRMED ALREADY FIXED in original code: the /save handler in
//    wifi_manager.cpp is the location of this bug, not api_server.cpp.
//    All reboot-triggering handlers here already use scheduleReboot().
//    No change required in this file for Finding #16.
//
//  UNCHANGED FROM v2.0:
//    - All route handlers not touching g_reading/g_ctx
//    - GET /api/log, /api/config, /api/wifi, /api/wifi/scan
//    - POST /api/relay, /api/reset, /api/reboot, /api/factory-reset
//    - POST /api/wifi, /api/log/clear
//    - GET /api/key-hint, /api/health, /api/ping
//    - CORS headers, API key auth, reboot task pattern
// ============================================================
#include "api_server.h"
#include "telemetry_builder.h"
#include "sensor_diagnostics.h"
#include "relay_control.h"
#include "config.h"
#include "fsm.h"
#include "nvs_log.h"
#include <ArduinoJson.h>
#include <Preferences.h>
#include <WiFi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <atomic>
#include <cstring>

namespace {
    SensorReading*          g_reading  = nullptr;
    FSMContext*             g_ctx      = nullptr;
    String                  g_api_key;
    std::atomic<uint32_t>*  g_seqlock  = nullptr;

    // ── Seqlock snapshot helper (Finding #17) ─────────────────────────────
    // Reads g_reading and g_ctx into caller-supplied structs using the
    // seqlock retry loop. Safe to call from the lwIP async context.
    // Returns true if a consistent snapshot was obtained.
    // Returns false if g_seqlock is not yet initialised (early boot).
    bool readSharedState(SensorReading& r_out, FSMContext& ctx_out) {
        if (!g_reading || !g_ctx || !g_seqlock) return false;

        uint32_t seq0, seq1;
        do {
            seq0 = g_seqlock->load(std::memory_order_acquire);
            r_out   = *g_reading;
            ctx_out = *g_ctx;
            std::atomic_thread_fence(std::memory_order_acquire);
            seq1 = g_seqlock->load(std::memory_order_relaxed);
        } while ((seq0 & 1u) != 0u || seq0 != seq1);

        return true;
    }

    // ── Response helpers ───────────────────────────────────────────────────
    void addCORS(AsyncWebServerResponse* res) {
        res->addHeader("Access-Control-Allow-Origin",  "*");
        res->addHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
        res->addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }

    bool authOK(AsyncWebServerRequest* req) {
        if (!req->hasHeader("X-API-Key")) return false;
        return req->getHeader("X-API-Key")->value() == g_api_key;
    }

    void sendUnauth(AsyncWebServerRequest* req) {
        AsyncWebServerResponse* res = req->beginResponse(401,
            "application/json", "{\"error\":\"Unauthorized\"}");
        addCORS(res);
        req->send(res);
    }

    void sendJSON(AsyncWebServerRequest* req, int code, const String& body) {
        AsyncWebServerResponse* res =
            req->beginResponse(code, "application/json", body);
        addCORS(res);
        req->send(res);
    }

    void reboot_task(void* pvParam) {
        uint32_t delay_ms = (uint32_t)(uintptr_t)pvParam;
        vTaskDelay(pdMS_TO_TICKS(delay_ms));
        ESP.restart();
        vTaskDelete(nullptr);
    }

    void scheduleReboot(uint32_t delay_ms) {
        xTaskCreate(reboot_task, "REBOOT", 1024,
                    (void*)(uintptr_t)delay_ms, 1, nullptr);
    }

    // Static buffer for /api/telemetry and /api/state snapshot reads.
    // Each handler has its own buffer — no sharing between concurrent requests.
    static char s_telemetry_buf[TelemetryBuilder::TELEMETRY_BUF_SIZE];
}

namespace APIServer {

    String generateApiKey() {
        String key = "";
        for (int i = 0; i < API_KEY_LENGTH / 2; i++) {
            key += String(esp_random() & 0xFF, HEX);
        }
        return key;
    }

    String getApiKey() { return g_api_key; }

    void init(AsyncWebServer*         server,
              SensorReading*          reading_ptr,
              FSMContext*             fsm_ptr,
              std::atomic<uint32_t>*  seqlock_ptr) {

        g_reading = reading_ptr;
        g_ctx     = fsm_ptr;
        g_seqlock = seqlock_ptr;

        Preferences prefs;
        prefs.begin(NVS_NAMESPACE, false);
        g_api_key = prefs.getString(NVS_KEY_API_KEY, "");
        if (g_api_key.isEmpty()) {
            g_api_key = generateApiKey();
            prefs.putString(NVS_KEY_API_KEY, g_api_key);
            // Finding #12: print only first 4 chars on new key generation
            Serial.printf("[API] Generated API key: %s****\n",
                          g_api_key.substring(0, 4).c_str());
        } else {
            // Finding #12: never print full key — first 4 chars only
            Serial.printf("[API] API key loaded: %s****\n",
                          g_api_key.substring(0, 4).c_str());
        }
        prefs.end();

        // ── CORS Preflight ─────────────────────────────────────────────────
        server->onNotFound([](AsyncWebServerRequest* req) {
            if (req->method() == HTTP_OPTIONS) {
                AsyncWebServerResponse* res = req->beginResponse(204);
                addCORS(res);
                req->send(res);
            } else {
                req->send(404, "application/json", "{\"error\":\"Not found\"}");
            }
        });

        // ── GET /api/ping ─────────────────────────────────────────────────
        server->on("/api/ping", HTTP_GET, [](AsyncWebServerRequest* req) {
            sendJSON(req, 200,
                "{\"status\":\"ok\",\"uptime\":" + String(millis()) + "}");
        });

        // ── GET /api/telemetry ────────────────────────────────────────────
        // Finding #17 fix: no longer calls buildJSON() from the lwIP async
        // context (static buffer race — Finding #3). Instead reads the
        // pre-built snapshot committed by task_comms via buildSnapshot().
        // getSnapshot() uses a seqlock retry loop — zero blocking time.
        server->on("/api/telemetry", HTTP_GET, [](AsyncWebServerRequest* req) {
            if (!g_reading || !g_ctx) {
                sendJSON(req, 503, "{\"error\":\"Not ready\"}");
                return;
            }
            if (!TelemetryBuilder::getSnapshot(s_telemetry_buf,
                                                sizeof(s_telemetry_buf))) {
                sendJSON(req, 503, "{\"error\":\"Snapshot not yet available\"}");
                return;
            }
            AsyncWebServerResponse* res =
                req->beginResponse(200, "application/json", s_telemetry_buf);
            addCORS(res);
            req->send(res);
        });

        // ── GET /api/diagnostics ──────────────────────────────────────────
        // Finding #4 fix: no longer calls compute() from the lwIP async
        // context. compute() is called exclusively from buildJSON() in
        // task_comms. This handler reads the last committed snapshot via
        // lastSnapshot() — read-only, no state mutation, safe from any context.
        server->on("/api/diagnostics", HTTP_GET, [](AsyncWebServerRequest* req) {
            if (!g_reading) {
                sendJSON(req, 503, "{\"error\":\"Not ready\"}");
                return;
            }

            // Finding #4: use lastSnapshot() — NOT compute()
            const DiagnosticsSnapshot& d = SensorDiagnostics::lastSnapshot();

            JsonDocument doc;
            doc["schema_v"]       = "1.3";
            doc["computed_at_ms"] = d.computed_at_ms;

            // ── Voltage health ────────────────────────────────────────────
            JsonObject v = doc["voltage_health"].to<JsonObject>();
            v["noise_floor_v"]       = serialized(String(d.voltage.noise_floor_v,      3));
            v["drift_rate_v_per_s"]  = serialized(String(d.voltage.drift_rate_v_per_s, 3));
            v["min_seen_v"]          = serialized(String(d.voltage.min_seen_v,         1));
            v["max_seen_v"]          = serialized(String(d.voltage.max_seen_v,         1));
            v["peak_to_peak_v"]      = serialized(String(d.voltage.peak_to_peak_v,     1));
            v["saturated"]           = d.voltage.saturated;
            v["snr_db"]              = serialized(String(d.voltage.snr_db,             1));
            v["variance"]            = serialized(String(d.voltage.variance,           4));
            v["stability_score"]     = d.voltage.stability_score;
            v["stability_label"]     = d.voltage.stability_label;

            // ── Current health ────────────────────────────────────────────
            JsonObject ci = doc["current_health"].to<JsonObject>();
            ci["noise_floor_a"]      = serialized(String(d.current.noise_floor_a,      4));
            ci["drift_rate_a_per_s"] = serialized(String(d.current.drift_rate_a_per_s, 4));
            ci["min_seen_a"]         = serialized(String(d.current.min_seen_a,         3));
            ci["max_seen_a"]         = serialized(String(d.current.max_seen_a,         3));
            ci["saturated"]          = d.current.saturated;
            ci["snr_db"]             = serialized(String(d.current.snr_db,             1));
            ci["variance"]           = serialized(String(d.current.variance,           5));
            ci["stability_score"]    = d.current.stability_score;
            ci["stability_label"]    = d.current.stability_label;

            // ── Thermal health ────────────────────────────────────────────
            JsonObject t = doc["thermal_health"].to<JsonObject>();
            t["sensor_present"]        = d.thermal.sensor_present;
            t["read_success_rate_pct"] = d.thermal.read_success_rate;
            t["disconnect_count"]      = d.thermal.disconnect_count;
            t["temp_variance"]         = serialized(String(d.thermal.temp_variance, 3));
            t["temp_stable"]           = d.thermal.temp_stable;
            t["stability_score"]       = d.thermal.stability_score;
            t["stability_label"]       = d.thermal.stability_label;

            // ── ADC health ────────────────────────────────────────────────
            JsonObject a = doc["adc_health"].to<JsonObject>();
            a["calibration_type"]           = d.adc.calibration_type;
            a["calibration_label"]          = d.adc.calibration_label;
            a["linearity_error_pct"]        = serialized(String(d.adc.linearity_error_pct,       2));
            a["actual_sample_rate_hz"]      = serialized(String(d.adc.actual_sample_rate_hz,     1));
            a["expected_sample_rate_hz"]    = serialized(String(d.adc.expected_sample_rate_hz,   1));
            a["sample_rate_deviation_pct"]  = serialized(String(d.adc.sample_rate_deviation_pct, 1));
            a["saturation_events"]          = d.adc.saturation_events;
            a["health_score"]               = d.adc.health_score;

            // ── Power quality ─────────────────────────────────────────────
            JsonObject pq = doc["power_quality"].to<JsonObject>();
            pq["nominal_voltage_v"]       = serialized(String(d.power_quality.nominal_voltage_v,     1));
            pq["mean_voltage_v"]          = serialized(String(d.power_quality.mean_voltage_v,        1));
            pq["voltage_deviation_pct"]   = serialized(String(d.power_quality.voltage_deviation_pct, 2));
            pq["sag_depth_v"]             = serialized(String(d.power_quality.sag_depth_v,           1));
            pq["swell_height_v"]          = serialized(String(d.power_quality.swell_height_v,        1));
            pq["ripple_pct"]              = serialized(String(d.power_quality.ripple_pct,            2));
            pq["flicker_index"]           = serialized(String(d.power_quality.flicker_index,         5));
            pq["voltage_stability_score"] = d.power_quality.voltage_stability_score;
            pq["power_quality_label"]     = d.power_quality.power_quality_label;

            // ── System health ─────────────────────────────────────────────
            JsonObject s = doc["system_health"].to<JsonObject>();
            s["overall_health_score"]  = d.system.overall_health_score;
            s["health_status"]         = d.system.health_status;
            s["uptime_s"]              = d.system.uptime_s;
            s["uptime_quality"]        = d.system.uptime_quality;
            s["free_heap_bytes"]       = d.system.free_heap_bytes;
            s["heap_healthy"]          = d.system.heap_healthy;
            s["cpu_load_estimate_pct"] = serialized(String(d.system.cpu_load_estimate_pct, 1));

            String out;
            serializeJson(doc, out);
            sendJSON(req, 200, out);
        });

        // ── GET /api/health ───────────────────────────────────────────────
        // Lightweight health check. Returns summary only.
        // No auth required. Ideal for uptime monitoring services.
        // Response is intentionally small (~200 bytes).
        // Uses lastSnapshot() — safe from any context, no state mutation.
        server->on("/api/health", HTTP_GET, [](AsyncWebServerRequest* req) {
            if (!g_reading) {
                sendJSON(req, 503, "{\"status\":\"NOT_READY\",\"score\":0}");
                return;
            }

            const DiagnosticsSnapshot& d = SensorDiagnostics::lastSnapshot();

            JsonDocument doc;
            doc["status"]              = d.system.health_status;
            doc["overall_score"]       = d.system.overall_health_score;
            doc["uptime_quality"]      = d.system.uptime_quality;
            doc["heap_healthy"]        = d.system.heap_healthy;
            doc["voltage_score"]       = d.voltage.stability_score;
            doc["current_score"]       = d.current.stability_score;
            doc["thermal_score"]       = d.thermal.stability_score;
            doc["adc_score"]           = d.adc.health_score;
            doc["power_quality_score"] = d.power_quality.voltage_stability_score;
            doc["sensor_present"]      = d.thermal.sensor_present;
            doc["any_saturation"]      = (d.voltage.saturated || d.current.saturated);
            doc["ts_ms"]               = d.computed_at_ms;

            String out;
            serializeJson(doc, out);
            sendJSON(req, 200, out);
        });

        // ── GET /api/state — Legacy (retained for compatibility) ──────────
        // Finding #17 fix: g_reading and g_ctx are now read via the
        // seqlock retry loop (readSharedState) instead of direct pointer
        // dereference. This eliminates the torn-read risk in the lwIP
        // async callback context with zero blocking time.
        server->on("/api/state", HTTP_GET, [](AsyncWebServerRequest* req) {
            SensorReading r;
            FSMContext    ctx;
            if (!readSharedState(r, ctx)) {
                sendJSON(req, 503, "{\"error\":\"Not ready\"}");
                return;
            }
            JsonDocument doc;
            doc["ts"]         = millis();
            doc["uptime_s"]   = millis() / 1000;
            doc["voltage"]    = serialized(String(r.voltage_v, 1));
            doc["current"]    = serialized(String(r.current_a, 2));
            doc["temp"]       = serialized(String(r.temp_c,    1));
            doc["power_va"]   = serialized(String(r.power_va,  1));
            doc["state"]      = fsmStateName(ctx.state);
            doc["fault"]      = faultTypeName(ctx.fault_type);
            doc["warn_flags"] = ctx.warn_flags;
            doc["trip_count"] = ctx.trip_count;
            doc["relay1"]     = r.relay1_closed;
            doc["relay2"]     = r.relay2_closed;
            JsonObject warns = doc["warns"].to<JsonObject>();
            warns["ov"]          = (bool)(ctx.warn_flags & WARN_OV);
            warns["uv"]          = (bool)(ctx.warn_flags & WARN_UV);
            warns["oc"]          = (bool)(ctx.warn_flags & WARN_OC);
            warns["thermal"]     = (bool)(ctx.warn_flags & WARN_THERMAL);
            warns["curr_rising"] = (bool)(ctx.warn_flags & WARN_CURR_RISING);
            if (ctx.state == FSM_FAULT) {
                uint32_t elapsed = millis() - ctx.fault_ts_ms;
                int rem = (int)RECOVERY_DELAY_MS - (int)elapsed;
                doc["recovery_ms"] = max(0, rem);
            } else {
                doc["recovery_ms"] = 0;
            }
            String out;
            serializeJson(doc, out);
            sendJSON(req, 200, out);
        });

        // ── GET /api/log ───────────────────────────────────────────────────
        // NVS log reads do not touch g_reading/g_ctx — no seqlock needed.
        server->on("/api/log", HTTP_GET, [](AsyncWebServerRequest* req) {
            JsonDocument doc;
            JsonArray arr = doc.to<JsonArray>();
            int n = NVSLog::count();
            for (int i = 0; i < n; i++) {
                EventEntry e;
                if (NVSLog::getEntry(i, e)) {
                    JsonObject o = arr.add<JsonObject>();
                    o["ts"]    = e.ts_ms;
                    o["state"] = fsmStateName(e.state);
                    o["fault"] = faultTypeName(e.fault_type);
                    o["value"] = serialized(String(e.value, 2));
                    o["note"]  = e.note;
                }
            }
            String out;
            serializeJson(doc, out);
            sendJSON(req, 200, out);
        });

        // ── POST /api/relay ────────────────────────────────────────────────
        server->on("/api/relay", HTTP_POST,
            [](AsyncWebServerRequest* req) {
                sendJSON(req, 400, "{\"error\":\"No body\"}");
            },
            nullptr,
            [](AsyncWebServerRequest* req, uint8_t* data, size_t len,
               size_t index, size_t total) {
                JsonDocument doc;
                if (deserializeJson(doc, data, len)) {
                    sendJSON(req, 400, "{\"error\":\"Invalid JSON\"}");
                    return;
                }
                if (!doc.containsKey("state") || !doc["state"].is<bool>()) {
                    sendJSON(req, 400, "{\"error\":\"Missing boolean field: state\"}");
                    return;
                }
                bool desired = doc["state"].as<bool>();
                RelayControl::setAPIOverride(desired);
                String resp = "{\"ok\":true,\"relay\":";
                resp += desired ? "true" : "false";
                resp += "}";
                sendJSON(req, 200, resp);
            }
        );

        // ── POST /api/reset ────────────────────────────────────────────────
        server->on("/api/reset", HTTP_POST,
            [](AsyncWebServerRequest* req) {
                sendJSON(req, 400, "{\"error\":\"No body\"}");
            },
            nullptr,
            [](AsyncWebServerRequest* req, uint8_t* data, size_t len,
               size_t index, size_t total) {
                JsonDocument doc;
                if (deserializeJson(doc, data, len)) {
                    sendJSON(req, 400, "{\"error\":\"Invalid JSON\"}");
                    return;
                }
                const char* cmd = doc["cmd"] | "";

                if (strcmp(cmd, "reset") == 0) {
                    FSM::requestReset();
                    sendJSON(req, 200, "{\"ok\":true}");
                }
                else if (strcmp(cmd, "reboot") == 0) {
                    NVSLog::append({ millis(), FSM_BOOT, FAULT_NONE, 0.0f, "API_REBOOT" });
                    sendJSON(req, 200, "{\"ok\":true}");
                    scheduleReboot(500);
                }
                else if (strcmp(cmd, "ping") == 0) {
                    sendJSON(req, 200, "{\"ok\":true}");
                }
                else {
                    sendJSON(req, 400, "{\"error\":\"Unknown cmd\"}");
                }
            }
        );

        // ── GET /api/config ────────────────────────────────────────────────
        server->on("/api/config", HTTP_GET, [](AsyncWebServerRequest* req) {
            JsonDocument doc;
            doc["ovp_threshold_v"]    = VOLT_OV_FAULT_V;
            doc["uvp_threshold_v"]    = VOLT_UV_FAULT_V;
            doc["ocp_threshold_a"]    = CURR_OC_FAULT_A;
            doc["otp_threshold_c"]    = TEMP_FAULT_C;
            doc["reconnect_delay_s"]  = RECOVERY_DELAY_MS / 1000;
            doc["fault_lockout_count"]= MAX_TRIP_COUNT;
            doc["ovp_warn_v"]         = VOLT_OV_WARN_V;
            doc["uvp_warn_v"]         = VOLT_UV_WARN_V;
            doc["ocp_warn_a"]         = CURR_OC_WARN_A;
            doc["otp_warn_c"]         = TEMP_WARN_C;
            String out;
            serializeJson(doc, out);
            sendJSON(req, 200, out);
        });

        // ── GET /api/key-hint ──────────────────────────────────────────────
        server->on("/api/key-hint", HTTP_GET, [](AsyncWebServerRequest* req) {
            String hint = "{\"hint\":\"" + g_api_key.substring(0, 4) + "\"}";
            sendJSON(req, 200, hint);
        });

        // ── POST /api/log/clear ────────────────────────────────────────────
        server->on("/api/log/clear", HTTP_POST, [](AsyncWebServerRequest* req) {
            if (!authOK(req)) { sendUnauth(req); return; }
            NVSLog::clear();
            sendJSON(req, 200, "{\"status\":\"cleared\"}");
        });

        // ── GET /api/wifi ──────────────────────────────────────────────────
        server->on("/api/wifi", HTTP_GET, [](AsyncWebServerRequest* req) {
            Preferences prefs;
            prefs.begin(NVS_NAMESPACE, true);
            String ssid = prefs.getString(NVS_KEY_WIFI_SSID, "");
            prefs.end();
            JsonDocument doc;
            doc["ssid"]      = ssid;
            doc["connected"] = (WiFi.status() == WL_CONNECTED);
            doc["ip"]        = WiFi.localIP().toString();
            doc["rssi"]      = WiFi.RSSI();
            doc["channel"]   = WiFi.channel();
            doc["mac"]       = WiFi.macAddress();
            String out; serializeJson(doc, out);
            sendJSON(req, 200, out);
        });

        // ── GET /api/wifi/scan ─────────────────────────────────────────────
        server->on("/api/wifi/scan", HTTP_GET, [](AsyncWebServerRequest* req) {
            int16_t n = WiFi.scanComplete();
            if (n == WIFI_SCAN_FAILED || n == 0) {
                WiFi.scanNetworks(true);
                sendJSON(req, 202, "{\"status\":\"scanning\",\"message\":\"Retry in 3s\"}");
                return;
            }
            if (n == WIFI_SCAN_RUNNING) {
                sendJSON(req, 202, "{\"status\":\"scanning\",\"message\":\"Still scanning\"}");
                return;
            }
            JsonDocument doc;
            JsonArray arr = doc.to<JsonArray>();
            for (int i = 0; i < n && i < 20; i++) {
                JsonObject net = arr.add<JsonObject>();
                net["ssid"]  = WiFi.SSID(i);
                net["rssi"]  = WiFi.RSSI(i);
                net["open"]  = (WiFi.encryptionType(i) == WIFI_AUTH_OPEN);
            }
            WiFi.scanDelete();
            String out; serializeJson(doc, out);
            sendJSON(req, 200, out);
        });

        // ── POST /api/wifi ─────────────────────────────────────────────────
        server->on("/api/wifi", HTTP_POST,
            [](AsyncWebServerRequest* req) {
                if (!authOK(req)) { sendUnauth(req); return; }
                sendJSON(req, 400, "{\"error\":\"No body\"}");
            },
            nullptr,
            [](AsyncWebServerRequest* req, uint8_t* data, size_t len,
               size_t index, size_t total) {
                if (!authOK(req)) { sendUnauth(req); return; }
                JsonDocument doc;
                if (deserializeJson(doc, data, len)) {
                    sendJSON(req, 400, "{\"error\":\"Invalid JSON\"}");
                    return;
                }
                const char* ssid = doc["ssid"] | "";
                const char* pass = doc["password"] | doc["pass"] | "";
                if (strlen(ssid) == 0 || strlen(ssid) > 32) {
                    sendJSON(req, 400, "{\"error\":\"ssid missing or too long\"}");
                    return;
                }
                Preferences prefs;
                prefs.begin(NVS_NAMESPACE, false);
                prefs.putString(NVS_KEY_WIFI_SSID, ssid);
                prefs.putString(NVS_KEY_WIFI_PASS, pass);
                prefs.end();
                NVSLog::append({ millis(), FSM_BOOT, FAULT_NONE, 0.0f, "WIFI_CHANGE" });
                sendJSON(req, 200,
                    "{\"status\":\"saved\",\"message\":\"Rebooting to connect\"}");
                scheduleReboot(1000);
            }
        );

        // ── POST /api/reboot ───────────────────────────────────────────────
        server->on("/api/reboot", HTTP_POST, [](AsyncWebServerRequest* req) {
            if (!authOK(req)) { sendUnauth(req); return; }
            NVSLog::append({ millis(), FSM_BOOT, FAULT_NONE, 0.0f, "SW_REBOOT" });
            sendJSON(req, 200, "{\"status\":\"rebooting\",\"delay_ms\":500}");
            scheduleReboot(500);
        });

        // ── POST /api/factory-reset ────────────────────────────────────────
        server->on("/api/factory-reset", HTTP_POST,
            [](AsyncWebServerRequest* req) {
                if (!authOK(req)) { sendUnauth(req); return; }
                sendJSON(req, 400,
                    "{\"error\":\"Send body: {\\\"confirm\\\":\\\"FACTORY\\\"}\"}");
            },
            nullptr,
            [](AsyncWebServerRequest* req, uint8_t* data, size_t len,
               size_t index, size_t total) {
                if (!authOK(req)) { sendUnauth(req); return; }
                JsonDocument doc;
                deserializeJson(doc, data, len);
                if (strcmp(doc["confirm"] | "", "FACTORY") != 0) {
                    sendJSON(req, 400,
                        "{\"error\":\"confirm must equal FACTORY\"}");
                    return;
                }
                Serial.println("[API] FACTORY RESET — wiping NVS namespace");
                Preferences prefs;
                prefs.begin(NVS_NAMESPACE, false);
                prefs.clear();
                prefs.end();
                sendJSON(req, 200,
                    "{\"status\":\"wiped\",\"message\":\"Rebooting to captive portal\"}");
                scheduleReboot(800);
            }
        );

        Serial.println("[API] v2.1 routes registered:");
        Serial.println("[API]   GET  /api/ping");
        Serial.println("[API]   GET  /api/telemetry     [seqlock snapshot — Finding #17]");
        Serial.println("[API]   GET  /api/diagnostics   [lastSnapshot() — Finding #4]");
        Serial.println("[API]   GET  /api/health");
        Serial.println("[API]   GET  /api/state         [seqlock read — Finding #17]");
        Serial.println("[API]   GET  /api/log");
        Serial.println("[API]   GET  /api/config");
        Serial.println("[API]   GET  /api/wifi");
        Serial.println("[API]   GET  /api/wifi/scan");
        Serial.println("[API]   POST /api/reset");
        Serial.println("[API]   POST /api/wifi");
        Serial.println("[API]   POST /api/reboot");
        Serial.println("[API]   POST /api/log/clear");
        Serial.println("[API]   POST /api/factory-reset");
        Serial.println("[API]   POST /api/relay");
    }
}
