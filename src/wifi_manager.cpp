// ============================================================
//  wifi_manager.cpp
//
//  Tier 1 fix — Finding #5: Captive Portal Blocks Protection Pipeline
//  Tier 1 fix — Finding #16: delay() Inside ESPAsyncWebServer Callback
//
//  FINDING #5 FIX:
//    The original code called startCaptivePortal() from setup() inside
//    WiFiManager::init(). startCaptivePortal() contained an infinite
//    while(true) loop that never returned, meaning task_protection was
//    never created if WiFi failed. The relay was never armed.
//
//    Correct architecture (per IEC 60255-1 independence of protection
//    from communication, and the SGS Engineering Roadmap Tier 1):
//      - setup() launches task_protection (Core 0) and task_comms
//        (Core 1) unconditionally, with no dependency on WiFi state.
//      - WiFi init runs inside task_wifi_provision, a new FreeRTOS
//        task on Core 1. The infinite captive portal loop now blocks
//        only inside this task — Core 0 is completely unaffected.
//      - Protection starts within 100ms of boot regardless of WiFi.
//
//  FINDING #16 FIX:
//    The /save POST handler used delay(1500) + ESP.restart() inside
//    an ESPAsyncWebServer callback. delay() blocks the entire lwIP
//    event loop for 1.5 seconds — dropping TCP frames, collapsing
//    WebSocket connections, and risking TWDT panic.
//    Fix: replaced with a minimal FreeRTOS task (reboot_task) that
//    does vTaskDelay(1500ms) then ESP.restart(), identical to the
//    scheduleReboot() pattern in api_server.cpp.
//
//  UNCHANGED:
//    - WiFi STA connection sequence (30s timeout)
//    - NVS credential storage (Preferences namespace "sgs")
//    - Captive portal HTML, DNS redirect, /save POST handler logic
//    - AP SSID "SGS-Setup"
//    - isConnected() / getIP() public API semantics
// ============================================================
#include "wifi_manager.h"
#include "config.h"
#include <WiFi.h>
#include <ESPAsyncWebServer.h>
#include <Preferences.h>
#include <DNSServer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

namespace {
    // ── Shared state (written by task_wifi_provision, read by any task) ──
    // volatile is sufficient here: single writer, multiple readers,
    // no struct torn-read risk (bool and char[] are independent fields).
    volatile bool connected = false;
    char          ip_str[20] = "0.0.0.0";

    // ── Captive portal server (lives for the duration of provisioning) ────
    Preferences      prefs;
    DNSServer        dns;
    AsyncWebServer   portalServer(80);

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

    // ── Finding #16: reboot task replaces delay() + ESP.restart() ─────────
    // Spawned from the /save POST handler. vTaskDelay yields the lwIP event
    // loop immediately; the restart fires 1500ms later from RTOS task context.
    void reboot_task(void* pvParam) {
        vTaskDelay(pdMS_TO_TICKS(1500));
        ESP.restart();
        vTaskDelete(nullptr); // never reached
    }

    // ── Captive portal ─────────────────────────────────────────────────────
    // Called from inside task_wifi_provision. Blocks in an event loop
    // serving the provisioning UI. Safe here because this is a dedicated
    // FreeRTOS task — blocking it does NOT affect task_protection on Core 0.
    void startCaptivePortal() {
        Serial.println("[WiFi] Starting captive portal AP: SGS-Setup");
        WiFi.softAP("SGS-Setup", "sgs-setup-1234");
        dns.start(53, "*", WiFi.softAPIP());

        portalServer.on("/", HTTP_GET, [](AsyncWebServerRequest* req) {
            req->send(200, "text/html", PORTAL_HTML);
        });

        // Catch-all redirect for captive portal detection
        portalServer.onNotFound([](AsyncWebServerRequest* req) {
            req->redirect("http://192.168.4.1/");
        });

        portalServer.on("/save", HTTP_POST, [](AsyncWebServerRequest* req) {
            if (req->hasParam("ssid", true)) {
                String ssid = req->getParam("ssid", true)->value();
                String pass = req->hasParam("pass", true)
                              ? req->getParam("pass", true)->value() : "";

                Preferences p;
                p.begin(NVS_NAMESPACE, false);
                p.putString(NVS_KEY_WIFI_SSID, ssid);
                p.putString(NVS_KEY_WIFI_PASS, pass);
                p.end();

                req->send(200, "text/html", SAVED_HTML);

                // Finding #16 fix: spawn reboot task instead of delay()+restart().
                // delay() inside an AsyncWebServer callback blocks the lwIP event
                // loop — dropping frames and risking TWDT panic. The reboot task
                // yields the CPU immediately and restarts 1500ms later.
                xTaskCreate(reboot_task, "REBOOT", 1024, nullptr, 1, nullptr);
            } else {
                req->send(400, "text/plain", "Missing SSID");
            }
        });

        portalServer.begin();

        // Block here serving the captive portal.
        // This is now safe — we are inside task_wifi_provision, not setup().
        // Core 0 runs task_protection unaffected.
        while (true) {
            dns.processNextRequest();
            vTaskDelay(pdMS_TO_TICKS(10));
        }
    }

    // ── WiFi provisioning task ─────────────────────────────────────────────
    // Runs on Core 1 as a background task. Attempts STA connection, falls
    // back to captive portal on failure. Never returns or blocks setup().
    void task_wifi_provision(void* pvParam) {
        // Read stored credentials
        prefs.begin(NVS_NAMESPACE, true);
        String ssid = prefs.getString(NVS_KEY_WIFI_SSID, "");
        String pass = prefs.getString(NVS_KEY_WIFI_PASS, "");
        prefs.end();

        if (ssid.isEmpty()) {
            Serial.println("[WiFi] No credentials — starting provisioning");
            startCaptivePortal(); // blocks forever inside this task
            vTaskDelete(nullptr); // never reached
            return;
        }

        Serial.printf("[WiFi] Connecting to \"%s\"...\n", ssid.c_str());
        WiFi.mode(WIFI_STA);
        WiFi.begin(ssid.c_str(), pass.c_str());

        uint32_t t0 = millis();
        while (WiFi.status() != WL_CONNECTED && (millis() - t0) < 30000) {
            vTaskDelay(pdMS_TO_TICKS(500)); // yield — don't use delay() in RTOS tasks
            Serial.print(".");
        }
        Serial.println();

        if (WiFi.status() == WL_CONNECTED) {
            connected = true;
            strncpy(ip_str, WiFi.localIP().toString().c_str(), sizeof(ip_str) - 1);
            ip_str[sizeof(ip_str) - 1] = '\0';
            Serial.printf("[WiFi] Connected. IP: %s\n", ip_str);
        } else {
            Serial.println("[WiFi] Connection failed — starting provisioning");
            startCaptivePortal(); // blocks forever inside this task
        }

        vTaskDelete(nullptr); // clean up if we somehow exit (should not happen)
    }
}

namespace WiFiManager {

    // Launch WiFi provisioning as a background task on Core 1.
    // Returns immediately. task_protection must already be running.
    void startProvisionTask() {
        xTaskCreatePinnedToCore(
            task_wifi_provision,
            "WIFI_PROV",
            4096,       // 4K stack: enough for WiFi.begin() + DNS + portal server
            nullptr,
            2,          // Priority 2: below comms (3), above health (1)
            nullptr,
            1           // Core 1: same as task_comms, away from protection Core 0
        );
        Serial.println("[WiFi] Provisioning task launched (background)");
    }

    bool isConnected() { return connected; }

    const char* getIP() { return ip_str; }
}
