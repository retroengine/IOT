// ============================================================
//  oled_display.cpp — SSD1306 128×64 two-page display
// ============================================================
#include "oled_display.h"
#include "config.h"
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

namespace {
    Adafruit_SSD1306 oled(OLED_WIDTH, OLED_HEIGHT, &Wire, OLED_RESET_PIN);
    int       page = 0;
    uint32_t  last_flip_ms = 0;

    // State color mapping → bitmapped chars (OLED is monochrome, use inverted blocks)
    void drawStateBar(const char* state_str, FSMState s) {
        // Inverted block for state — draws white box with black text for alerts
        bool invert = (s == FSM_FAULT || s == FSM_LOCKOUT || s == FSM_WARNING);
        if (invert) {
            oled.fillRect(0, 0, 128, 10, WHITE);
            oled.setTextColor(BLACK);
        } else {
            oled.fillRect(0, 0, 128, 10, BLACK);
            oled.setTextColor(WHITE);
        }
        oled.setCursor(2, 1);
        oled.setTextSize(1);
        oled.print("SGS  ");
        oled.print(state_str);
        oled.setTextColor(WHITE);  // reset
    }
}

namespace OLEDDisplay {

    void init() {
        Wire.begin(PIN_OLED_SDA, PIN_OLED_SCL);
        if (!oled.begin(SSD1306_SWITCHCAPVCC, OLED_I2C_ADDR)) {
            Serial.println("[OLED] init FAILED — check wiring");
            return;
        }
        oled.clearDisplay();
        oled.setTextColor(WHITE);
        oled.setTextSize(1);
        oled.setCursor(20, 22);
        oled.print("Smart Grid Sentinel");
        oled.setCursor(40, 38);
        oled.print("Booting...");
        oled.display();
        Serial.println("[OLED] init OK");
    }

    void update(const SensorReading& r, const FSMContext& ctx) {
        uint32_t now = millis();
        if (now - last_flip_ms >= OLED_PAGE_FLIP_MS) {
            page = (page + 1) % 2;
            last_flip_ms = now;
        }

        oled.clearDisplay();
        drawStateBar(fsmStateName(ctx.state), ctx.state);

        if (page == 0) {
            // ── Page 1: Live readings ──────────────────────────────────────
            oled.setTextSize(1);
            oled.setTextColor(WHITE);

            // Voltage
            oled.setCursor(0, 14);
            oled.printf("V: %6.1f V", r.voltage_v);

            // Current
            oled.setCursor(0, 25);
            oled.printf("I: %6.2f A", r.current_a);

            // Temperature
            oled.setCursor(0, 36);
            if (r.temp_c > -100.0f) {
                oled.printf("T: %6.1f C", r.temp_c);
            } else {
                oled.print("T:  --no sensor--");
            }

            // Power
            oled.setCursor(0, 47);
            oled.printf("P: %6.1f VA", r.power_va);

            // Warn flags bottom line
            oled.setCursor(0, 57);
            oled.setTextSize(1);
            if (ctx.warn_flags) {
                oled.printf("W:%s%s%s%s",
                    (ctx.warn_flags & WARN_OV)      ? "OV " : "",
                    (ctx.warn_flags & WARN_UV)      ? "UV " : "",
                    (ctx.warn_flags & WARN_OC)      ? "OC " : "",
                    (ctx.warn_flags & WARN_THERMAL) ? "TH " : "");
            }

        } else {
            // ── Page 2: Fault & relay status ──────────────────────────────
            oled.setTextSize(1);
            oled.setTextColor(WHITE);

            oled.setCursor(0, 14);
            oled.printf("Fault: %s", faultTypeName(ctx.fault_type));

            oled.setCursor(0, 25);
            oled.printf("Trips: %d / %d", ctx.trip_count, MAX_TRIP_COUNT);

            oled.setCursor(0, 36);
            oled.printf("L1: %s", r.relay1_closed ? "CLOSED" : "OPEN  ");

            oled.setCursor(0, 47);
            oled.printf("L2: %s", r.relay2_closed ? "CLOSED" : "OPEN  ");

            // Recovery countdown
            if (ctx.state == FSM_FAULT) {
                uint32_t elapsed = millis() - ctx.fault_ts_ms;
                int remaining = max(0, (int)(RECOVERY_DELAY_MS - elapsed) / 1000);
                oled.setCursor(0, 57);
                oled.printf("Auto-reset: %ds", remaining);
            }
        }

        oled.display();
    }
}
