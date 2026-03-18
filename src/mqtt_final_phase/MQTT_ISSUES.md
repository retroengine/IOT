# MQTT Intermittency — Root Cause Analysis & Fix Guide

## Observed symptom
HiveMQ Cloud receives telemetry sometimes but not consistently.
JSON payloads arrive sporadically. Some publishes succeed, others are dropped silently.

---

## Root Cause 1 — Static telemetry buffer race condition
**Severity: HIGH**

### What is happening
`TelemetryBuilder::s_buf` is a single static char array.
Two execution contexts on Core 1 both call `buildJSON()`:

1. `MQTTClient::tick()` → called from `task_comms` (scheduled FreeRTOS task)
2. `APIServer` GET `/api/telemetry` → called from ESPAsync event handler (interrupt-style, fires on any HTTP request)

Both are on Core 1 but ESPAsync handlers can preempt the comms task. If an HTTP request arrives while `MQTTClient::tick()` has already called `buildJSON()` and holds a pointer to `s_buf`, the async handler overwrites `s_buf` in place. The MQTT publish call then sends a half-overwritten buffer.

### Fix
Add a second static buffer in `telemetry_builder.cpp` specifically for MQTT,
or copy the payload into a local stack buffer before calling `mqtt.publish()`.

```cpp
// In MQTTClient::tick(), replace:
const char* payload = TelemetryBuilder::buildJSON(r, ctx);
bool ok = publish_safe(topic_telemetry, payload);

// With:
const char* raw = TelemetryBuilder::buildJSON(r, ctx);
if (!raw) return;
// Copy into local MQTT buffer — isolates from HTTP handler overwrites
static char mqtt_buf[MQTT_TELEMETRY_BUF_SIZE];
strncpy(mqtt_buf, raw, sizeof(mqtt_buf) - 1);
mqtt_buf[sizeof(mqtt_buf) - 1] = '\0';
bool ok = publish_safe(topic_telemetry, mqtt_buf);
```

Define `MQTT_TELEMETRY_BUF_SIZE` in `config.h` — same value as `TELEMETRY_BUF_SIZE`.
This is a stack copy, not heap allocation. Stays deterministic.

---

## Root Cause 2 — JSON payload exceeds MQTT internal buffer
**Severity: HIGH**

### What is happening
The v1.3 telemetry JSON includes the full `diagnostics` object:
- `sensor_health` (voltage, current, temperature sub-objects)
- `adc_health`
- `power_quality`
- `system_health`

Measured size: approximately 3.5–5 KB depending on float precision.

`mqtt.setBufferSize(4096)` gives PubSubClient a 4096-byte internal packet buffer.
This buffer must hold the MQTT fixed header (2 bytes) + variable header (topic length + 2 bytes) + payload.
With a topic like `sgs/device/sgs-aabbcc/telemetry` (34 bytes), the max payload is 4096 - 36 = ~4060 bytes.

If the telemetry JSON serializes to more than ~4060 bytes, `mqtt.publish()` returns `false` silently.
No error is printed. `publish_failed` increments. The message is lost.

### Fix Option A — Increase MQTT buffer size
```cpp
// In mqtt_client.cpp MQTTClient::init():
mqtt.setBufferSize(6144);   // increase from 4096
```
This uses 6 KB of heap. Feasible on ESP32 (300 KB+ available) but monitor heap usage.

### Fix Option B — Strip diagnostics from MQTT payload (recommended)
MQTT telemetry should carry operational data only, not the full diagnostics snapshot.
Diagnostics are available on-demand via HTTP `GET /api/diagnostics`.

Create `TelemetryBuilder::buildMQTTJSON()` — a slimmed payload containing only:
- `device`, `ts`, `schema_v`
- `sensors` (voltage, current, temperature values + confidence)
- `power` (real/apparent/energy)
- `loads` (relay states)
- `alerts` (fsm_state, active_fault, trip_count, warn flags)
- `network` (wifi_rssi, mqtt_connected, ip)
- `system` (uptime_s, free_heap)

Estimated size: ~600–900 bytes. Well within any MQTT buffer.

Full diagnostics remain accessible via `GET /api/diagnostics` for the dashboard.

---

## Root Cause 3 — mqtt.loop() starvation from OLED I2C blocking
**Severity: MEDIUM**

### What is happening
`task_comms` executes sequentially:
```
OLEDDisplay::update(r, ctx)   ← synchronous I2C, ~15–30 ms
Buzzer::tick(ctx.state)       ← fast, non-blocking
MQTTClient::tick(r, ctx)      ← calls mqtt.loop() + optional publish
vTaskDelay(COMMS_LOOP_MS)
```

If `COMMS_LOOP_MS` = 100 ms and OLED takes 25 ms, the effective period is ~125 ms.
PubSubClient's keepalive is `MQTT_KEEPALIVE` seconds (default: 15s).
This is not critical for keepalive alone, but combined with TLS reconnect delays,
the broker can drop the connection if keepalive packets are not sent in time.

During TLS reconnect (which blocks for up to 30s per `tlsClient.setTimeout(30)`),
the OLED and buzzer also freeze for that duration. This causes visible OLED glitches.

### Fix
Split MQTT into its own task on Core 1, or move OLED to a lower-priority task.
Minimum viable fix: call `mqtt.loop()` at the start of `task_comms` before OLED,
and also after OLED — so the keepalive pump runs more frequently.

```cpp
// In task_comms while loop:
MQTTClient::pumpLoop();       // just mqtt.loop(), no publish
OLEDDisplay::update(r, ctx);
Buzzer::tick(ctx.state);
MQTTClient::tick(r, ctx);     // publish if interval elapsed
vTaskDelay(pdMS_TO_TICKS(COMMS_LOOP_MS));
```

Add `MQTTClient::pumpLoop()` to `mqtt_client.h`/`.cpp`:
```cpp
void MQTTClient::pumpLoop() { mqtt.loop(); }
```

---

## Summary — Fix Priority Order

| Priority | Fix | Effort |
|---|---|---|
| 1 | Copy telemetry buffer before MQTT publish (race condition) | 5 min |
| 2 | Create slimmed `buildMQTTJSON()` for MQTT payload | 30 min |
| 3 | Add `pumpLoop()` call before OLED update | 5 min |
| 4 | Increase `setBufferSize` to 6144 as interim | 1 min |

Fixes 1 and 2 together will eliminate the intermittent publish failures.
Fix 3 improves keepalive reliability under load.
Fix 4 is a stopgap until Fix 2 is implemented.
