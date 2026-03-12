// ============================================================
//  wifi_manager.cpp
//  1. Load SSID/pass from NVS (Preferences)
//  2. Attempt STA connection (30 s timeout)
//  3. On failure: start "SGS-Setup" AP + captive portal
//     POST /save → stores creds → reboots
// ============================================================
#include "wifi_manager.h"
#include "config.h"
#include <WiFi.h>
#include <ESPAsyncWebServer.h>
#include <Preferences.h>
#include <DNSServer.h>

namespace {
    bool        connected = false;
    char        ip_str[20] = "0.0.0.0";
    Preferences prefs;
    DNSServer   dns;
    AsyncWebServer portalServer(80);

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
                delay(1500);
                ESP.restart();
            } else {
                req->send(400, "text/plain", "Missing SSID");
            }
        });

        portalServer.begin();

        // Block here, serving captive portal
        while (true) {
            dns.processNextRequest();
            vTaskDelay(pdMS_TO_TICKS(10));
        }
    }
}

namespace WiFiManager {

    void init() {
        prefs.begin(NVS_NAMESPACE, true);
        String ssid = prefs.getString(NVS_KEY_WIFI_SSID, "");
        String pass = prefs.getString(NVS_KEY_WIFI_PASS, "");
        prefs.end();

        if (ssid.isEmpty()) {
            Serial.println("[WiFi] No credentials — starting provisioning");
            startCaptivePortal();  // does not return
            return;
        }

        Serial.printf("[WiFi] Connecting to \"%s\"...\n", ssid.c_str());
        WiFi.mode(WIFI_STA);
        WiFi.begin(ssid.c_str(), pass.c_str());

        uint32_t t0 = millis();
        while (WiFi.status() != WL_CONNECTED && (millis() - t0) < 30000) {
            delay(500);
            Serial.print(".");
        }
        Serial.println();

        if (WiFi.status() == WL_CONNECTED) {
            connected = true;
            strncpy(ip_str, WiFi.localIP().toString().c_str(), sizeof(ip_str));
            Serial.printf("[WiFi] Connected. IP: %s\n", ip_str);
        } else {
            Serial.println("[WiFi] Connection failed — starting provisioning");
            startCaptivePortal();  // does not return
        }
    }

    bool isConnected() { return connected; }
    const char* getIP() { return ip_str; }
}