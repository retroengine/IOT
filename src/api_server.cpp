// ============================================================
//  api_server.cpp — ESPAsyncWebServer JSON REST API
//
//  Handlers read shared state via seqlock (no mutex blocking).
//  /api/diagnostics uses lastSnapshot() — no state mutation.
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
#include <freertos/portmacro.h>
#include <atomic>
#include <cstring>
#include <cmath>
#include "phantom_grid.h"

namespace {
    SensorReading*          g_reading  = nullptr;
    FSMContext*             g_ctx      = nullptr;
    String                  g_api_key;
    std::atomic<uint32_t>*  g_seqlock  = nullptr;

    // ── Seqlock snapshot helper ────────────────────────────────────────
    // Reads g_reading and g_ctx via seqlock retry loop.
    // Safe to call from the lwIP async context, zero blocking time.
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
        // Redundant: handled globally by DefaultHeaders in main.cpp.
        // Manual addition here causes duplicate headers and CORS policy violations.
    }

    bool authOK(AsyncWebServerRequest* req) {
        if (!req->hasHeader("X-API-Key")) return false;
        return req->getHeader("X-API-Key")->value() == g_api_key;
    }

    // rateLimitOK() uses a portMUX spinlock for ISR-safe token bucket.
    // ESPAsyncWebServer callbacks run on the lwIP task (single-threaded),
    // but WiFi event callbacks can preempt it.
    static portMUX_TYPE s_rate_mux = portMUX_INITIALIZER_UNLOCKED;

    bool rateLimitOK() {
        static uint32_t last_ts = 0;
        static int tokens = 30; // Max burst of 30 requests
        
        portENTER_CRITICAL(&s_rate_mux);

        uint32_t now = millis();
        
        // Refill 10 tokens per second (1 token per 100ms)
        if (now - last_ts >= 100) {
            int to_add = (now - last_ts) / 100;
            tokens += to_add;
            if (tokens > 30) tokens = 30;
            last_ts += to_add * 100;
        }
        
        bool ok = false;
        if (tokens > 0) {
            tokens--;
            ok = true;
        }

        portEXIT_CRITICAL(&s_rate_mux);
        return ok;
    }

    void sendRateLimited(AsyncWebServerRequest* req) {
        AsyncWebServerResponse* res = req->beginResponse(429,
            "application/json", "{\"error\":\"Too Many Requests\"}");
        res->addHeader("Retry-After", "1");
        addCORS(res);
        req->send(res);
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

    // Static buffer for /api/telemetry snapshot reads.
    // Safe because ESPAsyncWebServer's lwIP event loop is single-threaded.
    // If handlers are ever refactored to a thread pool, use a stack-local buffer.
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
        if (g_api_key.length() == 0) {
            g_api_key = generateApiKey();
            prefs.putString(NVS_KEY_API_KEY, g_api_key);
        }

        Serial.println("\n========================================");
        Serial.println(" 🔐 API AUTHENTICATION KEY");
        Serial.printf( "    KEY: %s****\n", g_api_key.substring(0, 4).c_str());
        Serial.println("    Full key shown once — save it now!");
        Serial.printf( "    FULL: %s\n", g_api_key.c_str());
        Serial.println("========================================\n");
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

        // Telemetry: reads pre-built snapshot — no blocking, no static buffer race.
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

        // Diagnostics: uses lastSnapshot() — read-only, no state mutation.
        server->on("/api/diagnostics", HTTP_GET, [](AsyncWebServerRequest* req) {
            if (!g_reading) {
                sendJSON(req, 503, "{\"error\":\"Not ready\"}");
                return;
            }

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

        // State: reads g_reading/g_ctx via seqlock — zero blocking time.
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
                int rem = (int)ctx.active_delay_ms - (int)elapsed;
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

        // Relay: authenticated, rate-limited.
        server->on("/api/relay", HTTP_POST,
            [](AsyncWebServerRequest* req) {
                if (!authOK(req)) { sendUnauth(req); return; }
                if (!rateLimitOK()) { sendRateLimited(req); return; }
                if (req->_tempObject) {
                    const char* msg = (const char*)req->_tempObject;
                    if (strstr(msg, "error")) sendJSON(req, 400, msg);
                    else sendJSON(req, 200, msg);
                    req->_tempObject = nullptr;
                } else {
                    sendJSON(req, 400, "{\"error\":\"No body\"}");
                }
            },
            nullptr,
            [](AsyncWebServerRequest* req, uint8_t* data, size_t len,
               size_t index, size_t total) {
                if (!authOK(req)) return;
                JsonDocument doc;
                if (deserializeJson(doc, data, len)) {
                    req->_tempObject = (void*)"{\"error\":\"Invalid JSON\"}";
                    return;
                }
                if (!doc["state"].is<bool>()) {
                    req->_tempObject = (void*)"{\"error\":\"Missing boolean field: state\"}";
                    return;
                }
                bool desired = doc["state"].as<bool>();
                RelayControl::setAPIOverride(desired);
                req->_tempObject = (void*)(desired ? "{\"ok\":true,\"relay\":true}" : "{\"ok\":true,\"relay\":false}");
            }
        );

        // ── POST /api/reset ────────────────────────────────────────────────
        server->on("/api/reset", HTTP_POST,
            [](AsyncWebServerRequest* req) {
                if (!authOK(req)) { sendUnauth(req); return; }
                if (!rateLimitOK()) { sendRateLimited(req); return; }
                if (req->_tempObject) {
                    const char* msg = (const char*)req->_tempObject;
                    if (strstr(msg, "error")) sendJSON(req, 400, msg);
                    else {
                        sendJSON(req, 200, msg);
                        if (strstr(msg, "reboot")) scheduleReboot(500);
                    }
                    req->_tempObject = nullptr;
                } else {
                    sendJSON(req, 400, "{\"error\":\"No body\"}");
                }
            },
            nullptr,
            [](AsyncWebServerRequest* req, uint8_t* data, size_t len,
               size_t index, size_t total) {
                if (!authOK(req)) return;
                JsonDocument doc;
                if (deserializeJson(doc, data, len)) {
                    req->_tempObject = (void*)"{\"error\":\"Invalid JSON\"}";
                    return;
                }
                const char* cmd = doc["cmd"] | "";

                if (strcmp(cmd, "reset") == 0) {
                    FSM::requestReset();
                    req->_tempObject = (void*)"{\"ok\":true,\"cmd\":\"reset\"}";
                }
                else if (strcmp(cmd, "reboot") == 0) {
                    NVSLog::append({ millis(), FSM_BOOT, FAULT_NONE, 0.0f, "API_REBOOT" });
                    req->_tempObject = (void*)"{\"ok\":true,\"cmd\":\"reboot\"}";
                }
                else if (strcmp(cmd, "ping") == 0) {
                    req->_tempObject = (void*)"{\"ok\":true}";
                }
                else {
                    req->_tempObject = (void*)"{\"error\":\"Unknown cmd\"}";
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
            if (!rateLimitOK()) { sendRateLimited(req); return; }
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

        // WiFi scan: authenticated to prevent SSID enumeration.
        server->on("/api/wifi/scan", HTTP_GET, [](AsyncWebServerRequest* req) {
            if (!authOK(req)) { sendUnauth(req); return; }
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
                if (req->_tempObject) {
                    const char* msg = (const char*)req->_tempObject;
                    if (strstr(msg, "error")) sendJSON(req, 400, msg);
                    else {
                        sendJSON(req, 200, msg);
                        scheduleReboot(1000);
                    }
                    req->_tempObject = nullptr;
                } else {
                    sendJSON(req, 400, "{\"error\":\"No body\"}");
                }
            },
            nullptr,
            [](AsyncWebServerRequest* req, uint8_t* data, size_t len,
               size_t index, size_t total) {
                if (!authOK(req)) return;
                JsonDocument doc;
                if (deserializeJson(doc, data, len)) {
                    req->_tempObject = (void*)"{\"error\":\"Invalid JSON\"}";
                    return;
                }
                const char* ssid = doc["ssid"] | "";
                const char* pass = doc["password"] | doc["pass"] | "";
                if (strlen(ssid) == 0 || strlen(ssid) > 32) {
                    req->_tempObject = (void*)"{\"error\":\"ssid missing or too long\"}";
                    return;
                }
                Preferences prefs;
                prefs.begin(NVS_NAMESPACE, false);
                prefs.putString(NVS_KEY_WIFI_SSID, ssid);
                prefs.putString(NVS_KEY_WIFI_PASS, pass);
                prefs.end();
                NVSLog::append({ millis(), FSM_BOOT, FAULT_NONE, 0.0f, "WIFI_CHANGE" });
                req->_tempObject = (void*)"{\"status\":\"saved\",\"message\":\"Rebooting to connect\"}";
            }
        );

        // ── POST /api/reboot ───────────────────────────────────────────────
        server->on("/api/reboot", HTTP_POST, [](AsyncWebServerRequest* req) {
            if (!authOK(req)) { sendUnauth(req); return; }
            if (!rateLimitOK()) { sendRateLimited(req); return; }
            NVSLog::append({ millis(), FSM_BOOT, FAULT_NONE, 0.0f, "SW_REBOOT" });
            sendJSON(req, 200, "{\"status\":\"rebooting\",\"delay_ms\":500}");
            scheduleReboot(500);
        });

        // ── POST /api/factory-reset ────────────────────────────────────────
        server->on("/api/factory-reset", HTTP_POST,
            [](AsyncWebServerRequest* req) {
                if (!authOK(req)) { sendUnauth(req); return; }
                if (!rateLimitOK()) { sendRateLimited(req); return; }
                if (req->_tempObject) {
                    const char* msg = (const char*)req->_tempObject;
                    if (strstr(msg, "error")) sendJSON(req, 400, msg);
                    else {
                        sendJSON(req, 200, msg);
                        scheduleReboot(800);
                    }
                    req->_tempObject = nullptr;
                } else {
                    sendJSON(req, 400, "{\"error\":\"Send body: {\\\"confirm\\\":\\\"FACTORY\\\"}\"}");
                }
            },
            nullptr,
            [](AsyncWebServerRequest* req, uint8_t* data, size_t len,
               size_t index, size_t total) {
                if (!authOK(req)) return;
                JsonDocument doc;
                deserializeJson(doc, data, len);
                if (strcmp(doc["confirm"] | "", "FACTORY") != 0) {
                    req->_tempObject = (void*)"{\"error\":\"confirm must equal FACTORY\"}";
                    return;
                }
                Serial.println("[API] FACTORY RESET — wiping NVS namespace");
                Preferences prefs;
                prefs.begin(NVS_NAMESPACE, false);
                prefs.clear();
                prefs.end();
                req->_tempObject = (void*)"{\"status\":\"wiped\",\"message\":\"Rebooting to captive portal\"}";
            }
        );

        // ── POST /api/inject ───────────────────────────────────────────────
        server->on("/api/inject", HTTP_POST,
            [](AsyncWebServerRequest* req) {
                if (!authOK(req)) { sendUnauth(req); return; }
                if (!rateLimitOK()) { sendRateLimited(req); return; }
                if (req->_tempObject) {
                    const char* msg = (const char*)req->_tempObject;
                    if (strstr(msg, "error")) sendJSON(req, 400, msg);
                    else sendJSON(req, 200, msg);
                    req->_tempObject = nullptr;
                } else {
                    sendJSON(req, 400, "{\"error\":\"No body\"}");
                }
            },
            nullptr,
            [](AsyncWebServerRequest* req, uint8_t* data, size_t len,
               size_t index, size_t total) {
                if (!authOK(req)) return;
                
                // ── ZERO ALLOCATION MANUAL PARSING ──
                char buf[128];
                size_t clen = len < 127 ? len : 127;
                memcpy(buf, data, clen);
                buf[clen] = '\0';
                
                const char* cmd_loc = strstr(buf, "\"cmd\"");
                const char* v_loc = strstr(buf, "\"voltage\"");
                const char* i_loc = strstr(buf, "\"current\"");

                if (!cmd_loc && !v_loc) {
                    req->_tempObject = (void*)"{\"error\":\"Missing cmd or voltage field\"}";
                    return;
                }
                
                float p1 = 0.0f;
                float p2 = 0.0f;
                const char* p1_loc;
                const char* p2_loc;

                // Null-check cmd_loc before dereferencing to prevent crashes
                // on payloads like {"voltage":230,"current":5}.
                if (!cmd_loc && v_loc && i_loc) {
                    const char* c1 = strchr(v_loc, ':');
                    if (c1) p1 = atof(c1 + 1);
                    const char* c2 = strchr(i_loc, ':');
                    if (c2) p2 = atof(c2 + 1);
                    g_sil_param1.store(p1, std::memory_order_relaxed);
                    g_sil_param2.store(p2, std::memory_order_relaxed);
                    g_sil_cmd.store(SilCommand::CUSTOM_LOAD, std::memory_order_release);
                    NVSLog::append({ (uint32_t)millis(), FSM_NORMAL, FAULT_NONE, 0.0f, "SIL_CMD:CUSTOM" });
                    req->_tempObject = (void*)"{\"status\":\"Custom load applied\"}";
                }
                else if (cmd_loc && strstr(cmd_loc, "\"normal_grid\"")) {
                    g_sil_cmd.store(SilCommand::NORMAL_GRID, std::memory_order_release);
                    NVSLog::append({ (uint32_t)millis(), FSM_NORMAL, FAULT_NONE, 0.0f, "SIL_CMD:NORMAL" });
                    req->_tempObject = (void*)"{\"status\":\"Restored nominal grid\"}";
                }
                else if (cmd_loc && strstr(cmd_loc, "\"motor_start\"")) {
                    g_sil_cmd.store(SilCommand::MOTOR_START, std::memory_order_release);
                    NVSLog::append({ (uint32_t)millis(), FSM_NORMAL, FAULT_NONE, 0.0f, "SIL_CMD:MTR_START" });
                    req->_tempObject = (void*)"{\"status\":\"Motor inrush triggered\"}";
                }
                else if (cmd_loc && strstr(cmd_loc, "\"motor_stop\"")) {
                    g_sil_cmd.store(SilCommand::MOTOR_STOP, std::memory_order_release);
                    NVSLog::append({ (uint32_t)millis(), FSM_NORMAL, FAULT_NONE, 0.0f, "SIL_CMD:MTR_STOP" });
                    req->_tempObject = (void*)"{\"status\":\"Motor stopped\"}";
                }
                else if (cmd_loc && strstr(cmd_loc, "\"sag\"")) {
                    p1_loc = strstr(buf, "\"depth\"");
                    p2_loc = strstr(buf, "\"duration\"");
                    if (p1_loc) { const char* c = strchr(p1_loc, ':'); if (c) p1 = atof(c + 1); }
                    if (p2_loc) { const char* c = strchr(p2_loc, ':'); if (c) p2 = atof(c + 1); }
                    g_sil_param1.store(p1, std::memory_order_relaxed);
                    g_sil_param2.store(p2, std::memory_order_relaxed);
                    g_sil_cmd.store(SilCommand::TRIGGER_SAG, std::memory_order_release);
                    NVSLog::append({ (uint32_t)millis(), FSM_NORMAL, FAULT_NONE, 0.0f, "SIL_CMD:SAG" });
                    req->_tempObject = (void*)"{\"status\":\"Voltage sag triggered\"}";
                }
                else if (cmd_loc && strstr(cmd_loc, "\"swell\"")) {
                    p1_loc = strstr(buf, "\"height\"");
                    p2_loc = strstr(buf, "\"duration\"");
                    if (p1_loc) { const char* c = strchr(p1_loc, ':'); if (c) p1 = atof(c + 1); }
                    if (p2_loc) { const char* c = strchr(p2_loc, ':'); if (c) p2 = atof(c + 1); }
                    g_sil_param1.store(p1, std::memory_order_relaxed);
                    g_sil_param2.store(p2, std::memory_order_relaxed);
                    g_sil_cmd.store(SilCommand::TRIGGER_SWELL, std::memory_order_release);
                    NVSLog::append({ (uint32_t)millis(), FSM_NORMAL, FAULT_NONE, 0.0f, "SIL_CMD:SWELL" });
                    req->_tempObject = (void*)"{\"status\":\"Voltage swell triggered\"}";
                }
                else if (cmd_loc && strstr(cmd_loc, "\"flicker_on\"")) {
                    g_sil_cmd.store(SilCommand::ENABLE_FLICKER, std::memory_order_release);
                    NVSLog::append({ (uint32_t)millis(), FSM_NORMAL, FAULT_NONE, 0.0f, "SIL_CMD:FLCKR_ON" });
                    req->_tempObject = (void*)"{\"status\":\"Flicker enabled\"}";
                }
                else if (cmd_loc && strstr(cmd_loc, "\"flicker_off\"")) {
                    g_sil_cmd.store(SilCommand::DISABLE_FLICKER, std::memory_order_release);
                    NVSLog::append({ (uint32_t)millis(), FSM_NORMAL, FAULT_NONE, 0.0f, "SIL_CMD:FLCKR_OFF" });
                    req->_tempObject = (void*)"{\"status\":\"Flicker disabled\"}";
                }
                else if (cmd_loc && strstr(cmd_loc, "\"disable\"")) {
                    g_sil_cmd.store(SilCommand::DISABLE_SIMULATION, std::memory_order_release);
                    NVSLog::append({ (uint32_t)millis(), FSM_NORMAL, FAULT_NONE, 0.0f, "SIL_CMD:DISABLE" });
                    req->_tempObject = (void*)"{\"status\":\"Hardware ADC restored\"}";
                }
                else {
                    req->_tempObject = (void*)"{\"error\":\"Unknown or missing cmd mapping\"}";
                }
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
        Serial.println("[API]   POST /api/inject");
    }
}
