#pragma once
// ============================================================
//  wifi_manager.h — Wi-Fi STA connection + captive portal
//
//  WiFi provisioning runs as a background FreeRTOS task on Core 1.
//  If connection fails, the captive portal starts — blocking only
//  the WiFi task. Core 0 runs protection unaffected.
//
//  API:
//    startProvisionTask() — launch WiFi task (call after protection tasks)
//    isConnected() / getIP() — safe to call from any task
// ============================================================

class AsyncWebServer;  // forward declaration — avoids #include in header

namespace WiFiManager {
    // Provide a pointer to the shared AsyncWebServer so captive portal
    // routes can be registered without a port-80 collision.
    void setServer(AsyncWebServer* server);

    // Launch WiFi provisioning as a background task on Core 1.
    // Returns immediately — never blocks setup().
    // Protection tasks must already be running before this is called.
    void startProvisionTask();

    // Returns true once STA connection is established.
    // Returns false during provisioning, captive portal, or connection failure.
    bool isConnected();

    // Returns the device IP as a C string, or "0.0.0.0" if not connected.
    const char* getIP();
}
