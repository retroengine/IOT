# DASHBOARD.md — Smart Grid Sentinel Dashboard Reference
## Complete technical specification: pages, components, data contract, transport

---

## 1. Overview

The SGS dashboard is a 5-page single-page application served from `http://localhost:3000`. It receives live telemetry from the relay server via WebSocket, parses it through a schema-normalising parser, and distributes it to page components.

**Stack:** Vanilla JavaScript ES modules. No framework. No bundler. No build step.

**Entry point:** `dashboard_ip/index.html` → loads `main.js` as `type="module"`

---

## 2. Data Flow

```
ESP32 firmware (100ms push)
    │
    │  ws://10.x.x.x/ws/telemetry
    ▼
relay-server/esp32WsClient.js
    │
    │  dataRouter.registerEsp32WsFrame()
    ▼
relay-server/dataRouter.js
    │
    │  immediate callback — no timer
    ▼
relay-server/wsRelay.js  (broadcasts instantly)
    │
    │  ws://localhost:3000/ws/telemetry
    ▼
dashboard_ip/telemetry/telemetryPoller.js
    │
    │  parse() + bufferPush()
    ▼
dashboard_ip/telemetry/telemetryParser.js
dashboard_ip/telemetry/telemetryBuffer.js
    │
    │  _activePage.update(canonicalData)
    ▼
Active page component (page1-status.js etc.)
    │
    │  component.update(data)
    ▼
DOM updates / canvas redraws
```

---

## 3. File Structure

```
dashboard_ip/
├── index.html              Entry point, all page containers, nav
├── main.js                 Router, telemetry bootstrap, fetch interceptor
├── tokens.css              Design tokens (CSS variables) — FROZEN
├── effects.css             Animation classes — FROZEN
│
├── telemetry/
│   ├── telemetryPoller.js  WS + HTTP fallback transport, MQTT WSS
│   ├── telemetryParser.js  Schema normaliser (v1.3 verbose → canonical flat)
│   ├── telemetryBuffer.js  Ring buffers for waveform (120) and sparkline (60)
│   ├── historyPoller.js    /api/history fetcher with cache + buffer fallback
│   └── mockData.js         Synthetic telemetry for DEV_MODE (file://)
│
├── pages/
│   ├── page1-status.js     Live monitoring
│   ├── page2-faults.js     Fault matrix, alarm log, relay control
│   ├── page3-diagnostics.js Sensor health, ADC, power quality
│   ├── page4-cloud.js      MQTT connection, payload inspector
│   └── page5-analytics.js  Historical charts, CSV export
│
├── components/             Reusable UI components (arcGauge, sparkline, etc.)
├── rendering/              canvasEngine.js, svgEngine.js, animationLoop.js
└── utils/
    └── apiAuth.js          API key storage (localStorage)
```

---

## 4. DEV_MODE Detection

```javascript
// main.js
const _isRelayServer =
  window.location.hostname === 'localhost' &&
  window.location.port === '3000';

const DEV_MODE = FORCE_DEV_MODE || (
  !_isRelayServer && (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === '' ||       // file://
    window.location.protocol  === 'file:'
  )
);
```

| Origin | DEV_MODE | Data source |
|---|---|---|
| `http://localhost:3000` | false | Relay server WebSocket (real data) |
| `file:///...` | true | mockData.js (synthetic) |
| `http://localhost` (no port) | true | mockData.js |
| `http://10.x.x.x` (ESP32 IP) | false | Direct ESP32 WebSocket |

---

## 5. Telemetry Parser

`telemetryParser.js` accepts three input formats and always outputs one canonical shape.

### Input Format 1 — Firmware Verbose v1.3 (what the ESP32 sends)

```json
{
  "sensors": { "voltage": { "filtered_value": 230.5 }, ... },
  "power": { "real_power_w": 2834, ... },
  "alerts": { "fsm_state": "NORMAL", ... },
  "loads": { "relay1": { "state": true } },
  "diagnostics": { "system_health": { "overall_health_score": 87 }, ... }
}
```

### Input Format 2 — Canonical Flat (mockData / tests)

```json
{ "v": 230.5, "i": 12.3, "t": 45.2, "state": "NORMAL", "relay": true, ... }
```

### Canonical Output Shape (all pages receive this)

```javascript
{
  v, i, t, p, va, e, pf, freq,    // primary measurements
  state, relay, health, uptime,   // protection / status
  faults: {
    active, trip_count,
    over_voltage, under_voltage, over_current, over_temp,
    short_circuit, inrush,
    warnings: { ov, uv, oc, thermal, curr_rising }
  },
  prediction: { fault_probability, risk_level },
  wifi:  { connected, rssi, ip },
  mqtt:  { connected, tls, publish_total, publish_failed, ... },
  sys:   { uptime_s, free_heap, cpu_load_pct, health_score, health_status, uptime_quality, heap_healthy },
  diagnostics: { voltage_stability, current_stability, temp_stability, adc_health, system_health, power_quality_label },
  schema_v, device, ts
}
```

### Clamp Ranges

| Field | Min | Max |
|---|---|---|
| v | 0 | 300 |
| i | 0 | 100 |
| t | -40 | 150 |
| p, va | 0 | 50000 |
| pf | 0 | 1 |
| freq | 45 | 65 |
| health, all scores | 0 | 100 |
| rssi | -120 | 0 |

---

## 6. Telemetry Buffer

Ring buffers between the poller and rendering components. Components never read from the poller directly — always from the buffer.

```javascript
// telemetryBuffer.js
WAVEFORM_BUFFER_SIZE  = 120   // ~12s at 10Hz — used by waveformCard
SPARKLINE_BUFFER_SIZE =  60   // ~120s at 0.5Hz — used by sparkline

// push(field, value, timestamp)  — called by telemetryPoller on every frame
// getWaveform(field)             → Array<{value, timestamp}>
// getSparkline(field)            → number[]

// Tracked fields: 'v', 'i', 't', 'p'
```

---

## 7. Connection States

```
IDLE → CONNECTING → OPEN (WebSocket active, data flowing)
              ↓ on failure
        RECONNECTING (exponential backoff: 500ms → 1s → 2s → 4s → 30s cap)
              ↓ after 3 failures
        HTTP_FALLBACK (polls /api/telemetry at localhost:3000 every 100ms)
              ↓ when WS recovers
        OPEN (WS resumes, HTTP stops)
```

### Data Stream Watchdog

```javascript
// Added in Phase 1 fix
const DATA_WATCHDOG_MS = 10000;  // 10s = 100 missed frames at 100ms rate

// Every incoming frame resets the timer
// If 10s pass with zero frames → reconnect
// This replaces ping/pong as the primary liveness mechanism
```

---

## 8. Pages

### Page 1 — Status

**Purpose:** Live monitoring of all primary measurements.

**Key components:**
- `stateBadge` — FSM state with colour and pulse animation
- `waveformCard` — canvas oscilloscope (voltage + current from buffer, 120 samples)
- `arcGauge` — voltage, current, temperature, PF, health (configurable field)
- `sparkline` — temperature, frequency, PF (60-sample bar charts)
- `hexHealthCell` — 5 cells: voltage, current, thermal, ADC, power scores
- `energyFlowMap` — animated SVG node diagram showing relay state and power flow
- `faultIndicator` — 10 active fault flags
- `relayToggle` — POST /api/relay

**Data consumed:** v, i, t, p, va, e, pf, freq, state, relay, health, faults.*, wifi.*, sys.uptime_s, diagnostics.*

### Page 2 — Faults & Control

**Purpose:** Protection system status and operator control.

**Key components:**
- `faultMatrix` — grid of all fault and warning conditions with pulse on active
- `alarmLog` — scrollable timestamped event log (stored in memory, not ESP32)
- FSM flow diagram — 6-state diagram with current state highlighted
- Trip counter — 3-step visual showing trips toward LOCKOUT
- IDMT arc gauge — client-side estimate of overcurrent accumulation
- Reclose countdown — timer showing time until next auto-reclose attempt
- Reset guard — 3 conditions checked before enabling reset button
- `relayToggle` — POST /api/relay with override banner during FSM-forced state

**Reset guard conditions:**
1. Temperature `t` < 85°C (thermal lockout — physical inspection required above this)
2. `faults.active` ≠ `"SENSOR_FAIL"` (cannot operate safely without sensors)
3. `sys.health_status` ≠ `"CRITICAL"` (system integrity compromised)

### Page 3 — Diagnostics

**Purpose:** Sensor health, ADC quality, system vitals, protection configuration.

**Key components:**
- Health honeycomb — 5 hexagonal cells with arc fill (score → colour ramp)
- Power quality radar — pentagon: voltage stability, current stability, thermal, PF, frequency
- Sensor channel bars — noise floor, SNR, stability score per channel
- ADC panel — calibration type badge, health score, saturation events, sample count
- System vitals — free heap bar, CPU load sparkline, uptime ring
- Protection parameters — fetched once from `GET /api/config`

**Health score → colour ramp:**
| Score | Colour | CSS variable |
|---|---|---|
| 90–100 | Green | `--health-excellent` |
| 70–89 | Dark green | `--health-good` |
| 50–69 | Amber | `--health-degraded` |
| 30–49 | Orange | `--health-poor` |
| 0–29 | Red | `--health-critical` |

### Page 4 — Cloud / MQTT

**Purpose:** Monitor cloud connectivity and inspect raw telemetry.

**Key components:**
- Connection metrics — messages sent, failed, reconnects, success rate, TLS badge
- Signal path diagram — 4-node SVG: ESP32 → WiFi → HiveMQ → Dashboard
- MQTT payload inspector — last 20 received frames with JSON syntax highlighting
- Credential form — user enters HiveMQ WSS credentials to enable MQTT WSS transport

**MQTT WSS from browser (direct, bypasses relay server):**
Connects to `wss://...hivemq.cloud:8884/mqtt` directly from the browser using native MQTT 3.1.1 binary framing over WebSocket. No library needed — implemented in `telemetryPoller.js`.

### Page 5 — Analytics

**Purpose:** Historical time-series charts.

**Key components:**
- 6 time-series charts: voltage, current, temperature, power, PF, fault timeline
- Time range selectors: 1H, 6H, 24H, 7D, 30D
- CSV export button
- `historyPoller.js` — fetches `GET /api/history?field=v&from=...&to=...&resolution=200`

**Fallback:** If `/api/history` returns 404, the analytics page uses the live telemetryBuffer (last ~60 samples). Charts always render — they never show an error state.

---

## 9. API Endpoints Consumed by Dashboard

| Method | Path | Server | Purpose |
|---|---|---|---|
| WS | `ws://localhost:3000/ws/telemetry` | relay-server | Primary telemetry transport |
| GET | `http://localhost:3000/api/telemetry` | relay-server | HTTP fallback during WS reconnect |
| GET | `http://10.x.x.x/api/config` | ESP32 | Protection thresholds (Page 3, once) |
| POST | `http://10.x.x.x/api/relay` | ESP32 | Relay control |
| POST | `http://10.x.x.x/api/reset` | ESP32 | FSM reset / reboot / ping |
| GET | `http://localhost:3000/api/history` | relay-server | Historical data (Page 5, not implemented) |
| WS | `wss://...hivemq.cloud:8884/mqtt` | HiveMQ | Direct MQTT WSS (Page 4 optional) |

---

## 10. Design Tokens

All colours, spacing, and typography are defined as CSS variables in `tokens.css`. No hardcoded hex values anywhere in the codebase. `effects.css` contains all animation classes referencing these tokens. Both files are frozen after Phase 1.

**State colours:**

| State | Variable | Value |
|---|---|---|
| BOOT | `--state-boot` | `#3B8BD4` (blue) |
| NORMAL | `--state-normal` | `#1D9E75` (green) |
| WARNING | `--state-warning` | `#EF9F27` (amber) |
| FAULT | `--state-fault` | `#E24B4A` (red) |
| RECOVERY | `--state-recovery` | `#1D9E75` (teal) |
| LOCKOUT | `--state-lockout` | `#A32D2D` (dark red) |

---

## 11. Authentication

API key is stored in `localStorage` key `sgs_api_key`. A `fetch` interceptor in `main.js` injects `X-API-Key: <key>` on every same-origin request automatically. No component needs to handle auth manually.

First-run banner prompts user to enter API key. Key is found on ESP32 Serial monitor at boot: `[API] key: aec158f34ad787c`.