#pragma once
// ============================================================
//  wifi_manager.h — Wi-Fi STA connection + captive portal
//
//  Tier 1 fix — Finding #5: Captive Portal Blocks Protection Pipeline
//
//  PROBLEM (original):
//    WiFiManager::init() was called from setup() before any FreeRTOS
//    tasks were created. startCaptivePortal() contained an infinite
//    while(true) loop that never returns. If WiFi credentials were
//    absent or connection failed, task_protection was never launched.
//    The relay was never initialised. The grid line was completely
//    unprotected for the entire duration of the captive portal session.
//
//  FIX:
//    WiFi provisioning is fully decoupled from the protection pipeline.
//    setup() launches task_protection and task_comms unconditionally
//    first. WiFi init runs inside task_wifi_provision — a background
//    FreeRTOS task on Core 1. If WiFi fails and the captive portal
//    starts, it blocks only inside task_wifi_provision. Core 0 runs
//    the protection pipeline unaffected.
//
//  NEW API:
//    startProvisionTask() — creates task_wifi_provision and returns
//    immediately. Call from setup() AFTER launching protection tasks.
//
//    isConnected() / getIP() — safe to call from any task at any time.
//    Returns false / "0.0.0.0" until WiFi connects.
//
//  REMOVED:
//    init() — replaced by startProvisionTask(). The old init() blocked
//    setup() and must never be used again.
// ============================================================

namespace WiFiManager {
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
