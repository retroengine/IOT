# FUTURE_PLANS.md — Smart Grid Sentinel Roadmap
## MQTT-Only Migration, Backend Architecture, and Known Challenges

---

## Current Architecture (Phase 1 — Complete)

```
ESP32
  │ WebSocket push (100ms, LAN)
  │ MQTT TLS (5s, HiveMQ Cloud)
  ▼
relay-server (Node.js, runs on your PC)
  │ WebSocket (100ms, localhost)
  ▼
Browser dashboard
```

**Limitation:** The relay server must run on your PC. The PC must be on the same LAN as the ESP32 for the WebSocket source to work. If the PC is off, there is no dashboard.

---

## Phase: Full MQTT Migration

### The Goal

Remove the relay server entirely. The browser connects directly to HiveMQ Cloud via MQTT over WebSocket. Data flows from ESP32 → HiveMQ → Browser with no intermediary running on your PC.

```
ESP32
  │ MQTT TLS (5s, HiveMQ Cloud 8883)
  ▼
HiveMQ Cloud (always-on broker)
  │ MQTT WSS (wss://...hivemq.cloud:8884/mqtt)
  ▼
Browser dashboard (anywhere in the world)
```

### What Already Exists

The browser-side MQTT WSS client is already implemented in `telemetryPoller.js` (Phase 7 section). It implements full MQTT 3.1.1 binary framing over WebSocket with no external library. It is currently activated only from the Page 4 credential form.

The ESP32 firmware already publishes to `sgs/device/sgs-XXXXXX/telemetry` every 5 seconds over TLS.

### What Needs to Change

**1. Firmware: increase MQTT publish rate**

Currently `MQTT_PUB_INTERVAL_MS = 5000` (5 seconds). For a smooth waveform via MQTT-only, this needs to be 500ms–1000ms. HiveMQ Cloud free tier allows up to 10 messages/second per connection.

```cpp
// config.h
#define MQTT_PUB_INTERVAL_MS  500   // publish every 500ms
```

Tradeoff: 500ms means the waveform updates at 2Hz instead of 10Hz. The waveform will look less smooth than the current WebSocket approach. For monitoring purposes this is acceptable. For true oscilloscope-quality display, WebSocket is the correct architecture.

**2. Dashboard: make MQTT the default transport**

In `main.js`, change `_initTelemetry()` to connect via MQTT WSS instead of relay server WebSocket when not in DEV_MODE.

```javascript
// main.js — new _initTelemetry() for MQTT-primary mode
function _initTelemetry() {
  if (DEV_MODE) {
    startMockPoller(500, _onData);
    return;
  }

  // Load credentials from localStorage (set by user in Page 4)
  const brokerUrl    = localStorage.getItem('sgs_mqtt_broker');
  const username     = localStorage.getItem('sgs_mqtt_user');
  const topicFilter  = localStorage.getItem('sgs_mqtt_topic') || 'sgs/device/+/telemetry';

  if (brokerUrl && username) {
    // MQTT WSS direct — no relay server needed
    telemetryPoller.connectMqtt({
      brokerUrl,
      username,
      password:     sessionStorage.getItem('sgs_mqtt_pass'),  // session only
      topicFilter,
    });
  } else {
    // Fall back to relay server if no MQTT credentials configured
    telemetryPoller.connect('localhost:3000');
  }
}
```

**3. Remove relay-server dependency for basic operation**

The dashboard HTML/JS can be hosted on any static host (GitHub Pages, Netlify, Cloudflare Pages) and still receive live data via MQTT WSS from anywhere in the world.

### MQTT-Only Challenges

**Challenge 1: 5-second publish interval causes waveform gaps**

The waveform buffer holds 120 samples. At 2Hz (500ms interval), 120 samples = 60 seconds of history. The waveform will scroll slowly. The dips you see today will appear as large plateaus between data points. Acceptable for alarm monitoring, not ideal for signal quality inspection.

Solution path: implement a dedicated high-rate MQTT topic for waveform data at 5Hz, separate from the full telemetry topic at 0.2Hz. HiveMQ free tier allows this.

```
sgs/device/<id>/telemetry    → full JSON, 5s interval (all dashboard fields)
sgs/device/<id>/waveform     → minimal JSON {v, i, ts}, 200ms interval (waveform only)
```

**Challenge 2: HiveMQ Cloud free tier limits**

HiveMQ Cloud free tier (as of 2025):
- 100 concurrent connections
- 10 messages/second per connection
- 10 GB data transfer/month
- No guaranteed uptime SLA

At 500ms publish rate: 2 msg/s × 2745 bytes = ~5.5 KB/s = ~14 GB/month. This exceeds the free tier data limit. Options: reduce payload size with short-key minification (`"sk":1`), reduce publish rate to 2s, or upgrade to paid tier.

**Challenge 3: No relay control over MQTT**

The current relay control works via `POST /api/relay` → ESP32 HTTP. Over MQTT, commands go through `sgs/device/<id>/cmd`. The firmware already subscribes to this topic and handles `{"cmd": "reset"}` and `{"cmd": "reboot"}`. The relay command handler needs to be added:

```cpp
// mqtt_client.cpp — onMqttMessage()
if (strcmp(cmd, "relay") == 0) {
    bool desired = doc["state"] | false;
    RelayControl::setAPIOverride(desired);
}
```

The dashboard relay toggle currently POSTs to the ESP32 HTTP API. In MQTT-only mode, it needs to publish to the command topic instead. The fetch interceptor in `main.js` would need to be replaced with an MQTT publish call for relay commands.

**Challenge 4: No direct CORS issue, but authentication changes**

In the current setup, the API key (`X-API-Key`) protects the ESP32 REST endpoints. In MQTT-only mode, authentication is via HiveMQ username/password. The API key mechanism becomes irrelevant for read operations. For write operations (relay control), the MQTT ACL on HiveMQ must be configured to allow publish to the command topic only from authenticated users.

**Challenge 5: Latency**

ESP32 → HiveMQ Cloud (India to EU): ~150–250ms round trip. The relay toggle will feel slower than the current LAN HTTP which responds in <10ms. This is a fundamental limitation of cloud relay architecture.

---

## Phase: Backend Server + Database

### Why It's Needed

The analytics page (Page 5) currently falls back to the 60-sample live buffer because there is no `GET /api/history` implementation. To show 1H, 6H, 24H, 7D, 30D charts, historical data must be stored persistently.

The ESP32 NVS ring buffer holds 50 events — not continuous time-series data. It cannot serve historical analytics.

### Proposed Architecture

```
ESP32
  │ MQTT TLS
  ▼
HiveMQ Cloud
  │ MQTT subscription
  ▼
Backend Server (Node.js / Python)
  │ Write
  ▼
Time-Series Database (InfluxDB / TimescaleDB / SQLite)
  │ Read
  ▼
GET /api/history endpoint
  │
  ▼
Browser dashboard Page 5
```

### Implementation Options

**Option A: Lightweight (SQLite + Node.js)**

Lowest complexity. Runs on a Raspberry Pi or any always-on machine. Stores telemetry in SQLite with timestamp index. Serves `/api/history` via Express.

```javascript
// backend/subscriber.js
mqtt_client.subscribe('sgs/device/+/telemetry');
mqtt_client.on('message', (topic, payload) => {
  const data = JSON.parse(payload);
  db.run(
    'INSERT INTO telemetry (ts, device, v, i, t, p, state) VALUES (?,?,?,?,?,?,?)',
    [data.ts, data.device, data.sensors.voltage.filtered_value, ...]
  );
});

// backend/api.js — GET /api/history
app.get('/api/history', (req, res) => {
  const { field, from, to, resolution } = req.query;
  // Query SQLite with time range, downsample to resolution points
  // Return [{ts, value}, ...]
});
```

Tradeoffs: Simple, zero cost, works offline. But SQLite is not designed for time-series — queries get slow after months of 2Hz data (~5M rows/month).

**Option B: InfluxDB (Purpose-Built Time Series)**

InfluxDB is designed exactly for this use case. Fast range queries, automatic downsampling, built-in retention policies.

```
InfluxDB free tier: unlimited local, or InfluxDB Cloud free (30-day retention)
Query language: Flux or InfluxQL
Write: line protocol via HTTP or MQTT subscription
```

Setup complexity: medium. Requires running InfluxDB locally or paying for cloud.

**Option C: Extend Relay Server**

The simplest path — add a SQLite write to `esp32WsClient.js` and an `/api/history` endpoint to `wsRelay.js`. No new server needed. Runs on the same PC.

```javascript
// relay-server/historyStore.js
import Database from 'better-sqlite3';
const db = new Database('telemetry.db');

db.exec(`CREATE TABLE IF NOT EXISTS telemetry (
  ts INTEGER, device TEXT, v REAL, i REAL, t REAL, p REAL, state TEXT
)`);

export function store(frame) {
  db.prepare(
    'INSERT INTO telemetry VALUES (?,?,?,?,?,?,?)'
  ).run(
    frame.ts, frame.device,
    frame.sensors?.voltage?.filtered_value,
    frame.sensors?.current?.filtered_value,
    frame.sensors?.temperature?.filtered_value,
    frame.power?.real_power_w,
    frame.alerts?.fsm_state
  );
}

export function query(field, fromMs, toMs, resolution) {
  // downsample: pick every Nth row to hit target resolution
  const rows = db.prepare(
    `SELECT ts, ${field} as value FROM telemetry
     WHERE ts BETWEEN ? AND ? ORDER BY ts`
  ).all(fromMs, toMs);

  const step = Math.max(1, Math.floor(rows.length / resolution));
  return rows.filter((_, i) => i % step === 0);
}
```

This is the recommended first implementation — zero new infrastructure, dashboard Page 5 starts working immediately.

### Backend Challenges

**Challenge 1: Data volume**

At 100ms push rate and 2745 bytes per frame:
- 10 frames/second × 60s = 600 frames/minute
- Storing all fields: 600 × ~50 bytes (numeric fields only) = 30 KB/minute = 1.8 MB/hour = 43 MB/day

For a SQLite file this is manageable for weeks. After months it needs retention policy (delete rows older than 30 days).

**Challenge 2: Downsampling for long time ranges**

Requesting 7D of data at 100ms resolution = 6 million data points. The browser cannot render this. The backend must downsample to the requested `resolution` parameter (default 200 points).

Simple approach: select every Nth row. Better approach: LTTB (Largest-Triangle-Three-Buckets) algorithm — preserves visual shape of the signal while reducing points.

**Challenge 3: Clock synchronisation**

The ESP32 uses `millis()` (milliseconds since boot) as its timestamp — not real wall-clock time. Without NTP, all timestamps are relative to the last reboot. After a reboot, timestamps reset to 0 and historical data becomes discontinuous.

Solution: add NTP sync to the firmware. Use `configTime()` and return Unix epoch ms as `ts`.

```cpp
// In wifi_manager.cpp after connecting
configTime(0, 19800, "pool.ntp.org");  // UTC + IST offset (5h30m = 19800s)
// Then in telemetry_builder.cpp:
struct timeval tv;
gettimeofday(&tv, nullptr);
uint64_t ts_ms = (uint64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
```

**Challenge 4: Multi-device support**

The relay server currently assumes one ESP32. The `sgs/device/+/telemetry` MQTT topic wildcard already supports multiple devices. The history store and `/api/history` endpoint would need a `device` parameter to query per-device data.

---

## Development Phases Remaining

| Phase | Description | Dependencies |
|---|---|---|
| 2 | Data Architecture — backend + SQLite history store | Node.js + better-sqlite3 |
| 3 | `/api/history` endpoint — Page 5 analytics fully functional | Phase 2 |
| 4 | NTP clock sync in firmware — real timestamps | Firmware reflash |
| 5 | MQTT-only mode — remove relay server requirement | Phase 4 + HiveMQ ACL config |
| 6 | MQTT relay control — dashboard relay toggle over MQTT | Phase 5 |
| 7 | Authentication (Phase 8 in original plan) — JWT or API key for backend | Phase 3 |
| 8 | Hosted dashboard — GitHub Pages or Netlify serving the dashboard | Phase 5 |
| 9 | Mobile-responsive layout — dashboard usable on phone | CSS work only |
| 10 | Predictive analytics — fault probability from current trend slope | Phase 2 data |

---

## Quick Win: Enable Page 5 Analytics Today

Without any backend server, Page 5 can be made useful by extending the telemetry buffer from 60 to 3600 samples and storing to `sessionStorage` — giving ~1 hour of in-memory history that survives page navigation.

```javascript
// telemetryBuffer.js — increase sparkline buffer
export const SPARKLINE_BUFFER_SIZE = 3600;  // 1hr at 1 sample/sec

// This requires no firmware changes, no backend, no database.
// The buffer lives in browser memory and resets on page refresh.
// Page 5 would show up to 1 hour of data from the current session.
```

This is a 1-line change that gives immediate value for the analytics page while the full backend implementation is built.
