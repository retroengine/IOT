# Smart Grid Sentinel — Firmware Architecture Review
## Professional IoT Embedded Systems Analysis

---

## 1. OVERALL ARCHITECTURE ASSESSMENT

The SGS firmware is a well-structured, production-oriented embedded system with a clean
modular design. The dual-core FreeRTOS split (Core 0: protection, Core 1: comms) is
architecturally sound for a real-time safety system. The codebase demonstrates strong
engineering practice. The following review identifies specific risks and hardening improvements.

---

## 2. CRITICAL BUG RISKS

### 2.1 Relay Boot Glitch — HIGH RISK
**File:** `relay_control.cpp` (assumed) / `config.h`

GPIO26/27 float during ESP32 boot before `pinMode(OUTPUT)` is called. If the relay
driver is active-LOW, the GPIO floating HIGH is actually SAFE. However if the board
uses active-HIGH drivers, relays will close briefly at boot — potentially energizing
loads during firmware initialization before the FSM has evaluated any sensor data.

**Fix:** Add `gpio_set_pull_down` in `relay_control.cpp` BEFORE `pinMode()`:
```cpp
gpio_set_pull_down_en((gpio_num_t)PIN_RELAY_LOAD1, GPIO_PULLDOWN_ENABLE);
gpio_set_pull_down_en((gpio_num_t)PIN_RELAY_LOAD2, GPIO_PULLDOWN_ENABLE);
// THEN set pinMode
```
Or add boot-time relay state explicitly in `init()` before any task starts.

### 2.2 ADC Raw Value Exposure in Telemetry — MEDIUM RISK
**File:** `adc_sampler.cpp`

The `raw_value` field intended for telemetry is the oversampled ADC count, not
compensated via `esp_adc_cal_raw_to_voltage()`. The calibration structures
`adc_chars_v` / `adc_chars_i` are initialized but never used for conversion —
the code falls through to a simple linear map. This means ADC calibration data
is wasted and voltage/current readings can be off by ±5–10% depending on the
specific ESP32 chip's eFuse calibration.

**Fix (added in telemetry_builder):** Expose both raw and calibration-corrected
values. Track `calibrated` flag in telemetry sensor confidence field.

### 2.3 mutex Timeout Silent Failure — MEDIUM RISK
**File:** `main.cpp`, lines ~70 and ~101

`xSemaphoreTake(g_state_mutex, pdMS_TO_TICKS(5))` with a 5ms timeout. If the
mutex is not acquired, the task silently uses stale data from the last loop iteration
with no indication to the consumer. Under high CPU load (WiFi reconnection storm,
large JSON serialization), 5ms is marginal.

**Fix:** Increase timeout to `pdMS_TO_TICKS(20)`. Log missed mutex acquisitions
in the health task. The current code in task_comms will render the last snapshot
to OLED/MQTT which is acceptable, but it should be counted.

### 2.4 MQTT Buffer Size Too Small — HIGH RISK
**File:** `mqtt_client.cpp`, line ~55

`mqtt.setBufferSize(512)` — the new full telemetry JSON payload is ~1.5–2KB.
PubSubClient silently drops publish calls when the payload exceeds buffer size
with no error returned to the caller.

**Fix:** Increase to `mqtt.setBufferSize(2048)`. Verified against the telemetry
schema — peak payload is ~1.6KB.

### 2.5 String Heap Fragmentation in MQTT/API — MEDIUM RISK
**Files:** `mqtt_client.cpp`, `api_server.cpp`

`serializeJson(doc, payload)` where `payload` is an `Arduino::String` causes
heap allocation on every publish cycle (every 5 seconds). Over 24/7 operation
this creates heap fragmentation. The ESP32 heap uses a first-fit allocator;
fragmentation will cause allocation failures after extended runtime.

**Fix (implemented in telemetry_builder):** Use a static `char buf[2048]`
with `serializeJson(doc, buf, sizeof(buf))`. No heap allocation needed.

### 2.6 WiFi Reconnection — Missing Exponential Backoff — MEDIUM RISK
**File:** `mqtt_client.cpp`

`ensure_connected()` retries on every `tick()` call (every 50ms) when WiFi
is connected but MQTT is not. If the broker is down, this creates a tight
reconnect loop that can interfere with the WiFi stack and delay sensor loop
execution indirectly via the comms task.

**Fix:** Add a reconnect cooldown: only attempt MQTT reconnect at most once
every 5 seconds with exponential backoff up to 60s.

### 2.7 WiFi Scan Blocking — HIGH RISK
**File:** `api_server.cpp`

`WiFi.scanNetworks()` is called synchronously inside an async web server
callback. This call blocks the ESP32's WiFi/lwIP task for ~2–4 seconds,
during which MQTT keep-alive packets cannot be sent, causing broker
disconnection. It also blocks the async server event loop.

**Fix:** Use `WiFi.scanNetworks(true)` (async scan) and poll `WiFi.scanComplete()`
on subsequent requests, or restrict scan to a dedicated task with notification.

### 2.8 `delay()` Calls in API Handlers — HIGH RISK
**File:** `api_server.cpp`

`delay(1000)` and `delay(500)` are called inside ESPAsyncWebServer callbacks
(POST /api/wifi and POST /api/reboot). ESPAsync runs on the lwIP/WiFi task —
blocking it blocks all network I/O including the ongoing HTTP response send.
The response may never fully transmit before the delay completes.

**Fix:** Use `xTaskCreatePinnedToCore` to spawn a one-shot reboot task, or
`vTaskDelay` from within a FreeRTOS task context. The response must be flushed
before the delay begins.

---

## 3. BROWNOUT RISKS

The ESP32 brownout detector is enabled by default at ~2.43V. Key risk scenarios:

| Scenario | Risk | Mitigation |
|---|---|---|
| Relay coil energization | 50–200mA current surge → VCC dip | Add 100µF bulk cap near relay coil flyback diodes |
| WiFi TX burst (peak 380mA) | VCC can drop 200mV+ | Adequate PSU bypass capacitors |
| DS18B20 conversion + WiFi TX | Simultaneous peak draw | Stagger DS18B20 conversion trigger |
| Brownout → restart loop | Repeated cold boots | Log brownout count in NVS; halt if >5 brownouts in 60s |

**Firmware fix for brownout loop detection (added to main.cpp recommendation):**
```cpp
if (reason == ESP_RST_BROWNOUT) {
    Preferences p; p.begin("sgs_bo", false);
    int count = p.getInt("bo_count", 0) + 1;
    p.putInt("bo_count", count);
    uint32_t last = p.getUInt("bo_ts", 0);
    p.putUInt("bo_ts", millis());
    p.end();
    if (count > 5 && (millis() - last) < 60000) {
        // Enter safe halt — don't close relays, signal via LED
        // This prevents relay chatter on repeated brownout cycling
    }
}
```

---

## 4. WATCHDOG ANALYSIS

Current WDT implementation is correct: both `task_protection` and `task_comms`
register with `esp_task_wdt_add(nullptr)` and reset with `esp_task_wdt_reset()`.

**Gap 1:** The health task (`task_health`) does NOT register with the WDT. If it
enters an infinite loop or crashes, it won't trigger a reset. This is acceptable
for a non-critical task, but should be documented.

**Gap 2:** If `xSemaphoreTake` blocks for longer than `WDT_TIMEOUT_S` (10s) —
which cannot happen with a 5ms timeout — but more critically, the OLED I2C
transaction (inside `task_comms`) has no timeout. A stuck I2C bus (SCL stuck LOW
by a malfunctioning display) will block `task_comms` indefinitely, triggering WDT.
This is actually the correct behavior — the WDT will reboot and recover.

**Gap 3:** `WDT_TIMEOUT_S = 10` is too generous for a 10ms sensor loop. A genuine
hang in the protection task would go undetected for 10 seconds, during which a
real fault might not be processed. Consider 3–5 seconds for a safety system.

---

## 5. FREERTOS TASK PRIORITY ANALYSIS

```
task_protection  Priority 5  Core 0   ✓ Correct — safety-critical, highest
task_comms       Priority 3  Core 1   ✓ Correct — communications
task_health      Priority 1  Core 1   ✓ Correct — lowest, diagnostic only
Arduino loop()   deleted               ✓ Correct
ESPAsyncWebServer           Core 1   ✓ Event-driven, does not block
```

**Issue:** The Arduino framework's WiFi event handler runs at priority 19 on Core 0
(ESP-IDF internal). During WiFi reconnection events, this can briefly preempt
`task_protection` on Core 0. This is a known ESP32 framework behavior and cannot
be avoided, but the 10ms sensor loop period provides sufficient margin.

**Recommendation:** `task_protection` at priority 5 is safe, but consider raising
to priority 6 to ensure it is never preempted by framework tasks at priority 5.

---

## 6. ADC NOISE ANALYSIS

The multi-stage pipeline (oversample → IIR → moving average) is well designed.

**Known ESP32 ADC Issues:**
1. **ADC2 unusable when WiFi active** — code correctly uses ADC1 only (GPIO34/35). ✓
2. **Non-linearity at extremes** — raw values near 0 and 4095 are unreliable.
   The eFuse calibration in `adc_sampler.cpp` is initialized but not applied to
   the actual conversion. The `rawToVoltage()` function uses a simple linear map
   ignoring the calibration curves.
3. **Crosstalk between channels** — sampling both channels in the same `tick()`
   call within microseconds can cause channel crosstalk on some ESP32 revisions.
   Adding `adc1_get_raw()` on a dummy channel between the two real reads helps.

**Sensor Confidence Metric (added in telemetry_builder):**
- Confidence = 100% if calibrated=true AND sample_count > MOVING_AVG_DEPTH
- Confidence drops to 70% if not calibrated
- Confidence drops to 50% during first MOVING_AVG_DEPTH samples (filter warmup)

---

## 7. FAULT DETECTION RELIABILITY

The fault engine implementation is excellent. Specific observations:

**Strengths:**
- Inrush blanking with separate fault/warn windows ✓
- Asymmetric IIR (fast rise, slow fall) ✓
- 3-sample median for EMI rejection ✓
- Adaptive debounce for heavy loads ✓
- Predictive slope detection ✓

**Gaps:**
1. `active_fault` is only ever set, never cleared unless `clearLatched()` is called
   explicitly. If a transient OV spike passes quickly through the fault evaluator,
   `active_fault` remains set until the FSM calls `clearLatched()`. This is
   intentional for a protection system — document it explicitly.
2. The `short_circuit_risk` field requested in telemetry is not currently detected.
   A short circuit would manifest as: very high current + voltage collapse. Adding
   detection: `(i >= CURR_OC_FAULT_A) && (v < VOLT_UV_FAULT_V)` as a composite
   condition with 1-sample debounce.
3. `inrush_event` telemetry field: `isInrushBlankActive()` already exposes this. ✓

---

## 8. TELEMETRY ARCHITECTURE IMPROVEMENTS

**Current state:** MQTT publishes a minimal flat JSON (~200 bytes). The API returns
a richer but still flat JSON. Neither has sensor confidence, diagnostics, or
structured fault data.

**Improvement:** Centralize all telemetry construction in `telemetry_builder.cpp`.
Both MQTT and API server call `TelemetryBuilder::buildJSON()`. This:
- Eliminates duplicate serialization code
- Ensures MQTT and REST always return identical data
- Uses a single static buffer (no heap allocation)
- Adds all required fields in one place

See `telemetry_builder.cpp` for the complete implementation.

---

## 9. MEMORY SAFETY SUMMARY

| Risk | Severity | Status |
|---|---|---|
| Static char buffers in telemetry | Safe | Fixed via static buf |
| Arduino String in MQTT publish | Heap fragmentation | Fixed in telemetry_builder |
| NVS EventEntry `note[16]` overflow | Safe | `strncpy` with -1 ✓ |
| JsonDocument stack allocation | Safe for <2KB docs | Monitor with health task |
| `g_reading`/`g_ctx` race condition | Safe | Protected by mutex ✓ |
| MQTT buffer overflow (512 bytes) | Silent drop | Fixed → 2048 bytes |

---

*Review complete. See telemetry_builder.cpp, updated mqtt_client.cpp,*
*updated api_server.cpp, updated types.h, and dashboard/index.html*
*for all implemented improvements.*
