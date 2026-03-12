#pragma once
// ============================================================
//  wifi_manager.h — Wi-Fi STA connection + captive portal fallback
// ============================================================

namespace WiFiManager {
    void        init();         // Connects or launches captive portal (blocks)
    bool        isConnected();
    const char* getIP();
}
