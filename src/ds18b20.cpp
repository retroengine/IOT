// ============================================================
//  ds18b20.cpp — Non-blocking 1-Wire temperature reading
//  Conversion triggered every TEMP_READ_INTERVAL_MS.
//  Reading collected 750 ms later (max DS18B20 conversion time).
// ============================================================
#include "ds18b20.h"
#include "config.h"
#include <OneWire.h>
#include <DallasTemperature.h>

namespace {
    OneWire         ow(PIN_DS18B20);
    DallasTemperature dt(&ow);

    float    last_temp   = -127.0f;
    bool     ready       = false;
    bool     converting  = false;
    uint32_t req_ts_ms   = 0;
    uint32_t last_req_ms = 0;
}

namespace DS18B20 {

    void init() {
        dt.begin();
        dt.setResolution(12);           // 12-bit → 0.0625°C, 750 ms conversion
        dt.setWaitForConversion(false); // non-blocking mode
        Serial.printf("[DS18B20] found %d device(s)\n", dt.getDeviceCount());
    }

    void tick() {
        uint32_t now = millis();

        // -- Read back if conversion is done (≥750 ms since request) --
        if (converting && (now - req_ts_ms >= 800)) {
            float t = dt.getTempCByIndex(0);
            if (t != DEVICE_DISCONNECTED_C && t != -127.0f) {
                last_temp = t;
                ready     = true;
            }
            converting = false;
        }

        // -- Trigger next conversion every TEMP_READ_INTERVAL_MS --
        if (!converting && (now - last_req_ms >= TEMP_READ_INTERVAL_MS)) {
            dt.requestTemperatures();
            req_ts_ms  = now;
            last_req_ms = now;
            converting  = true;
        }
    }

    float getTemp()  { return last_temp; }
    bool  isReady()  { return ready; }
}
