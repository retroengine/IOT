# dashboard.md — Smart Grid Sentinel
## IoT Controller → Dashboard Data Contract

> **Purpose:** This document is the single source of truth for everything the
> IoT controller (ESP32) must expose so the dashboard can function completely.
> It was derived by reading all 16 dashboard source files and cataloguing
> every field each component reads across all 5 pages.
>
> **Last updated:** Full audit of page1-status.js, page2-faults.js,
> page3-diagnostics.js, page4-cloud.js, page5-analytics.js, telemetryParser.js,
> telemetryPoller.js, telemetryBuffer.js, historyPoller.js, mockData.js,
> canvasEngine.js, svgEngine.js, animationLoop.js, main.js, and index.html.

---

## 1. Telemetry API Endpoint

| Item | Value |
|---|---|
| Endpoint | `GET /api/telemetry` |
| Method | HTTP GET |
| Content-Type | `application/json` |
| Poll rate | 100 ms (HTTP fallback) / 1–2 Hz push (WebSocket primary) |
| Auth | None required at Phase 3 (Phase 8 adds auth) |

The ESP32 must respond with a single JSON object every time this endpoint
is called. The full schema is defined in Section 2 and expanded in Section 11.

---

## 2. Canonical Telemetry JSON Schema (Quick Reference)

Minimal structure. For the complete schema including all sub-objects see
**Section 11**.

```json
{
  "device": "sgs-01",
  "schema_v": "1.3",
  "ts": 1700000000000,

  "v": 230.5,
  "i": 12.3,
  "t": 45.2,
  "p": 2834,
  "va": 3080.0,
  "e": 1420.5,
  "pf": 0.920,
  "freq": 50.01,

  "relay": true,
  "state": "NORMAL",
  "health": 87,
  "uptime": 3600,

  "faults": {
    "active":        "NONE",
    "trip_count":    0,
    "over_voltage":  false,
    "under_voltage": false,
    "over_current":  false,
    "over_temp":     false,
    "short_circuit": false,
    "inrush":        false,
    "warnings": {
      "ov":          false,
      "uv":          false,
      "oc":          false,
      "thermal":     false,
      "curr_rising": false
    }
  },

  "prediction": {
    "fault_probability": 8.5,
    "risk_level":        "LOW"
  },

  "wifi": {
    "connected": true,
    "rssi":      -58,
    "ip":        "192.168.1.100"
  },

  "mqtt": {
    "connected":         true,
    "tls":               true,
    "publish_total":     1842,
    "publish_failed":    3,
    "connect_attempts":  1,
    "connect_successes": 1
  },

  "sys": {
    "uptime_s":       3600,
    "free_heap":      182400,
    "cpu_load_pct":   23.5,
    "health_score":   87,
    "health_status":  "HEALTHY",
    "uptime_quality": "STABLE",
    "heap_healthy":   true
  },

  "diagnostics": {
    "voltage_stability":   92,
    "current_stability":   88,
    "temp_stability":      95,
    "adc_health":          91,
    "system_health":       87,
    "power_quality_label": "GOOD"
  }
}
```

---

## 3. Field-by-Field Reference

### 3.1 Top-Level Fields

| Field | Type | Unit | Range | Description | Used by |
|---|---|---|---|---|---|
| `device` | string | — | — | Unique device identifier. Used for MQTT topic `sgs/device/<id>/telemetry` and broker pill on Page 4. | Page 4 mqttPayloadInspector, broker pill |
| `schema_v` | string | — | `"1.3"` | Schema version string. Pass-through — dashboard stores but does not validate. | telemetryParser metadata |
| `ts` | number | ms | epoch ms | Unix timestamp in **milliseconds** (not seconds). Used for alarm log timestamps, payload inspector, and last-published time on Page 4. | alarmLog, Page 4, Page 1 uptime clock |
| `v` | number | V | 0 – 300 | RMS voltage. Hero number, waveform, sparkline, energy flow map. | Page 1 hero, waveformCard, energyFlowMap |
| `i` | number | A | 0 – 100 | RMS current. Hero number, waveform, sparkline, energy flow map. | Page 1 hero, waveformCard, energyFlowMap |
| `t` | number | °C | −40 – 150 | Temperature (DS18B20 probe). Arc gauge, sparkline, reset guard on Page 2. | arcGauge, sparkline, Page 2 reset guard |
| `p` | number | W | 0 – 50 000 | Active power (W). Can be derived as `v × i × pf`. | sparkline, energyFlowMap, Page 5 analytics |
| `va` | number | VA | 0 – 50 000 | Apparent power. Derived as `v × i`. | energyFlowMap, Page 5 analytics |
| `e` | number | Wh | 0 – 1×10⁹ | Cumulative energy since last boot. Dashboard displays as kWh. Increments every tick. | Page 1 energy counter |
| `pf` | number | — | 0.0 – 1.0 | Power factor (`p / va`). | Page 1 PF arc gauge, Page 5 analytics |
| `freq` | number | Hz | 45 – 65 | Mains frequency. Tolerance indicator turns amber outside ±0.02 Hz of 50 Hz nominal. | Page 1 frequency display |
| `relay` | boolean | — | true/false | Relay contact state. `true` = CLOSED (load connected). `false` = OPEN (load disconnected). | relayToggle, signalPath, energyFlowMap |
| `state` | string | — | see §3.2 | Current FSM state string. Controls badge colour, waveform colour, alarm logging. | stateBadge, waveformCard, alarmLog, signalPath, energyFlowMap, faultMatrix, Page 2 FSM diagram |
| `health` | number | % | 0 – 100 | Overall system health score. 100 = perfect. | arcGauge, hexHealthCell, Page 1 status bar |
| `uptime` | number | s | 0 – ∞ | Seconds since last boot. Same value as `sys.uptime_s`. Both top-level and nested paths are read by different components — send both. | Page 1 uptime clock, Page 3 uptime ring |

### 3.2 `state` Allowed Values

The `state` field must be **exactly one** of these six strings (uppercase).

| Value | Meaning | Dashboard behaviour |
|---|---|---|
| `"BOOT"` | Device initialising | Static grey badge |
| `"NORMAL"` | All parameters within limits | Green badge, no animation |
| `"WARNING"` | Parameter approaching limit | Amber badge, slow pulse |
| `"FAULT"` | Protection trip triggered | Red badge, fast pulse, waveform turns red, alarm logged |
| `"RECOVERY"` | Relay re-closing sequence | Teal badge, rotating ring |
| `"LOCKOUT"` | Too many trips — manual reset required | Dark red badge, static |

### 3.3 `faults` Object

| Field | Type | Description | Used by |
|---|---|---|---|
| `faults.active` | string | Name of the currently active fault, or `"NONE"`. See allowed values below. | alarmLog, faultMatrix, Page 2 reset guard |
| `faults.trip_count` | number (0–255) | Protection trips since last boot. Drives the 3-step IDMT trip counter on Page 2. At 3 trips the FSM should enter LOCKOUT. | Page 2 trip counter |
| `faults.over_voltage` | boolean | OV trip is the active condition. | faultIndicator, faultMatrix, Page 1 fault flags |
| `faults.under_voltage` | boolean | UV trip is active. | faultMatrix |
| `faults.over_current` | boolean | OC trip is active. | faultMatrix, Page 1 fault flags |
| `faults.over_temp` | boolean | OT trip is active. | faultMatrix, Page 1 fault flags |
| `faults.short_circuit` | boolean | SC trip is active. | faultMatrix, Page 1 fault flags |
| `faults.inrush` | boolean | Inrush current event is being blanked (relay just closed). | Page 1 fault flags |
| `faults.warnings.ov` | boolean | OV pre-warning (approaching but not yet tripped). | faultIndicator, faultMatrix, Page 1 fault flags |
| `faults.warnings.uv` | boolean | UV pre-warning. | faultMatrix, Page 1 fault flags |
| `faults.warnings.oc` | boolean | OC pre-warning. | faultIndicator, faultMatrix, Page 1 fault flags |
| `faults.warnings.thermal` | boolean | Thermal pre-warning. | faultMatrix, Page 1 fault flags |
| `faults.warnings.curr_rising` | boolean | Current rising trend detected. | faultMatrix, Page 1 fault flags |

**`faults.active` allowed string values:**

| Value | Meaning |
|---|---|
| `"NONE"` | No active fault |
| `"UNDERVOLT"` | Under-voltage condition tripped |
| `"OVERVOLTAGE"` | Over-voltage condition tripped |
| `"OVERCURRENT"` | Over-current condition tripped |
| `"THERMAL"` | Over-temperature condition tripped |
| `"SHORT_CIRCUIT"` | Short circuit detected |
| `"SENSOR_FAIL"` | ADC or sensor failure |

### 3.4 `sys` Object

| Field | Type | Unit | Range | Description | Used by |
|---|---|---|---|---|---|
| `sys.uptime_s` | number | s | 0 – ∞ | Seconds since boot. Same as top-level `uptime`. | Page 1 clock, Page 3 uptime ring, ADC panel |
| `sys.free_heap` | number | bytes | 0 – 327 680 | Free SRAM. Dashboard assumes 320 KB total ESP32 SRAM. Below ~50 000 bytes should set `heap_healthy` to false. | Page 3 heap bar |
| `sys.cpu_load_pct` | number | % | 0 – 100 | ESP32 main loop CPU utilisation. See computation note below. | Page 1 GPU panel, Page 3 CPU panel |
| `sys.health_score` | number | % | 0 – 100 | Overall system health score. Can mirror top-level `health`. | Page 3 hex health cells |
| `sys.health_status` | string | — | see §16 | Qualitative health tier. | Page 2 reset guard, Page 3 |
| `sys.uptime_quality` | string | — | see §16 | Uptime stability tier. Controls uptime ring fill level and colour on Page 3. | Page 3 uptime ring |
| `sys.heap_healthy` | boolean | — | true/false | True when free heap is above the safe threshold (≥ 60 KB recommended). | Page 3 heap bar colour |

**How to compute `cpu_load_pct` on the ESP32:**

```cpp
// Example: target loop period = 100 ms
float cpu_load_pct = (loop_duration_us / 1000.0f / 100.0f) * 100.0f;
cpu_load_pct = constrain(cpu_load_pct, 0.0f, 100.0f);
```

### 3.5 `diagnostics` Object

| Field | Type | Unit | Range | Description | Used by |
|---|---|---|---|---|---|
| `diagnostics.voltage_stability` | number | score | 0 – 100 | Voltage signal stability. 100 = perfectly stable. | Page 1 hex cell, Page 3 sensor bars, conf bars |
| `diagnostics.current_stability` | number | score | 0 – 100 | Current signal stability. | Page 3 sensor bars, conf bars |
| `diagnostics.temp_stability` | number | score | 0 – 100 | DS18B20 temperature channel stability. | Page 3 sensor bars, conf bars |
| `diagnostics.adc_health` | number | score | 0 – 100 | ESP32 ADC health. ≥85 → "CALIBRATED (2-POINT)"; ≥65 → "CALIBRATED (VREF)"; <65 → "NOT CALIBRATED". | Page 3 ADC panel |
| `diagnostics.system_health` | number | score | 0 – 100 | Composite system health. Can mirror top-level `health`. | Page 3 hex cell |
| `diagnostics.power_quality_label` | string | — | see below | Power quality tier label used by Page 3 radar. | Page 3 power quality radar |

**`power_quality_label` allowed values:** `"GOOD"`, `"FAIR"`, `"POOR"`.

**How to compute stability scores on the firmware side:**

Maintain a sliding window of N ADC samples. Compute standard deviation σ.
Map σ → score:

```cpp
// Voltage stability (σ in volts):
float score_v = constrain(100.0f - (sigma_v / 0.5f) * 100.0f, 0.0f, 100.0f);

// Current stability (σ in amps):
float score_i = constrain(100.0f - (sigma_i / 0.05f) * 100.0f, 0.0f, 100.0f);

// Temperature stability (σ in °C):
float score_t = constrain(100.0f - (sigma_t / 0.5f) * 100.0f, 0.0f, 100.0f);

// ADC health — proxy from voltage stability + absence of saturation events:
float adc_health = (score_v * 0.7f) + (sat_events == 0 ? 30.0f : 10.0f);
adc_health = constrain(adc_health, 0.0f, 100.0f);
```

Tune the divisors to match your sensor noise floor.

### 3.6 `prediction` Object

| Field | Type | Unit | Range | Description | Used by |
|---|---|---|---|---|---|
| `prediction.fault_probability` | number | % | 0 – 100 | Estimated fault probability for the next window. Send 0 if not implemented. | Page 1 arc gauge |
| `prediction.risk_level` | string | — | see below | Qualitative risk tier. Must be uppercase. | Page 3 power quality radar |

**`prediction.risk_level` allowed values:** `"LOW"`, `"MODERATE"`, `"HIGH"`, `"CRITICAL"`.

### 3.7 `wifi` Object

| Field | Type | Unit | Range | Description | Used by |
|---|---|---|---|---|---|
| `wifi.connected` | boolean | — | true/false | Wi-Fi association state. | Page 1 status bar connection dot, Page 4 signal path |
| `wifi.rssi` | number | dBm | −120 to 0 | Received signal strength. Mapped to 0–4 WiFi bars on Page 1. | Page 1 WiFi bars |
| `wifi.ip` | string | — | dotted-quad | Current IP address. Shown in Page 4 broker pill. | Page 4 broker pill |

**RSSI → bars mapping (Page 1 status bar):**

| RSSI range | Bars lit | Colour |
|---|---|---|
| −50 dBm or better | 4 | Green |
| −51 to −65 dBm | 3 | Green |
| −66 to −80 dBm | 2 | Amber |
| −81 dBm or worse | 1 | Red |
| `null` / missing | 0 | Grey |

### 3.8 `mqtt` Object

| Field | Type | Description | Used by |
|---|---|---|---|
| `mqtt.connected` | boolean | True if the MQTT broker TCP session is established. | Page 4 connection dot, signal path |
| `mqtt.tls` | boolean | True if the connection uses TLS. Shown as 🔒 TLS ON / TLS OFF badge. | Page 4 TLS badge |
| `mqtt.publish_total` | number | Cumulative MQTT messages published since boot. | Page 4 counters |
| `mqtt.publish_failed` | number | Cumulative failed publishes. Dashboard derives success rate: `(total − failed) / total × 100`. Amber warning at < 95 %, red at < 80 %. | Page 4 counters |
| `mqtt.connect_attempts` | number | Total connection attempts since boot. Warning shown if > 3. | Page 4 counters |
| `mqtt.connect_successes` | number | Successful connections since boot. Reserved for future health scoring. | telemetryParser |

---

## 4. Control API Endpoints (Dashboard → ESP32)

These are **write** endpoints. The dashboard sends commands; the ESP32 must
act on them and reflect the result in the next telemetry tick.

### 4.1 Relay Control

```
POST /api/relay
Content-Type: application/json

{ "state": true }
```

| Field | Type | Meaning |
|---|---|---|
| `state` | boolean | `true` = close relay (connect load). `false` = open relay (disconnect load). |

**Expected response:**

```json
HTTP 200 OK
{ "ok": true, "relay": true }
```

On error: HTTP 4xx or 5xx. The dashboard reverts the toggle to the last
known telemetry state on any non-200 response.

### 4.2 Alarm Acknowledge (single)

```
POST /api/alarm/ack
Content-Type: application/json

{ "id": "alarm-1700000000000-1" }
```

**Expected response:**

```json
HTTP 200 OK
{ "ok": true }
```

### 4.3 Alarm Acknowledge All

```
POST /api/alarm/ack/all
Content-Type: application/json

{ "ids": ["alarm-...-1", "alarm-...-2"] }
```

**Expected response:**

```json
HTTP 200 OK
{ "ok": true }
```

**Important:** Both alarm ack endpoints implement local-only fallback in the
dashboard. If the ESP32 returns an error or times out, the dashboard still
marks the alarms acknowledged locally. The ESP32 does not need to maintain
alarm state.

---

## 5. Component → Field Mapping (Quick Reference)

| Component | Fields consumed |
|---|---|
| `arcGauge.js` | `v`, `i`, `t`, `health`, `pf`, `prediction.fault_probability` (configurable field) |
| `faultIndicator.js` | `faults.over_voltage`, `faults.warnings.ov`, `faults.warnings.oc` (configurable) |
| `gpuPanel.js` | `sys.cpu_load_pct` |
| `hexHealthCell.js` | `health`, `diagnostics.voltage_stability`, `diagnostics.current_stability`, `diagnostics.temp_stability`, `diagnostics.system_health` (configurable) |
| `mqttPayloadInspector.js` | `device`, `ts`, full object (display only) |
| `relayToggle.js` | `relay` |
| `signalPath.js` | `relay`, `state` |
| `sparkline.js` | `v`, `i`, `t`, `p` (via telemetryBuffer) |
| `stateBadge.js` | `state` |
| `waveformCard.js` | `state`, `v`, `i` (via telemetryBuffer) |
| `alarmLog.js` | `state`, `faults.active`, `ts` |
| `energyFlowMap.js` | `state`, `relay`, `v`, `i`, `p` |
| `faultMatrix.js` | `state`, `faults.active`, `faults.over_voltage`, `faults.under_voltage`, `faults.over_current`, `faults.over_temp`, `faults.short_circuit`, `faults.warnings.*` (all 5) |

See **Section 23** for the complete per-page breakdown.

---

## 6. Telemetry Buffer (Internal Dashboard Concept)

The `waveformCard.js` and `sparkline.js` components read from a
`telemetryBuffer` module (imported as `getWaveform()` and `getSparkline()`).
This is an **internal dashboard ring buffer** — it is not an API call.

Buffer sizes (DESIGN.md §7):
- Waveform: 120 samples (~12 s at 10 Hz)
- Sparkline: 60 samples (~120 s at 0.5 Hz)

The page populates this buffer from each telemetry frame received. The
buffer stores the last N samples of `v`, `i`, `t`, `p`.

**The ESP32 does not need to do anything for this.** Keep returning accurate
per-tick `v`, `i`, `t`, `p` values.

---

## 7. MQTT (Optional)

If MQTT is enabled on the ESP32, publish the canonical JSON object (Section 2)
to the topic:

```
sgs/device/<device_id>/telemetry
```

The dashboard payload inspector on Page 4 captures frames via the existing
`update(telemetryData)` call — it does not connect to the MQTT broker
directly. MQTT is optional for all current phases.

---

## 8. Data Type and Value Constraints

| Rule | Detail |
|---|---|
| `ts` must be milliseconds | Not seconds. JavaScript `Date.now()` returns ms. Multiply Arduino `millis()` by 1 if using epoch, or use NTP. |
| `v`, `i`, `t`, `p`, `va`, `e`, `pf`, `freq` must be numbers | Not strings. Components do `typeof raw !== 'number'` checks. |
| `relay` must be boolean | Not 0/1 integers. Use JSON `true` / `false`. |
| `state` must be uppercase | `"NORMAL"` not `"normal"`. |
| `faults.active` must be uppercase | `"OVERCURRENT"` not `"overcurrent"`. |
| All boolean fault flags default to `false` | Omitting a flag is acceptable — components treat missing as inactive. |
| `health` is clamped 0–100 | Values outside this range are clamped by components. |
| `pf` is clamped 0–1 | Not 0–100. |
| `freq` is clamped 45–65 | Values outside this range are clamped. |
| `prediction.risk_level` must be uppercase | `"LOW"` not `"low"`. |
| `sys.health_status` must be uppercase | `"HEALTHY"` not `"healthy"`. |
| `sys.uptime_quality` must be uppercase | `"STABLE"` not `"stable"`. |

---

## 9. Minimal Viable Telemetry (Phase 3 Start)

Absolute minimum to bring the dashboard up with no crashes. Pages 3 and 4
will have placeholders for missing fields.

```json
{
  "device": "sgs-01",
  "ts": 1700000000000,
  "v": 230.5,
  "i": 12.3,
  "t": 45.2,
  "p": 2834,
  "relay": true,
  "state": "NORMAL",
  "health": 87,
  "faults": {
    "active": "NONE",
    "over_voltage":  false,
    "over_current":  false,
    "over_temp":     false,
    "short_circuit": false,
    "warnings": {
      "ov": false, "uv": false,
      "oc": false, "thermal": false, "curr_rising": false
    }
  },
  "sys":         { "cpu_load_pct": 0 },
  "diagnostics": { "voltage_stability": 100 },
  "prediction":  { "fault_probability": 0 }
}
```

---

## 10. Summary of All API Endpoints (Original)

| Method | Path | Direction | Purpose |
|---|---|---|---|
| GET | `/api/telemetry` | ESP32 → Dashboard | Full telemetry JSON |
| POST | `/api/relay` | Dashboard → ESP32 | Open or close the relay |
| POST | `/api/alarm/ack` | Dashboard → ESP32 | Acknowledge a single alarm |
| POST | `/api/alarm/ack/all` | Dashboard → ESP32 | Acknowledge all alarms |

See **Section 24** for the complete updated endpoint table including
WebSocket, `/api/config`, `/api/reset`, and `/api/history`.

---
---

# ── EXTENDED SECTIONS ───────────────────────────────────────────────────────
#    Derived from full codebase audit (all 16 source files).
#    Sections 11–25 supersede or extend Sections 1–10 where noted.
# ────────────────────────────────────────────────────────────────────────────

---

## 11. Complete Telemetry JSON Schema (Full — All Pages)

This is the **complete object** the ESP32 must return to make every
component across all 5 pages render without dashes or blank states.
Every field listed here is consumed by at least one component.

```json
{
  "device":    "sgs-01",
  "schema_v":  "1.3",
  "ts":        1700000000000,

  "v":    230.5,
  "i":    12.3,
  "t":    45.2,
  "p":    2834.0,
  "va":   3080.0,
  "e":    1420.5,
  "pf":   0.920,
  "freq": 50.01,

  "relay":  true,
  "state":  "NORMAL",
  "health": 87,
  "uptime": 3600,

  "faults": {
    "active":        "NONE",
    "trip_count":    0,
    "over_voltage":  false,
    "under_voltage": false,
    "over_current":  false,
    "over_temp":     false,
    "short_circuit": false,
    "inrush":        false,
    "warnings": {
      "ov":          false,
      "uv":          false,
      "oc":          false,
      "thermal":     false,
      "curr_rising": false
    }
  },

  "prediction": {
    "fault_probability": 8.5,
    "risk_level":        "LOW"
  },

  "wifi": {
    "connected": true,
    "rssi":      -58,
    "ip":        "192.168.1.100"
  },

  "mqtt": {
    "connected":         true,
    "tls":               true,
    "publish_total":     1842,
    "publish_failed":    3,
    "connect_attempts":  1,
    "connect_successes": 1
  },

  "sys": {
    "uptime_s":       3600,
    "free_heap":      182400,
    "cpu_load_pct":   23.5,
    "health_score":   87,
    "health_status":  "HEALTHY",
    "uptime_quality": "STABLE",
    "heap_healthy":   true
  },

  "diagnostics": {
    "voltage_stability":   92,
    "current_stability":   88,
    "temp_stability":      95,
    "adc_health":          91,
    "system_health":       87,
    "power_quality_label": "GOOD"
  }
}
```

---

## 12. `sys.health_status` and `sys.uptime_quality` Allowed Values

### `sys.health_status`

| Value | Meaning | Dashboard effect |
|---|---|---|
| `"HEALTHY"` | All vitals nominal | Green indicators on Page 3 |
| `"DEGRADED"` | One or more vitals suboptimal | Amber indicators |
| `"CRITICAL"` | Severe heap, CPU, or sensor issue | Red indicators; **blocks reset guard on Page 2** |

### `sys.uptime_quality`

| Value | Condition | Uptime ring fill | Ring colour |
|---|---|---|---|
| `"WARMING_UP"` | < 5 minutes uptime | 20 % | Blue |
| `"SETTLING"` | 5 – 60 minutes | 60 % | Amber |
| `"STABLE"` | > 60 minutes | 100 % | Green |

---

## 13. Transport Layer — WebSocket (Primary Transport)

```
WS  ws://<device-ip>/ws/telemetry
```

The dashboard tries WebSocket first on every `connect()` call. If 3
consecutive WS connections fail, it falls back to HTTP polling automatically.
When WS recovers, HTTP polling stops.

**What the ESP32 must do:**
- Accept WebSocket upgrade on `GET /ws/telemetry`
- Push the canonical JSON frame (Section 11) at **1–2 Hz** on every open connection
- Respond to standard WebSocket ping frames with pong frames

**Heartbeat (dashboard-side):**
- Ping sent every 10 seconds
- Connection marked lost if no pong arrives within 5 seconds
- Any data frame also resets the pong timer — telemetry pushes count as liveness

**Why this matters:** Without WebSocket, the dashboard polls HTTP at 100 ms
(10 Hz). This works but loads the ESP32's HTTP stack significantly more than
a 1–2 Hz WS push. WebSocket is the recommended production transport.

**WS vs HTTP payload:** Both transports must return the **exact same JSON
schema**. Do not send a different or abbreviated schema on WebSocket.

---

## 14. `GET /api/config` — Protection Parameters (Page 3)

Page 3 (Diagnostics) fetches this endpoint **once on mount** to display
the current protection thresholds. Read-only — the dashboard never writes
config values.

```
GET /api/config
Accept: application/json
```

**Expected response:**

```json
HTTP 200 OK
Content-Type: application/json

{
  "ovp_threshold_v":     253,
  "uvp_threshold_v":     207,
  "ocp_threshold_a":     15.0,
  "otp_threshold_c":     85,
  "reconnect_delay_s":   5,
  "fault_lockout_count": 3
}
```

**Key aliases the dashboard parser accepts** (any of these names work):

| Display label | Preferred key | Also accepted as |
|---|---|---|
| OVP Threshold | `ovp_threshold_v` | `ovp`, `OVP` |
| UVP Threshold | `uvp_threshold_v` | `uvp`, `UVP` |
| OCP Threshold | `ocp_threshold_a` | `ocp`, `OCP` |
| OTP Threshold | `otp_threshold_c` | `otp`, `OTP` |
| Reconnect Delay | `reconnect_delay_s` | `reconnect_delay` |
| Fault Lockout At | `fault_lockout_count` | `lockout_count`, `max_trips` |

**Graceful degradation:** If this endpoint is unreachable or returns a
non-200 status, Page 3 displays nominal firmware defaults and shows the
note: *"Config endpoint not reachable — showing firmware defaults."*
It will not crash or retry.

---

## 15. `POST /api/reset` — System Control (Page 2)

Page 2 (Faults & Control) sends three command variants. The body always
contains a `cmd` string key.

```
POST /api/reset
Content-Type: application/json
```

### 15.1 Fault Reset

```json
{ "cmd": "reset" }
```

Clears the active fault, resets `trip_count` to 0, and transitions the
FSM back to NORMAL. The dashboard only sends this command when **all three
reset guards pass simultaneously**:

1. Temperature `t` < 85 °C
2. `faults.active` ≠ `"SENSOR_FAIL"`
3. `sys.health_status` ≠ `"CRITICAL"` (or `t` > 0)

**Expected response:**
```json
HTTP 200 OK
{ "ok": true }
```

### 15.2 Reboot

```json
{ "cmd": "reboot" }
```

Triggers an ESP32 software restart (`esp_restart()`). The dashboard does
not wait for a response — the TCP connection will drop immediately.

### 15.3 Ping (Connectivity Check)

```json
{ "cmd": "ping" }
```

No-op command used by the dashboard to verify round-trip connectivity.

**Expected response:**
```json
HTTP 200 OK
{ "ok": true }
```

**On error or timeout:** The dashboard shows ✗ FAILED / ✗ TIMEOUT and
re-enables the button after 3 seconds. No state changes required on the
ESP32 for a failed ping.

---

## 16. `GET /api/history` — Historical Analytics (Page 5)

Page 5 (Analytics) fetches this endpoint to render 6 time-series charts
(voltage, current, temperature, power, power factor, fault timeline).

```
GET /api/history?field={field}&from={isoStart}&to={isoEnd}&resolution={n}
Accept: application/json
```

**Query parameters:**

| Parameter | Type | Example | Description |
|---|---|---|---|
| `field` | string | `v` | Which metric: `v`, `i`, `t`, or `p` |
| `from` | ISO 8601 string | `2024-11-15T10:00:00.000Z` | Range start (UTC) |
| `to` | ISO 8601 string | `2024-11-15T11:00:00.000Z` | Range end (UTC) |
| `resolution` | number | `200` | Target number of data points. Down-sample if storing more. |

**Expected response:**

```json
HTTP 200 OK
Content-Type: application/json

[
  { "ts": "2024-11-15T10:00:00.000Z", "value": 230.5 },
  { "ts": "2024-11-15T10:00:05.000Z", "value": 231.1 }
]
```

The `ts` field may be either an ISO 8601 string or epoch milliseconds — both
are accepted. Data must be in chronological order (oldest first).

**This endpoint is optional.** The dashboard falls back to the live ring
buffer (last ~60 samples) if the endpoint is absent. Charts always render.

| Condition | Dashboard behaviour |
|---|---|
| HTTP 404 or 501 | Silently uses live buffer — no error shown |
| Network timeout (8 s) | Uses live buffer — no error shown |
| Empty array `[]` | Uses live buffer |
| Successful response | Cached 30 s per unique (field, from, to, resolution) |

**Load pattern:** On each time-range change Page 5 fires up to 4 concurrent
requests (one per field: `v`, `i`, `t`, `p`). Time ranges are `1H`, `6H`,
`24H`, `7D`, `30D`. Factor this into your NVS logging strategy.

---

## 17. Firmware JSON Format Variants

The dashboard parser (`telemetryParser.js`) accepts three input formats
transparently. Send whichever is most natural for your firmware — no
configuration required on the dashboard side.

### 17.1 Canonical Flat (Recommended — easiest to build)

All fields at the top level with short keys. Smallest implementation effort.
This is the format Section 11 uses.

```json
{
  "device": "sgs-01", "schema_v": "1.3", "ts": 1700000000000,
  "v": 230.5, "i": 12.3, "t": 45.2,
  "p": 2834, "va": 3080, "e": 1420.5, "pf": 0.920, "freq": 50.01,
  "state": "NORMAL", "relay": true, "health": 87, "uptime": 3600,
  "faults": {
    "active": "NONE", "trip_count": 0,
    "over_voltage": false, "under_voltage": false,
    "over_current": false, "over_temp": false,
    "short_circuit": false, "inrush": false,
    "warnings": {
      "ov": false, "uv": false, "oc": false,
      "thermal": false, "curr_rising": false
    }
  },
  "prediction": { "fault_probability": 8.5, "risk_level": "LOW" },
  "wifi":  { "connected": true, "rssi": -58, "ip": "192.168.1.100" },
  "mqtt":  {
    "connected": true, "tls": true,
    "publish_total": 1842, "publish_failed": 3,
    "connect_attempts": 1, "connect_successes": 1
  },
  "sys": {
    "uptime_s": 3600, "free_heap": 182400, "cpu_load_pct": 23.5,
    "health_score": 87, "health_status": "HEALTHY",
    "uptime_quality": "STABLE", "heap_healthy": true
  },
  "diagnostics": {
    "voltage_stability": 92, "current_stability": 88,
    "temp_stability": 95, "adc_health": 91,
    "system_health": 87, "power_quality_label": "GOOD"
  }
}
```

### 17.2 Verbose v1.3 Nested (Good for debugging — matches firmware struct layout)

Fully nested structure matching the internal parser path notation.
Useful during development when you want to see the field hierarchy clearly.

```json
{
  "device": "sgs-01", "schema_v": "1.3", "ts": 1700000000000,
  "sensors": {
    "voltage":     { "filtered_value": 230.5 },
    "current":     { "filtered_value": 12.3  },
    "temperature": { "filtered_value": 45.2  }
  },
  "power": {
    "real_power_w":       2834.0,
    "apparent_power_va":  3080.0,
    "energy_estimate_wh": 1420.5,
    "power_factor":       0.920,
    "frequency_hz":       50.01
  },
  "alerts": {
    "fsm_state":          "NORMAL",
    "active_fault":       "NONE",
    "trip_count":         0,
    "over_voltage":       false,
    "over_current":       false,
    "over_temperature":   false,
    "short_circuit_risk": false,
    "inrush_event":       false,
    "warnings": {
      "ov": false, "uv": false, "oc": false,
      "thermal": false, "curr_rising": false
    }
  },
  "prediction": { "fault_probability": 8.5, "risk_level": "LOW" },
  "loads":      { "relay1": { "state": true } },
  "network": {
    "wifi_connected":         true,
    "wifi_rssi":              -58,
    "ip":                     "192.168.1.100",
    "mqtt_connected":         true,
    "mqtt_tls_verified":      true,
    "mqtt_publish_total":     1842,
    "mqtt_publish_failed":    3,
    "mqtt_connect_attempts":  1,
    "mqtt_connect_successes": 1
  },
  "system": { "uptime_s": 3600, "free_heap": 182400 },
  "diagnostics": {
    "system_health": {
      "overall_health_score":    87,
      "health_status":           "HEALTHY",
      "cpu_load_estimate_pct":   23.5,
      "uptime_quality":          "STABLE",
      "heap_healthy":            true
    },
    "sensor_health": {
      "voltage":     { "stability_score": 92 },
      "current":     { "stability_score": 88 },
      "temperature": { "stability_score": 95 }
    },
    "adc_health":    { "health_score": 91 },
    "power_quality": { "power_quality_label": "GOOD" }
  }
}
```

### 17.3 Short-Key Minified (Lowest bandwidth — for MQTT payload limits)

Add `"sk": 1` to trigger the parser's key-expansion path.
Only use if you have a compelling reason to minimise payload size.

```json
{
  "sk": 1, "device": "sgs-01", "ts": 1700000000000,
  "v_fil": 230.5, "i_fil": 12.3, "t_fil": 45.2,
  "pw_r": 2834, "pw_a": 3080, "pw_e": 1420.5,
  "fsm": "NORMAL", "flt": "NONE", "trips": 0,
  "ov": false, "oc": false, "ot": false, "sc": false, "inr": false,
  "w_ov": false, "w_uv": false, "w_oc": false,
  "w_th": false, "w_cr": false,
  "fp": 8.5, "rl": "LOW",
  "r1": true,
  "wifi": true, "rssi": -58, "ip": "192.168.1.100",
  "mqtt": true, "tls": true,
  "up": 3600, "heap": 182400
}
```

**Short-key → canonical path map** (full table):

| Short key | Canonical path |
|---|---|
| `v_fil` | `sensors.voltage.filtered_value` |
| `i_fil` | `sensors.current.filtered_value` |
| `t_fil` | `sensors.temperature.filtered_value` |
| `pw_r` | `power.real_power_w` |
| `pw_a` | `power.apparent_power_va` |
| `pw_e` | `power.energy_estimate_wh` |
| `fsm` | `alerts.fsm_state` |
| `flt` | `alerts.active_fault` |
| `trips` | `alerts.trip_count` |
| `ov` | `alerts.over_voltage` |
| `oc` | `alerts.over_current` |
| `ot` | `alerts.over_temperature` |
| `sc` | `alerts.short_circuit_risk` |
| `inr` | `alerts.inrush_event` |
| `w_ov` | `alerts.warnings.ov` |
| `w_uv` | `alerts.warnings.uv` |
| `w_oc` | `alerts.warnings.oc` |
| `w_th` | `alerts.warnings.thermal` |
| `w_cr` | `alerts.warnings.curr_rising` |
| `fp` | `prediction.fault_probability` |
| `rl` | `prediction.risk_level` |
| `r1` | `loads.relay1.state` |
| `wifi` | `network.wifi_connected` |
| `rssi` | `network.wifi_rssi` |
| `mqtt` | `network.mqtt_connected` |
| `tls` | `network.mqtt_tls_verified` |
| `ip` | `network.ip` |
| `up` | `system.uptime_s` |
| `heap` | `system.free_heap` |

---

## 18. IDMT Arc Gauge (Page 2 — Client-Side Estimate)

The IDMT accumulation arc gauge on Page 2 is **entirely computed
client-side** from `i` (current) and `state`. No extra firmware field
is required.

The dashboard estimates the IDMT accumulation using:

```
accumulation = ((i / I_pickup) − 1) × elapsedSeconds
```

Where `I_pickup` is derived from the OCP threshold fetched from
`/api/config` (default 15 A). If current stays below pickup, the
arc shows 0 %. Above pickup, the arc fills toward trip as a visual
approximation of IDMT characteristic.

This is a display-only estimate — it does not control any protection
logic. The actual protection trip decision remains entirely on the firmware.

---

## 23. Complete Component → Field Mapping (All 5 Pages)

### Page 1 — Status (Live monitoring)

| Zone | Component | Fields consumed |
|---|---|---|
| Status bar | Uptime clock | `uptime` / `sys.uptime_s` |
| Status bar | Health score | `health` |
| Status bar | Relay dot + label | `relay` |
| Status bar | WiFi bars | `wifi.rssi`, `wifi.connected` |
| Status bar | Connection dot | `wifi.connected` |
| Zone 2 | Hero numbers V / A / W | `v`, `i`, `p` |
| Zone 2 | Frequency display + tolerance dot | `freq` |
| Zone 2 | Waveform card | `state`, `v`, `i` (via buffer) |
| Zone 2 | PF arc gauge | `pf` |
| Zone 3A | Temperature sparkline | `t` (via buffer) |
| Zone 3A | Frequency sparkline | `freq` (via buffer) |
| Zone 3A | PF sparkline | `pf` (via buffer) |
| Zone 3B | Hex health cells (×5) | `health`, `diagnostics.voltage_stability`, `diagnostics.current_stability`, `diagnostics.temp_stability`, `diagnostics.system_health` |
| Zone 3B | Overall health arc gauge | `health` |
| Zone 3B | Signal paths (animated) | layout-driven, no telemetry field |
| Zone 4 | Energy flow map | `state`, `relay`, `v`, `i`, `p` |
| Zone 4 | Relay toggle | `relay` |
| Zone 4 | Energy kWh counter | `e` |
| Zone 4 | Fault flags panel (×10) | `faults.over_voltage`, `faults.over_current`, `faults.over_temp`, `faults.short_circuit`, `faults.inrush`, `faults.warnings.ov`, `faults.warnings.uv`, `faults.warnings.oc`, `faults.warnings.thermal`, `faults.warnings.curr_rising` |

### Page 2 — Faults & Control

| Section | Component | Fields consumed |
|---|---|---|
| Header | FSM state badge | `state` |
| Top grid | Fault matrix (full) | `state`, `faults.active`, `faults.over_voltage`, `faults.under_voltage`, `faults.over_current`, `faults.over_temp`, `faults.short_circuit`, `faults.warnings.*` (all 5) |
| Top grid | Alarm log | `state`, `faults.active`, `ts` |
| Mid grid | FSM flow diagram | `state` |
| Mid grid | Trip counter (3-step) | `faults.trip_count` |
| Mid grid | IDMT arc gauge | `i`, `state` (client-side estimate) |
| Mid grid | Reclose countdown | `state` (RECOVERY state triggers countdown) |
| Bottom | Reset guard (×3 checks) | `t`, `faults.active`, `sys.health_status` |
| Bottom | Relay toggle + override banner | `relay`, `state` |
| Bottom | Protection arc gauge | client-side IDMT estimate |

### Page 3 — Diagnostics

| Section | Component | Fields consumed |
|---|---|---|
| Row 1 | Health honeycomb (×5 cells) | `health`, `diagnostics.voltage_stability`, `diagnostics.current_stability`, `diagnostics.temp_stability`, `diagnostics.system_health` |
| Row 2 | Power quality radar (pentagon) | `diagnostics.power_quality_label`, `pf`, `freq`, `diagnostics.voltage_stability` |
| Row 2 | Voltage channel bars | `diagnostics.voltage_stability` |
| Row 2 | Current channel bars | `diagnostics.current_stability` |
| Row 2 | Temperature channel bars | `diagnostics.temp_stability`, `t` |
| Row 3 | ADC calibration badge | `diagnostics.adc_health` |
| Row 3 | ADC health score | `diagnostics.adc_health` |
| Row 3 | ADC linearity error bar | `diagnostics.adc_health` (derived) |
| Row 3 | ADC saturation events | `state` (FAULT proxy) |
| Row 3 | ADC sample count | `sys.uptime_s` (derived: uptime × 1000) |
| Row 4 | Free heap bar | `sys.free_heap`, `sys.heap_healthy` |
| Row 4 | CPU load panel + sparkline | `sys.cpu_load_pct` |
| Row 4 | Uptime ring | `sys.uptime_s`, `sys.uptime_quality` |
| Row 4 | Signal confidence bars (×3) | `diagnostics.voltage_stability`, `diagnostics.current_stability`, `diagnostics.temp_stability` |
| Row 5 | Protection parameters | `GET /api/config` (one-time fetch on mount) |

### Page 4 — Cloud / MQTT

| Section | Component | Fields consumed |
|---|---|---|
| Row 1 | Connection dot + label | `mqtt.connected` |
| Row 1 | Messages Sent counter | `mqtt.publish_total` |
| Row 1 | Failed Publishes counter | `mqtt.publish_failed` |
| Row 1 | Reconnects counter | `mqtt.connect_attempts` |
| Row 1 | Success Rate | `mqtt.publish_total`, `mqtt.publish_failed` (derived) |
| Row 1 | Last published timestamp | `ts` |
| Row 1 | Broker pill | `device`, `mqtt.connected` |
| Row 1 | TLS badge | `mqtt.tls` |
| Row 2 | Signal path diagram (4 nodes) | `wifi.connected`, `mqtt.connected`, `state` |
| Row 3 | MQTT payload inspector (last 20) | full telemetry object (display only) |

### Page 5 — Analytics

| Section | Component | Fields consumed |
|---|---|---|
| All charts | Time-series line/area charts | `GET /api/history?field=v` — voltage |
| All charts | Time-series line/area charts | `GET /api/history?field=i` — current |
| All charts | Time-series line/area charts | `GET /api/history?field=t` — temperature |
| All charts | Time-series area chart | `GET /api/history?field=p` — power |
| PF bars | Power factor bar chart | `GET /api/history?field=v` + `field=i` (derived) |
| Timeline | Fault event timeline | `GET /api/history` (state transitions — future) |

---

## 24. Complete API Endpoint Reference (Updated)

| Method | Path | Direction | Required | Purpose |
|---|---|---|---|---|
| `WS` | `/ws/telemetry` | ESP32 → Dashboard | Recommended | Primary push transport at 1–2 Hz. Fallback to HTTP if absent. |
| `GET` | `/api/telemetry` | ESP32 → Dashboard | **Yes** | HTTP fallback transport. Polled at 100 ms when WS unavailable. |
| `POST` | `/api/relay` | Dashboard → ESP32 | **Yes** | Open or close the protection relay. |
| `POST` | `/api/reset` | Dashboard → ESP32 | **Yes** | Three commands: `reset` / `reboot` / `ping`. |
| `POST` | `/api/alarm/ack` | Dashboard → ESP32 | Optional | Acknowledge a single alarm. Local fallback exists. |
| `POST` | `/api/alarm/ack/all` | Dashboard → ESP32 | Optional | Acknowledge all alarms. Local fallback exists. |
| `GET` | `/api/config` | ESP32 → Dashboard | Optional | Protection thresholds. Fetched once by Page 3 on mount. |
| `GET` | `/api/history` | ESP32 → Dashboard | Optional | Historical time-series for Page 5 analytics. Buffer fallback exists. |

---

## 25. Complete Minimum Viable Telemetry (All Pages Functional)

This payload makes every component across all 5 pages render without
any dashes, blanks, or error states. Use this as your firmware starting
point and refine individual fields as you implement them.

```json
{
  "device":   "sgs-01",
  "schema_v": "1.3",
  "ts":       1700000000000,

  "v":    230.0,
  "i":    12.0,
  "t":    43.0,
  "p":    2530,
  "va":   2750,
  "e":    0.0,
  "pf":   0.92,
  "freq": 50.00,

  "relay":  true,
  "state":  "NORMAL",
  "health": 87,
  "uptime": 0,

  "faults": {
    "active":        "NONE",
    "trip_count":    0,
    "over_voltage":  false,
    "under_voltage": false,
    "over_current":  false,
    "over_temp":     false,
    "short_circuit": false,
    "inrush":        false,
    "warnings": {
      "ov": false, "uv": false, "oc": false,
      "thermal": false, "curr_rising": false
    }
  },

  "prediction": {
    "fault_probability": 0,
    "risk_level": "LOW"
  },

  "wifi": {
    "connected": true,
    "rssi":      -60,
    "ip":        "192.168.1.100"
  },

  "mqtt": {
    "connected":         false,
    "tls":               false,
    "publish_total":     0,
    "publish_failed":    0,
    "connect_attempts":  0,
    "connect_successes": 0
  },

  "sys": {
    "uptime_s":       0,
    "free_heap":      200000,
    "cpu_load_pct":   0.0,
    "health_score":   87,
    "health_status":  "HEALTHY",
    "uptime_quality": "WARMING_UP",
    "heap_healthy":   true
  },

  "diagnostics": {
    "voltage_stability":   90,
    "current_stability":   90,
    "temp_stability":      90,
    "adc_health":          90,
    "system_health":       87,
    "power_quality_label": "GOOD"
  }
}
```

### Fields you can add later without breaking anything

| Field | Notes |
|---|---|
| `e` → accumulating value | Start at 0; increment each tick by `(p / 3600000) × interval_ms` |
| `va`, `pf` → if not computing PF | Set `va = v × i`, `pf = p / va` |
| `freq` → if no frequency counter | Hardcode 50.00 (or 60.00 for 60 Hz grid) |
| `mqtt.*` fields → if MQTT not implemented | Send all zeros and `false` |
| `diagnostics.adc_health` → if not computed | Mirror `diagnostics.voltage_stability` |
| `prediction.fault_probability` → if ML not implemented | Always send 0 |
| `sys.uptime_quality` | Compute from `uptime_s`: < 300 s → `"WARMING_UP"`, < 3600 s → `"SETTLING"`, else → `"STABLE"` |

---

*End of document. Generated from full source audit of all 16 dashboard
JavaScript modules. Version: Phase 5 complete.*