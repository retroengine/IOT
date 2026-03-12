// ============================================================
//  ds18b20.cpp — DS18B20 1-Wire Temperature Sensor
//  REVISION: 2.0 — Full Sentinel Handling
//
//  CHANGES FROM v1.0:
//
//  1. BOOT SENTINEL FILTER (EC-04)
//     DS18B20 scratchpad initialises to exactly +85.0°C on power-up.
//     This value persists until the first 12-bit conversion completes
//     (~750ms). Any firmware reading the sensor before this window
//     will receive 85.0°C and falsely trigger a thermal fault.
//     FIX: boot_ts_ms set in init(). Any reading of exactly 85.0°C
//     within DS18B20_BOOT_IGNORE_MS of init() is silently discarded.
//     After the boot window, 85.0°C is a legitimate hot reading and
//     IS processed normally (it is a real thermal fault condition).
//
//  2. DISCONNECT SENTINEL HANDLING (EC-05)
//     DallasTemperature returns DEVICE_DISCONNECTED_C (-127.0°C) when:
//       - 1-Wire bus is shorted to GND
//       - Sensor physically unplugged
//       - Bus pullup resistor missing/open
//     This is NOT a temperature. Operating without thermal protection
//     in a high-power environment invites fire hazard.
//     FIX: Any -127.0°C reading sets sensor_disconnected = true.
//     FSM::tick() polls isDisconnected() and immediately transitions
//     to LOCKOUT from ANY state. LOCKOUT persists until sensor is
//     physically reconnected AND isDisconnected() returns false.
//
//  3. RECONNECTION DETECTION
//     After a disconnect, the sensor may be re-plugged while system
//     is in LOCKOUT. The firmware detects reconnection when a valid
//     reading returns after the disconnect event. It sets a
//     reconnected flag so the FSM can log the event. Reconnection
//     does NOT automatically clear LOCKOUT — manual API reset is
//     still required (safety by design).
//
//  4. READING VALIDITY TRACKING
//     Tracks consecutive valid reads for confidence calculation.
//     Exposes isReady() only when at least one valid conversion
//     has completed AND sensor is not in disconnect state.
//
//  PRESERVED FROM v1.0:
//     - Non-blocking conversion (setWaitForConversion false)
//     - 12-bit resolution (0.0625°C, 750ms conversion)
//     - Periodic conversion triggering via TEMP_READ_INTERVAL_MS
//     - getTemp() / isReady() public API (unchanged)
// ============================================================
#include "ds18b20.h"
#include "config.h"
#include <OneWire.h>
#include <DallasTemperature.h>

namespace {
    OneWire           ow(PIN_DS18B20);
    DallasTemperature dt(&ow);

    // ── Core state ────────────────────────────────────────────────────────
    float    last_valid_temp  = 25.0f;  // last known-good temperature
    bool     ready            = false;  // true after first valid conversion
    bool     converting       = false;
    uint32_t req_ts_ms        = 0;
    uint32_t last_req_ms      = 0;

    // ── Boot sentinel window (EC-04) ──────────────────────────────────────
    uint32_t boot_ts_ms       = 0;      // set in init()
    bool     boot_window_done = false;  // set true once window expires

    // ── Disconnect tracking (EC-05) ───────────────────────────────────────
    bool     sensor_disconnected = false;   // true when -127°C received
    bool     sensor_reconnected  = false;   // pulsed true on reconnection
    uint32_t disconnect_count    = 0;       // lifetime disconnect events
    uint32_t disconnect_ts_ms    = 0;       // timestamp of last disconnect

    // ── Validity counters ─────────────────────────────────────────────────
    uint32_t total_reads    = 0;
    uint32_t valid_reads    = 0;

    // ─────────────────────────────────────────────────────────────────────
    //  Classify a raw DS18B20 reading into one of four states:
    //
    //  STATE_BOOT_SENTINEL  : reading is exactly 85.0°C AND we are within
    //                         the boot ignore window → discard silently
    //  STATE_DISCONNECTED   : reading is -127.0°C → LOCKOUT signal
    //  STATE_INVALID_RANGE  : reading is physically impossible for an
    //                         enclosure monitor (below -40°C or above 125°C
    //                         which is the DS18B20's rated range)
    //  STATE_VALID          : reading is a real temperature
    //
    enum ReadState {
        STATE_VALID,
        STATE_BOOT_SENTINEL,
        STATE_DISCONNECTED,
        STATE_INVALID_RANGE
    };

    ReadState classify(float t) {
        // -127.0°C is the library disconnect sentinel
        if (t <= DS18B20_SENTINEL_DISC + 1.0f) return STATE_DISCONNECTED;

        // +85.0°C is the power-on default — ignore during boot window only
        if (!boot_window_done && fabsf(t - DS18B20_SENTINEL_HOT) < 0.1f) {
            return STATE_BOOT_SENTINEL;
        }

        // DS18B20 rated range is -55°C to +125°C
        // Enclosure monitor: physically implausible below -40°C
        if (t < -40.0f || t > 125.0f) return STATE_INVALID_RANGE;

        return STATE_VALID;
    }
}

namespace DS18B20 {

    void init() {
        boot_ts_ms    = millis();
        boot_window_done = false;

        dt.begin();
        dt.setResolution(12);           // 12-bit → 0.0625°C, 750ms conversion
        dt.setWaitForConversion(false); // non-blocking — never stall protection task

        int found = dt.getDeviceCount();
        Serial.printf("[DS18B20] init — found %d device(s)\n", found);
        Serial.printf("[DS18B20] boot sentinel window: %dms (ignoring +85°C until %lums)\n",
                      DS18B20_BOOT_IGNORE_MS, boot_ts_ms + DS18B20_BOOT_IGNORE_MS);

        if (found == 0) {
            // No sensor on bus at boot — treat as disconnected immediately
            sensor_disconnected = true;
            disconnect_count++;
            Serial.println("[DS18B20] WARNING: No sensor found at init — LOCKOUT will be triggered");
        }
    }

    void tick() {
        uint32_t now = millis();

        // ── Update boot window flag ────────────────────────────────────────
        if (!boot_window_done && (now - boot_ts_ms >= DS18B20_BOOT_IGNORE_MS)) {
            boot_window_done = true;
            Serial.println("[DS18B20] boot sentinel window expired — +85°C now treated as real reading");
        }

        // ── Read back if conversion is done (≥800ms since request) ────────
        // 800ms > 750ms max conversion time at 12-bit resolution
        if (converting && (now - req_ts_ms >= 800)) {
            float t = dt.getTempCByIndex(0);
            converting = false;
            total_reads++;

            ReadState rs = classify(t);

            switch (rs) {

                case STATE_VALID:
                    // ── Good reading ────────────────────────────────────
                    last_valid_temp = t;
                    ready = true;
                    valid_reads++;

                    // If we were previously disconnected, flag reconnection
                    if (sensor_disconnected) {
                        sensor_disconnected = false;
                        sensor_reconnected  = true;  // FSM will log and clear
                        Serial.printf("[DS18B20] sensor RECONNECTED — temp=%.2f°C "
                                      "(was disconnected for %lums)\n",
                                      t, now - disconnect_ts_ms);
                    }
                    break;

                case STATE_BOOT_SENTINEL:
                    // ── EC-04: Power-on default — discard ───────────────
                    // Do NOT update last_valid_temp. Do NOT set ready.
                    // Log once so developer knows it was caught.
                    Serial.printf("[DS18B20] boot sentinel +85.0°C discarded "
                                  "(boot window active, %lums remaining)\n",
                                  (boot_ts_ms + DS18B20_BOOT_IGNORE_MS) - now);
                    break;

                case STATE_DISCONNECTED:
                    // ── EC-05: Sensor disconnected → signal LOCKOUT ──────
                    if (!sensor_disconnected) {
                        sensor_disconnected = true;
                        disconnect_count++;
                        disconnect_ts_ms = now;
                        Serial.printf("[DS18B20] SENSOR DISCONNECTED (event #%lu) "
                                      "— FSM LOCKOUT will be triggered\n",
                                      disconnect_count);
                    }
                    // last_valid_temp unchanged — preserve last known reading
                    // ready = false — stop reporting stale data as valid
                    ready = false;
                    break;

                case STATE_INVALID_RANGE:
                    // ── Out of DS18B20 rated range: -55°C to +125°C ─────
                    // Treat as sensor anomaly — do NOT update reading.
                    // Do NOT trigger LOCKOUT (could be single-sample glitch).
                    // Log for diagnostics.
                    Serial.printf("[DS18B20] out-of-range reading: %.2f°C — discarded\n", t);
                    break;
            }
        }

        // ── Trigger next conversion every TEMP_READ_INTERVAL_MS ──────────
        if (!converting && (now - last_req_ms >= TEMP_READ_INTERVAL_MS)) {
            dt.requestTemperatures();
            req_ts_ms   = now;
            last_req_ms = now;
            converting  = true;
        }
    }

    // ── Core accessors ────────────────────────────────────────────────────

    // Returns last VALID temperature (never -127°C, never boot sentinel)
    // Callers should always check isReady() before trusting this value.
    float getTemp() { return last_valid_temp; }

    // True only after first valid conversion AND sensor not disconnected
    bool  isReady() { return ready && !sensor_disconnected; }

    // ── Disconnect / reconnect accessors (polled by FSM) ─────────────────

    // True when -127°C was most recently received.
    // FSM must transition to LOCKOUT when this returns true.
    bool isDisconnected() { return sensor_disconnected; }

    // Pulsed true on reconnection (from disconnected back to valid).
    // Call clearReconnectedFlag() after logging.
    bool wasReconnected() { return sensor_reconnected; }
    void clearReconnectedFlag() { sensor_reconnected = false; }

    // ── Diagnostics ──────────────────────────────────────────────────────
    uint32_t getDisconnectCount()   { return disconnect_count; }
    uint32_t getTotalReads()        { return total_reads; }
    uint32_t getValidReads()        { return valid_reads; }
    bool     isBootWindowActive()   { return !boot_window_done; }
}
