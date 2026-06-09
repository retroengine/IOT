// ============================================================
//  wifi_manager.cpp — Clean rewrite
//
//  Flow:
//    1. WiFi.mode(WIFI_STA) + WiFi.begin(ssid, pass) from NVS
//    2. Wait 20 seconds for connection
//    3. Connected → start HTTP server → done
//    4. Failed    → switch to AP mode → start captive portal
//
//  The HTTP server (g_server) is started HERE, not in setup().
//  This guarantees it binds to a live network interface.
// ============================================================
#include "wifi_manager.h"
#include "config.h"
#include "serial_log.h"
#include <WiFi.h>
#include <ESPAsyncWebServer.h>
#include <Preferences.h>
#include <DNSServer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

namespace {
    volatile bool connected = false;
    char          ip_str[20] = "0.0.0.0";

    DNSServer        dns;
    AsyncWebServer*  sharedServer = nullptr;

    // ── Portal HTML ──────────────────────────────────────────────────────
    const char PORTAL_HTML[] PROGMEM = R"rawhtml(
<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SGS Setup</title>
<style>
  body{font-family:monospace;background:#0a0f18;color:#c8d8e8;display:flex;
       justify-content:center;align-items:center;min-height:100vh;margin:0}
  .box{background:#0f1620;border:1px solid #1e2d3d;border-radius:8px;
       padding:32px;width:320px}
  h2{color:#00d4ff;margin:0 0 24px}
  label{display:block;font-size:12px;color:#7a9ab5;margin-bottom:4px}
  input{width:100%;box-sizing:border-box;background:#111820;border:1px solid #243444;
        color:#c8d8e8;padding:8px;border-radius:4px;font-family:monospace;margin-bottom:16px}
  button{width:100%;background:#00d4ff;color:#070a0f;border:none;padding:10px;
         border-radius:4px;font-weight:700;cursor:pointer;font-family:monospace;font-size:14px}
  .note{font-size:11px;color:#3d5670;margin-top:16px;text-align:center}
</style></head><body>
<div class="box">
  <h2>SGS Wi-Fi Setup</h2>
  <form method="POST" action="/save">
    <label>Network SSID</label>
    <input name="ssid" placeholder="Your Wi-Fi name" required>
    <label>Password</label>
    <input name="pass" type="password" placeholder="Wi-Fi password">
    <button type="submit">SAVE &amp; CONNECT</button>
  </form>
  <p class="note">Device will reboot and connect. LED blinks on success.</p>
</div></body></html>
)rawhtml";

    const char SAVED_HTML[] PROGMEM = R"rawhtml(
<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="refresh" content="3;url=/">
<style>body{font-family:monospace;background:#0a0f18;color:#00ff9d;
display:flex;justify-content:center;align-items:center;min-height:100vh;font-size:18px}</style>
</head><body>Credentials saved — rebooting...</body></html>
)rawhtml";

    void reboot_task(void* pvParam) {
        vTaskDelay(pdMS_TO_TICKS(1500));
        ESP.restart();
        vTaskDelete(nullptr);
    }

    // ── Start HTTP server on the CURRENT live interface ───────────────────
    void startServer() {
        if (!sharedServer) return;
        sharedServer->begin();
        LOG_WIFI("HTTP server started on port 80");
    }

    // ── Captive Portal ───────────────────────────────────────────────────
    void startCaptivePortal() {
        Serial.println("\n[WiFi] ═══════════════════════════════════");
        Serial.println("[WiFi] Starting Captive Portal: SGS-Setup");
        Serial.println("[WiFi] Password: sgs-setup-1234");
        Serial.println("[WiFi] ═══════════════════════════════════\n");

        // Disconnect STA but keep NVS credentials intact for retry.
        WiFi.disconnect(true, false);
        WiFi.mode(WIFI_OFF);
        vTaskDelay(pdMS_TO_TICKS(200));

        // 2. Switch to clean AP mode
        WiFi.mode(WIFI_AP);
        vTaskDelay(pdMS_TO_TICKS(100));

        bool apOk = WiFi.softAP("SGS-Setup", "sgs-setup-1234");
        if (!apOk) {
            Serial.println("[WiFi] FATAL: softAP() failed!");
            return;
        }

        IPAddress apIP = WiFi.softAPIP();
        Serial.printf("[WiFi] AP running — IP: %s\n", apIP.toString().c_str());

        // 3. DNS: redirect ALL domains to us (captive portal detection)
        dns.start(53, "*", apIP);

        // 4. Register portal routes on the shared server
        AsyncWebServer* srv = sharedServer;
        if (!srv) {
            Serial.println("[WiFi] FATAL: no shared server pointer!");
            return;
        }

        srv->on("/", HTTP_GET, [](AsyncWebServerRequest* req) {
            req->send(200, "text/html", PORTAL_HTML);
        });

        // Android/iOS captive portal detection endpoints
        srv->on("/generate_204", HTTP_GET, [](AsyncWebServerRequest* req) {
            req->redirect("http://192.168.4.1/");
        });
        srv->on("/hotspot-detect.html", HTTP_GET, [](AsyncWebServerRequest* req) {
            req->redirect("http://192.168.4.1/");
        });
        srv->on("/connecttest.txt", HTTP_GET, [](AsyncWebServerRequest* req) {
            req->redirect("http://192.168.4.1/");
        });

        srv->onNotFound([](AsyncWebServerRequest* req) {
            req->redirect("http://192.168.4.1/");
        });

        srv->on("/save", HTTP_POST, [](AsyncWebServerRequest* req) {
            if (req->hasParam("ssid", true)) {
                String ssid = req->getParam("ssid", true)->value();
                String pass = req->hasParam("pass", true)
                              ? req->getParam("pass", true)->value() : "";

                Preferences p;
                p.begin(NVS_NAMESPACE, false);
                p.putString(NVS_KEY_WIFI_SSID, ssid);
                p.putString(NVS_KEY_WIFI_PASS, pass);
                p.end();

                Serial.printf("[WiFi] Saved: SSID=\"%s\"\n", ssid.c_str());
                req->send(200, "text/html", SAVED_HTML);
                xTaskCreate(reboot_task, "REBOOT", 1024, nullptr, 1, nullptr);
            } else {
                req->send(400, "text/plain", "Missing SSID");
            }
        });

        // 5. Start the server NOW — on the AP interface
        startServer();
        Serial.println("[WiFi] Portal LIVE → connect to 'SGS-Setup' and open 192.168.4.1");

        // 6. Block forever serving DNS
        while (true) {
            dns.processNextRequest();
            vTaskDelay(pdMS_TO_TICKS(10));
        }
    }

    // ── Main provisioning task ───────────────────────────────────────────
    void task_wifi_provision(void* pvParam) {
        vTaskDelay(pdMS_TO_TICKS(500));  // let other tasks start first

        // Read WiFi credentials from NVS. Falls back to captive portal
        // if no saved credentials exist (first-boot scenario).
        Preferences prefs;
        prefs.begin(NVS_NAMESPACE, true);  // read-only
        String nvs_ssid = prefs.getString(NVS_KEY_WIFI_SSID, "");
        String nvs_pass = prefs.getString(NVS_KEY_WIFI_PASS, "");
        prefs.end();

        const char* ssid;
        const char* pass;
        // Static buffers to hold NVS strings (String objects die after scope)
        static char ssid_buf[33] = {};
        static char pass_buf[65] = {};

        if (nvs_ssid.length() > 0) {
            strncpy(ssid_buf, nvs_ssid.c_str(), sizeof(ssid_buf) - 1);
            strncpy(pass_buf, nvs_pass.c_str(), sizeof(pass_buf) - 1);
            ssid = ssid_buf;
            pass = pass_buf;
            Serial.printf("[WiFi] Using NVS credentials: \"%s\"\n", ssid);
        } else {
            // No saved credentials — go straight to captive portal
            Serial.println("[WiFi] No NVS credentials — launching captive portal");
            startCaptivePortal();
            vTaskDelete(nullptr);
            return;
        }

        Serial.println("\n[WiFi] ═══════════════════════════════════");
        Serial.printf( "[WiFi] Attempting: \"%s\" (20s timeout)\n", ssid);
        Serial.println("[WiFi] ═══════════════════════════════════\n");

        // ── Step 1.5: Scan for visible networks ──────────────────────────
        WiFi.mode(WIFI_STA);
        WiFi.disconnect();
        vTaskDelay(pdMS_TO_TICKS(100));

        Serial.println("[WiFi] Scanning for networks...");
        int n = WiFi.scanNetworks();
        if (n == 0) {
            Serial.println("[WiFi] !! NO NETWORKS FOUND — is 2.4GHz enabled on router?");
        } else {
            Serial.printf("[WiFi] Found %d networks:\n", n);
            bool found = false;
            for (int i = 0; i < n; i++) {
                String name = WiFi.SSID(i);
                Serial.printf("[WiFi]   %d: %-32s  %ddBm  ch%d  %s\n",
                    i + 1,
                    name.c_str(),
                    WiFi.RSSI(i),
                    WiFi.channel(i),
                    WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "OPEN" : "SECURED");
                if (name == ssid) found = true;
            }
            if (!found) {
                Serial.printf("[WiFi] !! WARNING: \"%s\" NOT FOUND in scan results!\n", ssid);
                Serial.println("[WiFi] !! Check: exact spelling, 2.4GHz (not 5GHz), router powered on");
            }
        }
        WiFi.scanDelete();

        // ── Step 2: Connect ───────────────────────────────────────────────
        WiFi.setAutoReconnect(true);
        WiFi.begin(ssid, pass);

        uint32_t t0 = millis();
        int dots = 0;
        while (WiFi.status() != WL_CONNECTED && (millis() - t0) < 20000) {
            vTaskDelay(pdMS_TO_TICKS(500));
            Serial.print(".");
            dots++;
            if (dots % 20 == 0) {
                Serial.printf(" [status=%d, %lums]\n", WiFi.status(), millis() - t0);
            }
        }
        Serial.println();

        // ── Step 3: Evaluate ──────────────────────────────────────────────
        if (WiFi.status() == WL_CONNECTED) {
            connected = true;
            strncpy(ip_str, WiFi.localIP().toString().c_str(), sizeof(ip_str) - 1);
            ip_str[sizeof(ip_str) - 1] = '\0';

            Serial.println("\n========================================");
            Serial.println(" 🌐 NETWORK INTERFACE READY");
            Serial.printf( "    IP Address : %s\n", ip_str);
            Serial.printf( "    RSSI       : %d dBm\n", WiFi.RSSI());
            Serial.printf( "    Channel    : %d\n", WiFi.channel());
            Serial.println("========================================\n");

            // Start the HTTP server NOW — WiFi is live, port 80 will bind correctly
            startServer();

            vTaskDelete(nullptr);
            return;
        }

        // ── Step 4: Failed — dump diagnostics then portal ─────────────────
        Serial.println("\n[WiFi] !! CONNECTION FAILED !!");
        Serial.printf( "[WiFi] Last status code: %d\n", WiFi.status());
        Serial.println("[WiFi]   0=IDLE, 1=NO_SSID, 2=SCAN_DONE, 3=CONNECTED");
        Serial.println("[WiFi]   4=CONNECT_FAIL, 5=LOST, 6=DISCONNECTED");
        Serial.println("[WiFi] Falling back to captive portal...\n");

        startCaptivePortal();  // blocks forever
        vTaskDelete(nullptr);  // never reached
    }
}

namespace WiFiManager {

    void setServer(AsyncWebServer* server) {
        sharedServer = server;
    }

    void startProvisionTask() {
        xTaskCreatePinnedToCore(
            task_wifi_provision,
            "WIFI_PROV",
            8192,       // 8K stack — WiFi ops are stack-hungry on ESP32
            nullptr,
            2,          // Priority 2: below comms (3), above health (1)
            nullptr,
            1           // Core 1
        );
        LOG_WIFI("Provisioning task launched");
    }

    bool isConnected() { return connected; }

    const char* getIP() { return ip_str; }
}
