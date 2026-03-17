# SGS — things to fix / add
> started: march 2026  
> status: ongoing  
> this is not sorted by module, sorted by "how bad will i feel if i ship without this"

---

## the big picture — whats actually missing

```
current SGS feature completeness (rough estimate)

 Protection logic    ████████████████████  100%  ✓ done, solid
 Sensor validation   ████████████████████  100%  ✓ done
 FSM / relay         ████████████████████  100%  ✓ done
 RTOS architecture   ████████████████████  100%  ✓ done
 REST API            ████████████████████  100%  ✓ done
 MQTT basics         ████████████░░░░░░░░   60%  ← missing LWT, retained, session
 Time / NTP          ██░░░░░░░░░░░░░░░░░░   10%  ← ts field exists, sync doesn't
 OTA updates         ░░░░░░░░░░░░░░░░░░░░    0%  ← not started
 Data persistence    ░░░░░░░░░░░░░░░░░░░░    0%  ← telemetry goes nowhere
 Alerting            ░░░░░░░░░░░░░░░░░░░░    0%  ← no push notifications
 Network discovery   ░░░░░░░░░░░░░░░░░░░░    0%  ← no mDNS
```

---

## P0 — breaks things in production, fix before deploying

### [ ] NTP time sync

timestamps in telemetry are wrong right now. `"ts": 1234567890` is not wall clock,
its just whatever the ESP32 thinks time is since boot. every fault log entry has
a garbage timestamp. this is probably the most embarrassing bug to explain to anyone.

```
current state (BROKEN):
  boot → ts = 0
  uptime 1hr → ts = 3600
  logs say fault happened at "epoch 3600" which means nothing

what it should look like:
  boot → configTime() → SNTP sync → ts = 1742123456 (real unix time)
  log says fault at "2026-03-17 14:32:11 IST" ← actually useful
```

what to do:
- call `configTime(19800, 0, "pool.ntp.org", "time.google.com")` in setup
  - 19800 = UTC+5:30 offset in seconds (IST)
- wait for sync before allowing telemetry publish (sntp_get_sync_status)
- add `time_synced: true/false` field to telemetry JSON
- store last known good time in NVS so short reboots dont lose time context
- fallback: if NTP unreachable after 30s, still boot normally, just mark ts as unsynced

```
NTP sync flow:
  wifi connected
       │
       ▼
  configTime(IST offset)
       │
       ├── sync OK (< 30s) ──► set time_synced=true, ts = real unix time
       │
       └── timeout ──────────► set time_synced=false, ts = uptime_s
                                log warning, retry every 5min
```

---

### [ ] MQTT last will and testament

right now if the ESP32 crashes, loses power, or WDT fires — HiveMQ has NO idea.
the dashboard will show the last published state (probably NORMAL) forever.
anyone monitoring will think the device is fine when its actually dead on the floor.

LWT is set during CONNECT — broker publishes it automatically on ungraceful disconnect.
zero server-side changes needed.

```cpp
// in mqtt init, before connect()
mqttClient.setWill(
    "sgs/device/sgs-XXXXXX/state",   // topic
    "{\"fsm\":\"OFFLINE\",\"reason\":\"unexpected_disconnect\"}",
    1,       // QoS 1
    true     // retain = true  ← important
);
```

what happens with vs without:

```
WITHOUT LWT:
  device crashes ──► broker silent ──► dashboard shows NORMAL ──► user confused
  (could be hours before anyone notices)

WITH LWT:
  device crashes ──► broker publishes OFFLINE to /state (retained)
                 ──► dashboard shows OFFLINE immediately
                 ──► push alert fires (once alerting is set up)
```

also add a proper "coming online" message on successful connect:
```cpp
// publish this right after successful connect
publish("/state", "{\"fsm\":\"BOOT\",\"reason\":\"connected\"}", retain=true);
```

---

### [ ] retained messages on /state and /fault topics

related to LWT but separate issue. right now:
- device publishes fault at 14:00
- someone opens dashboard at 14:05
- they see nothing — they missed the message

retained messages fix this. broker caches the last message on a topic.
any new subscriber gets it immediately on subscribe.

```
WITHOUT retain:
  device ──publish──► broker ──► [nobody subscribed right now, message lost]
  user subscribes at t+5min ──► sees nothing

WITH retain (retain=true):
  device ──publish──► broker stores it
  user subscribes at t+5min ──► broker immediately delivers cached message
```

topics that NEED retain=true:
- `/state` ← always, every publish
- `/fault` ← always, every publish
- LWT message ← already noted above

topics where retain is optional / not useful:
- `/telemetry` ← 5s periodic, stale data not useful to cache

one line change per publish call. no broker config needed on HiveMQ cloud.

---

## P1 — will annoy you badly within a week of running

### [ ] persistent MQTT session (cleanSession = false)

current setup uses cleanSession=true (default). this means:
- device goes offline (reclose, fault, power blip)
- someone sends `reset` command via MQTT
- device comes back online
- **command is gone**. broker deleted it.

with cleanSession=false + consistent client ID:
- broker queues QoS1 messages while device is offline
- device reconnects → receives queued `reset` command
- actually useful for remote management of a device that trips and recovers

```
cleanSession=true (current):
  cmd published ──► broker discards on disconnect ──► device never sees it

cleanSession=false:
  cmd published ──► broker queues (QoS1)
  device reconnects ──► broker delivers queued cmd ──► reset executed
```

what to do:
- set `cleanSession=false` in mqtt client config
- make sure client ID is deterministic (use MAC address) ← already done: `sgs-{MAC}`
- test: send reset command while device is in a 15s reclose dead time → should execute on reconnect

---

### [ ] OTA firmware update

this is the one that will hurt the most when you have a deployed unit and need to
push a fix. right now the only way to update is physical USB flash. not viable.

```
OTA update flow:

  new firmware.bin
       │
       ▼
  host on GitHub releases / S3 / any HTTPS URL
       │
  MQTT cmd: {"cmd":"ota","url":"https://..."}   OR   periodic version check
       │
       ▼
  esp_https_ota_begin()
       │
       ├── download & verify ──► partition swap ──► reboot into new firmware
       │
       └── fail ──────────────► stay on current firmware, publish error to /fault

rollback safety:
  esp_ota has two app partitions (ota_0, ota_1)
  if new firmware crashes before calling esp_ota_mark_app_valid_cancel_rollback()
  next boot automatically reverts to previous firmware
  add that call after protection task confirms sensors are OK (~5s post boot)
```

partition table change needed in platformio.ini or idf:
```
# boards/esp32 default 4MB partitions.csv — swap to OTA-capable layout
# default_8MB.csv or a custom one with two 1.8MB app partitions
```

minimum viable implementation:
- add MQTT command `ota` with a URL field
- use `esp_https_ota` (built into ESP-IDF)
- publish progress to `/state` topic: `{"fsm":"OTA","progress":45}`
- open both relays before starting OTA (protection cannot run during flash)
- mark valid after successful boot + sensor check

---

### [ ] fw_version in telemetry + config

right now the telemetry JSON has no firmware version field. once OTA is running
you'll have no idea which devices are on which version. add to config.h:

```cpp
#define FW_VERSION_MAJOR  1
#define FW_VERSION_MINOR  4
#define FW_VERSION_PATCH  0
#define FW_VERSION_STR    "1.4.0"
```

add to telemetry schema:
```json
"device": {
    "fw_version": "1.4.0",
    "hw_revision": "r2",
    "chip_id": "a1b2c3",
    "idf_version": "5.1.2"
}
```

---

## P2 — quality of life stuff, missing but not on fire

### [ ] mDNS local discovery

right now to reach the REST API you need to know the IP. annoying when DHCP
gives it a new address after a router reboot.

```
without mDNS:
  user needs to: check router DHCP table → find 192.168.1.47 → type it in

with mDNS:
  http://sgs-a1b2c3.local/api/telemetry  ← always works on local network
```

```cpp
#include <ESPmDNS.h>

// in setup(), after wifi connects:
MDNS.begin("sgs-" + deviceMac.substring(6));  // → sgs-a1b2c3.local
MDNS.addService("http", "tcp", 80);
MDNS.addService("https", "tcp", 443);  // future
```

also register the service type so network scanners can auto-discover SGS devices.

---

### [ ] time-series data pipeline

HiveMQ is a broker, not a database. right now every telemetry message published
is gone 5 seconds later. there is no historical data anywhere.

```
what we have:
  ESP32 ──MQTT──► HiveMQ Cloud ──► [messages evaporate]

what we want:
  ESP32 ──MQTT──► HiveMQ Cloud ──► Node-RED / MQTT bridge
                                         │
                                         ▼
                               InfluxDB (time-series DB)
                                         │
                                         ▼
                                  Grafana dashboard
                                  (voltage history, trip events, temp trends)
```

minimum viable pipeline options (pick one):
- **Node-RED** on a raspberry pi / VPS: easiest, visual, no code
- **Telegraf** MQTT input → InfluxDB output: one config file, very reliable
- **HiveMQ Webhook** → custom endpoint → any DB: no extra broker needed

what to visualise once pipeline is up:

```
  example grafana panels for SGS:

  panel 1: voltage over time
  │ 260                              ┌─┐
  │ 250            ┌─┐               │ │
  │ 240 ───────────┘ └───────────────┘ └──────
  │ 230
  │ 220
  └──────────────────────────────────────────► time

  panel 2: trip events (vertical markers)
  │     │           │              │
  │     ▼ FAULT     ▼ FAULT        ▼ LOCKOUT
  └──────────────────────────────────────────► time

  panel 3: enclosure temperature
  │  85°C ·····················  FAULT threshold
  │  70°C ·····················  WARN threshold
  │  45°C ────────────────────────────────────
  └──────────────────────────────────────────► time

  panel 4: IDMT accumulator (live)
  │  1.0 ·····················  TRIP threshold
  │  0.5
  │  0.0 ────────────────────────────────────
  └──────────────────────────────────────────► time
```

---

### [ ] push notifications on fault

no alerting path exists right now. a fault can sit in LOCKOUT overnight with
nobody knowing. options (in order of easiness):

```
option A — HiveMQ Webhooks (zero ESP32 changes):
  HiveMQ Cloud → on message to /fault topic → POST to ntfy.sh or pushover API
  setup is entirely on the broker side, ESP32 unchanged

option B — Node-RED alert node:
  if /fault message received AND fsm != NORMAL → send telegram / email / ntfy

option C — ESP32 direct HTTP POST (not recommended):
  adds complexity to Core1, could slow MQTT, complicates TLS cert management
  avoid unless broker-side options don't work

recommended: ntfy.sh is free, has android/iOS apps, dead simple API
  POST https://ntfy.sh/sgs-your-topic  body: "FAULT: OVERVOLTAGE at 14:32"
```

---

### [ ] HTTPS for REST API (or at minimum a note in docs)

current REST API transmits X-API-Key in plaintext HTTP headers on LAN.
ESPAsyncWebServer TLS support is poor — the practical mitigations are:

option 1 (recommended): document clearly that API is LAN-only, block port 80
from WAN at router level, note in README

option 2: nginx reverse proxy on a local machine with self-signed cert

option 3: mTLS — embed client cert on dashboard, only accept from that cert.
significant complexity, probably overkill for home use.

for now: just add a clear warning in the captive portal and docs.

---

## P3 — future / nice to have, not blocking anything

### [ ] device shadow / desired-reported config

for multi-device deployments. lets you push new config (IDMT TMS, OV thresholds)
to devices without SSH/flashing. single device doesnt need this yet.

```
shadow pattern:
  desired state (set from dashboard):
    {"config": {"idmt_tms": 0.12, "ov_fault_v": 250}}

  reported state (device publishes):
    {"config": {"idmt_tms": 0.10, "ov_fault_v": 253}}

  delta: device sees difference → applies desired → updates reported
```

skip for now, revisit when > 1 device deployed.

---

### [ ] calibration endpoint

right now ADC calibration quality is reported but there's no way to trigger
a recalibration over API. add:

```
POST /api/calibrate
  body: {"channel": "voltage", "known_v": 231.4}
  → stores scaling correction factor in NVS
  → applies on next boot
```

useful when sensor drift is detected in /api/diagnostics.

---

### [ ] config hot-reload via API

right now changing any threshold (OV_FAULT_V, IDMT_TMS etc) requires reflash.
add:

```
POST /api/config
  body: {"ov_fault_v": 250, "idmt_tms": 0.12}
  → validate range → store in NVS → apply at next tick
  → publish config_changed event to MQTT /state topic
```

store in NVS namespace "sgs_cfg", fall back to config.h defaults if NVS empty.

---

### [ ] watchdog reboot counter + reason logging

ESP32 has a reset reason register. right now SGS logs FSM transitions but
not WHY the device rebooted. after an OTA or WDT panic, you want to know.

```cpp
esp_reset_reason_t reason = esp_reset_reason();
// log to NVS on boot:
// ESP_RST_WDT → "watchdog" ← bad, investigate
// ESP_RST_PANIC → "panic" ← very bad
// ESP_RST_SW → "software/ota" ← expected
// ESP_RST_POWERON → "power cycle" ← normal
```

add to telemetry: `"last_reset_reason": "power_cycle"` and `"wdt_trips": 0`

---

## summary / priority order

```
  ┌─────┬────────────────────────────────┬──────────┬───────────┐
  │  #  │ item                           │ priority │ effort    │
  ├─────┼────────────────────────────────┼──────────┼───────────┤
  │  1  │ NTP time sync                  │  P0      │ low       │
  │  2  │ MQTT LWT                       │  P0      │ low       │
  │  3  │ retained messages /state /fault│  P0      │ trivial   │
  │  4  │ persistent MQTT session        │  P1      │ low       │
  │  5  │ OTA firmware update            │  P1      │ high      │
  │  6  │ fw_version in telemetry        │  P1      │ trivial   │
  │  7  │ mDNS local discovery           │  P2      │ low       │
  │  8  │ time-series data pipeline      │  P2      │ medium    │
  │  9  │ push notifications on fault    │  P2      │ medium    │
  │ 10  │ HTTPS / API key warning        │  P2      │ low       │
  │ 11  │ device shadow / config push    │  P3      │ high      │
  │ 12  │ calibration endpoint           │  P3      │ medium    │
  │ 13  │ config hot-reload via API      │  P3      │ medium    │
  │ 14  │ WDT reboot reason logging      │  P3      │ low       │
  └─────┴────────────────────────────────┴──────────┴───────────┘

  effort estimate:
    trivial = < 30 mins
    low     = half a day
    medium  = 1-2 days
    high    = 3-5 days
```

---

## HiveMQ utilisation scorecard

```
  feature                         status    notes
  ──────────────────────────────────────────────────────────────
  TLS 1.2+ on port 8883           ✓ done    ISRG Root X1, correct
  username/password auth          ✓ done
  QoS 1 on /cmd topic             ✓ done
  exponential backoff reconnect   ✓ done    5s → 60s, good
  last will and testament         ✗ TODO    P0 — add before deploy
  retained messages               ✗ TODO    P0 — one flag per publish
  persistent session              ✗ TODO    P1 — cleanSession=false
  topic ACLs (HiveMQ Cloud)       ✗ TODO    set in HiveMQ console
  webhooks for alerting           ✗ TODO    P2 — no ESP32 change needed
  HiveMQ Data Hub / forwarding    ✗ TODO    P2 — pipeline to InfluxDB
  message expiry TTL on telemetry ✗ TODO    optional — set TTL=10s so
                                            stale telemetry auto-expires
```

the three that matter most before go-live: LWT, retained, persistent session.
everything else is post-deployment.

---

*last updated: march 2026*  
*device: sgs-a1b2c3 | fw: 1.3.x | board: ESP32 DevKit C*
