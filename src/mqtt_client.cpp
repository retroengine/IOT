// ============================================================
//  mqtt_client.cpp — MQTT Client v2.0 — HiveMQ Cloud / TLS
//
//  CHANGES FROM v1.0:
//    1. WiFiClient → WiFiClientSecure (TLS 1.2+)
//    2. CA certificate loaded from hivemq_cert.h (ISRG Root X1)
//    3. MQTT_SKIP_CERT_VERIFY flag for dev mode (config.h)
//    4. Username/password auth (HiveMQ Cloud requires this)
//    5. Port 8883 default (was 1883)
//    6. Command subscription: sgs/device/<id>/cmd
//       Handles: reset, reboot, ota (OTA URL injection — future)
//    7. TLS handshake diagnostics in connection status
//    8. Payload size still logged. Buffer still 2048.
//    9. MQTT connection state exposed for telemetry diagnostics
//
//  CREDENTIALS (fill in config.h):
//    MQTT_DEFAULT_HOST    your-cluster.s1.eu.hivemq.cloud
//    MQTT_DEFAULT_PORT    8883
//    MQTT_USERNAME        your-hivemq-username
//    MQTT_PASSWORD        your-hivemq-password
// ============================================================
#include "mqtt_client.h"
#include "telemetry_builder.h"
#include "fsm.h"
#include "config.h"
#include "hivemq_cert.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>

namespace {
    // ── TLS + MQTT clients ────────────────────────────────────────────────
    WiFiClientSecure  tlsClient;
    PubSubClient      mqtt(tlsClient);

    // ── Broker config ─────────────────────────────────────────────────────
    char   broker_host[64] = MQTT_DEFAULT_HOST;
    int    broker_port     = MQTT_DEFAULT_PORT;
    char   mqtt_user[64]   = MQTT_USERNAME;
    char   mqtt_pass[64]   = MQTT_PASSWORD;
    char   client_id[24]   = {};

    // ── Device-specific topics ─────────────────────────────────────────────
    char topic_telemetry[72] = {};   // sgs/device/<id>/telemetry
    char topic_fault[72]     = {};   // sgs/device/<id>/fault
    char topic_state[72]     = {};   // sgs/device/<id>/state
    char topic_cmd[72]       = {};   // sgs/device/<id>/cmd  (SUBSCRIBE)

    // ── Publish timing ────────────────────────────────────────────────────
    uint32_t last_pub_ms    = 0;
    FSMState last_fsm_state = FSM_BOOT;

    // ── Connection diagnostics ────────────────────────────────────────────
    uint32_t connect_attempts   = 0;
    uint32_t connect_successes  = 0;
    uint32_t publish_total      = 0;
    uint32_t publish_failed     = 0;
    uint32_t last_connect_ms    = 0;
    bool     tls_cert_verified  = false;

    // ── Reconnect backoff ─────────────────────────────────────────────────
    uint32_t last_reconnect_ms    = 0;
    uint32_t reconnect_backoff_ms = 5000;
    static constexpr uint32_t BACKOFF_MAX_MS = 60000;

    // ── Command handler ───────────────────────────────────────────────────
    // Called by PubSubClient when a message arrives on subscribed topic.
    // IMPORTANT: This executes in the MQTT client's loop() context.
    // Keep it short. No blocking I/O.
    void onMqttMessage(const char* topic, byte* payload, unsigned int length) {
        // Only handle our command topic
        if (strncmp(topic, topic_cmd, strlen(topic_cmd)) != 0) return;

        // Parse command JSON
        JsonDocument doc;
        DeserializationError err = deserializeJson(doc, payload, length);
        if (err) {
            Serial.printf("[MQTT] CMD: JSON parse error: %s\n", err.c_str());
            return;
        }

        const char* cmd = doc["cmd"] | "";
        Serial.printf("[MQTT] CMD received: %s\n", cmd);

        if (strcmp(cmd, "reset") == 0) {
            // Request FSM reset — same as POST /api/reset
            FSM::requestReset();
            Serial.println("[MQTT] CMD: FSM reset requested");
        }
        else if (strcmp(cmd, "reboot") == 0) {
            // Soft reboot with 2s delay
            Serial.println("[MQTT] CMD: Rebooting in 2s...");
            // Non-blocking: spawn a minimal task to reboot after delay
            xTaskCreate([](void*) {
                vTaskDelay(pdMS_TO_TICKS(2000));
                ESP.restart();
                vTaskDelete(nullptr);
            }, "MQTT_REBOOT", 1024, nullptr, 1, nullptr);
        }
        else if (strcmp(cmd, "ping") == 0) {
            // Respond with a status message on the state topic
            char pong[128];
            snprintf(pong, sizeof(pong),
                     "{\"pong\":true,\"uptime_s\":%lu,\"heap\":%lu}",
                     millis() / 1000, esp_get_free_heap_size());
            mqtt.publish(topic_state, pong);
            Serial.println("[MQTT] CMD: pong sent");
        }
        else {
            Serial.printf("[MQTT] CMD: Unknown command: %s\n", cmd);
        }
    }

    // ── TLS setup ─────────────────────────────────────────────────────────
    void configureTLS() {
#ifdef MQTT_SKIP_CERT_VERIFY
        // Development mode: skip certificate verification
        // NEVER use in production — MITM attacks are trivially possible
        tlsClient.setInsecure();
        tls_cert_verified = false;
        Serial.println("[MQTT] TLS: WARNING — cert verification DISABLED (dev mode)");
#else
        // Production mode: verify against CA certificate
        if (hivemqCertIsConfigured()) {
            tlsClient.setCACert(HIVEMQ_CA_CERT);
            tls_cert_verified = true;
            Serial.printf("[MQTT] TLS: CA cert loaded (%d bytes)\n",
                          strlen(HIVEMQ_CA_CERT));
        } else {
            // Cert not yet configured — fall back to insecure for first boot
            // User must add cert to hivemq_cert.h and reflash
            tlsClient.setInsecure();
            tls_cert_verified = false;
            Serial.println("[MQTT] TLS: WARNING — hivemq_cert.h not configured.");
            Serial.println("[MQTT] TLS: See docs/HIVEMQ_SETUP.md — falling back to insecure.");
        }
#endif
    }

    bool ensure_connected() {
        if (mqtt.connected()) {
            reconnect_backoff_ms = 5000;
            return true;
        }
        if (WiFi.status() != WL_CONNECTED) return false;

        uint32_t now = millis();
        if (now - last_reconnect_ms < reconnect_backoff_ms) return false;

        last_reconnect_ms = now;
        connect_attempts++;

        Serial.printf("[MQTT] Connecting to %s:%d as '%s' (attempt #%lu, backoff=%lums)\n",
                      broker_host, broker_port, mqtt_user,
                      connect_attempts, reconnect_backoff_ms);

        bool ok;
        if (strlen(mqtt_user) > 0) {
            ok = mqtt.connect(client_id, mqtt_user, mqtt_pass);
        } else {
            ok = mqtt.connect(client_id);
        }

        if (ok) {
            connect_successes++;
            last_connect_ms = now;
            Serial.printf("[MQTT] Connected. TLS verified=%d  successes=%lu/%lu\n",
                          tls_cert_verified, connect_successes, connect_attempts);

            // Subscribe to command topic on every (re)connect
            // QoS 1: at least once delivery for commands
            bool sub_ok = mqtt.subscribe(topic_cmd, 1);
            Serial.printf("[MQTT] Subscribed to %s — %s\n",
                          topic_cmd, sub_ok ? "OK" : "FAILED");

            reconnect_backoff_ms = 5000;
        } else {
            int rc = mqtt.state();
            Serial.printf("[MQTT] Connect FAILED rc=%d", rc);

            // Decode common error codes for easier debugging
            switch (rc) {
                case -4: Serial.print(" (TIMEOUT — check broker host/port)"); break;
                case -3: Serial.print(" (CONN_LOST)"); break;
                case -2: Serial.print(" (CONN_FAILED — TLS? firewall? wrong creds?)"); break;
                case -1: Serial.print(" (DISCONNECTED)"); break;
                case  1: Serial.print(" (UNACCEPTABLE_PROTOCOL)"); break;
                case  2: Serial.print(" (ID_REJECTED)"); break;
                case  3: Serial.print(" (SERVER_UNAVAILABLE)"); break;
                case  4: Serial.print(" (BAD_CREDENTIALS — check user/pass)"); break;
                case  5: Serial.print(" (UNAUTHORIZED — check ACL on HiveMQ)"); break;
            }
            Serial.println();

            reconnect_backoff_ms = min(reconnect_backoff_ms * 2, BACKOFF_MAX_MS);
        }
        return ok;
    }

    bool publish_safe(const char* topic, const char* payload) {
        bool ok = mqtt.publish(topic, payload, /* retained */ false);
        publish_total++;
        if (!ok) {
            publish_failed++;
            Serial.printf("[MQTT] Publish FAILED on %s (payload %d bytes, failed=%lu/%lu)\n",
                          topic, strlen(payload), publish_failed, publish_total);
        }
        return ok;
    }
}

namespace MQTTClient {

    void init() {
        // Load broker config from NVS (falls back to config.h defaults)
        Preferences prefs;
        prefs.begin(NVS_NAMESPACE, true);
        String host = prefs.getString(NVS_KEY_MQTT_HOST, MQTT_DEFAULT_HOST);
        broker_port  = prefs.getInt   (NVS_KEY_MQTT_PORT, MQTT_DEFAULT_PORT);
        String user  = prefs.getString(NVS_KEY_MQTT_USER, MQTT_USERNAME);
        String pass  = prefs.getString(NVS_KEY_MQTT_PASS, MQTT_PASSWORD);
        prefs.end();

        strncpy(broker_host, host.c_str(), sizeof(broker_host) - 1);
        strncpy(mqtt_user,   user.c_str(), sizeof(mqtt_user)   - 1);
        strncpy(mqtt_pass,   pass.c_str(), sizeof(mqtt_pass)   - 1);

        // Build client ID and device-specific topics from MAC
        uint8_t mac[6];
        WiFi.macAddress(mac);
        snprintf(client_id, sizeof(client_id),
                 "sgs-%02x%02x%02x", mac[3], mac[4], mac[5]);

        snprintf(topic_telemetry, sizeof(topic_telemetry),
                 "sgs/device/%s/telemetry", client_id);
        snprintf(topic_fault,     sizeof(topic_fault),
                 "sgs/device/%s/fault",     client_id);
        snprintf(topic_state,     sizeof(topic_state),
                 "sgs/device/%s/state",     client_id);
        snprintf(topic_cmd,       sizeof(topic_cmd),
                 "sgs/device/%s/cmd",       client_id);

        // Configure TLS before connecting
        configureTLS();

        // Configure MQTT client
        mqtt.setServer(broker_host, broker_port);
        mqtt.setKeepAlive(MQTT_KEEPALIVE);
        mqtt.setBufferSize(4096);
        mqtt.setCallback(onMqttMessage);

        // Increase socket timeout for TLS handshake
        // Default is 15s which is usually enough, but HiveMQ can be slow on first connect
        tlsClient.setTimeout(30);

        Serial.printf("[MQTT] init — broker=%s:%d  id=%s\n",
                      broker_host, broker_port, client_id);
        Serial.printf("[MQTT] telemetry topic: %s\n", topic_telemetry);
        Serial.printf("[MQTT] command topic:   %s\n", topic_cmd);
    }

    void tick(const SensorReading& r, const FSMContext& ctx) {
        // MUST call mqtt.loop() to process incoming messages (commands)
        // and maintain keepalive. Call even if not connected (handles reconnect).
        mqtt.loop();

        if (!ensure_connected()) return;

        uint32_t now = millis();

        // ── Structured telemetry every MQTT_PUB_INTERVAL_MS ──────────────
        if (now - last_pub_ms >= MQTT_PUB_INTERVAL_MS) {
            last_pub_ms = now;

            const char* payload = TelemetryBuilder::buildJSON(r, ctx);
            if (payload) {
                bool ok = publish_safe(topic_telemetry, payload);
                if (ok) {
                    Serial.printf("[MQTT] Telemetry published (%d bytes, total=%lu)\n",
                                  TelemetryBuilder::lastPayloadSize(), publish_total);
                }
            }
        }

        // ── State transition event — publish immediately ───────────────────
        if (ctx.state != last_fsm_state) {
            last_fsm_state = ctx.state;

            char evt_buf[256];
            JsonDocument doc;
            doc["ts"]    = now;
            doc["event"] = fsmStateName(ctx.state);
            doc["fault"] = faultTypeName(ctx.fault_type);
            doc["trips"] = ctx.trip_count;
            doc["v"]     = serialized(String(r.voltage_v, 1));
            doc["i"]     = serialized(String(r.current_a, 2));
            doc["t"]     = serialized(String(r.temp_c,    1));
            serializeJson(doc, evt_buf, sizeof(evt_buf));

            const char* evt_topic =
                (ctx.state == FSM_FAULT || ctx.state == FSM_LOCKOUT)
                ? topic_fault : topic_state;

            publish_safe(evt_topic, evt_buf);
        }
    }

    bool isConnected() { return mqtt.connected(); }

    // ── Diagnostic accessors (for telemetry_builder) ──────────────────────
    uint32_t getConnectAttempts()  { return connect_attempts; }
    uint32_t getConnectSuccesses() { return connect_successes; }
    uint32_t getPublishTotal()     { return publish_total; }
    uint32_t getPublishFailed()    { return publish_failed; }
    bool     isCertVerified()      { return tls_cert_verified; }
    uint32_t getLastConnectMs()    { return last_connect_ms; }
}
