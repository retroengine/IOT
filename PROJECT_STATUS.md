# Smart Grid Sentinel — Project Status

> **Last Updated:** 2026-04-17  
> **Firmware:** v3.0 — IS 12360 / IEC 60255 Compliant  
> **Hardware:** ESP32-WROOM-32, Dual-Core FreeRTOS  
> **Build Status:** ✅ SUCCESS (RAM 20.1%, Flash 80.8%)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        ESP32 (240MHz)                       │
│                                                             │
│  CORE 0 (Protection — 10ms loop)                            │
│  ┌──────────────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │    ADCSampler        │→│ FaultEngine  │→│    FSM    │  │
│  │ (10kHz SIL Physics)  │  │ (IS 12360)   │  │ (state)   │  │
│  └──────────────────────┘  └──────────────┘  └───────────┘  │
│             ↑                                      ↓        │
│      SIL Command Queue                        RelayControl  │
│       (Lock-Free)                              LedAlert     │
│         ↑                                                   │
│  CORE 1 (Comms — 100ms loop)                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  WiFiManager  │  │  APIServer   │  │  WSServer    │      │
│  │  (STA/AP)     │  │  (REST+CORS) │  │  (telemetry) │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  MQTTClient   │  │ OLEDDisplay  │  │   Buzzer     │      │
│  │  (HiveMQ TLS) │  │  (SH1106)    │  │              │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

---

## File Map

### Core Protection Pipeline (Core 0)

| File | Purpose |
|------|---------|
| `config.h` | All thresholds, pin assignments, IS 12360 / IEC 60255 constants |
| `adc_sampler.cpp/h` | 4× oversampling, IIR filtering, Phantom Grid injection point |
| `fault_engine.cpp/h` | Protection logic: UV/OV/SC/IDMT/thermal/sensor validation |
| `fsm.cpp/h` | State machine: BOOT → NORMAL → WARNING → FAULT → RECOVERY → LOCKOUT |
| `relay_control.cpp/h` | K1/K2 relay drivers (active-LOW, dual-load) |
| `led_alert.cpp/h` | 4-LED load status + alert LED |
| `ds18b20.cpp/h` | Temperature sensor with boot sentinel (+85°C) and disconnect detection |

### Communication Stack (Core 1)

| File | Purpose |
|------|---------|
| `wifi_manager.cpp/h` | STA connection + captive portal fallback (SGS-Setup) |
| `api_server.cpp/h` | REST API (20+ endpoints), API key auth, Phantom Grid `/api/inject` |
| `ws_server.cpp/h` | WebSocket push telemetry at 100ms intervals |
| `mqtt_client.cpp/h` | HiveMQ Cloud TLS publishing |
| `oled_display.cpp/h` | 128×64 OLED two-page display |
| `buzzer.cpp/h` | Piezo alert on fault states |

### Phantom Grid Testing Harness

| File | Purpose |
|------|---------|
| `phantom_grid.cpp/h` | Lock-free `std::atomic` SIL Command Queue for cross-core physics orchestration |
| `src/GridVoltageSimulator.cpp` | IEC 61000 AC Voltage Physics (RMS, Harmonics, Flicker, Sags) |
| `src/GridCurrentSimulator.cpp` | Motor Dynamics (LRC, Inrush, Rotor Decay, CT Saturation) |
| `tools/phantom_dashboard/index.html` | Physics Control Lab (Flicker, Sags, Motor scenarios) |

### Support

| File | Purpose |
|------|---------|
| `main.cpp` | Task creation, seqlock, mutex, boot sequence |
| `types.h` | `SensorReading`, `FSMContext`, fault/warn bit definitions |
| `nvs_log.cpp/h` | Non-volatile event log (50 entries, circular) |
| `sensor_diagnostics.cpp/h` | Rolling variance, drift, min/max tracking |
| `telemetry_builder.cpp/h` | JSON snapshot builder for async readers |

---

## Protection Thresholds (config.h)

### Voltage — IS 12360 / CEA 2005

| Threshold | Value | Behavior |
|-----------|-------|----------|
| UV_INSTANT | ≤ 150V | LOCKOUT (supply collapse) |
| UV_FAULT | ≤ 207V | FAULT (IS 12360 -10%) |
| UV_WARN | ≤ 216V | WARNING (CEA -6%) |
| OV_WARN | ≥ 243V | WARNING (CEA +6%) |
| OV_FAULT | ≥ 253V | FAULT (IS 12360 +10%) |
| OV_INSTANT | ≥ 270V | LOCKOUT (MOV protection) |

### Current — IEC 60255 / IS 8828

| Threshold | Value | Behavior |
|-----------|-------|----------|
| OC_WARN | ≥ 17A | WARNING |
| OC_FAULT | ≥ 21A | IDMT accumulator starts (IEC 60255 Standard Inverse) |
| SC_INSTANT | ≥ 27A | LOCKOUT in 20ms (ANSI 50) |

### Temperature

| Threshold | Value | Behavior |
|-----------|-------|----------|
| TEMP_WARN | ≥ 70°C | WARNING |
| TEMP_FAULT | ≥ 85°C | LOCKOUT (capacitor limit) |
| RESET_BLOCK | ≥ 60°C | Manual reset denied |

---

## FSM State Machine

```
BOOT ──(sensors ready)──→ NORMAL
                              │
                     (fault detected)
                              ↓
                           WARNING ──(escalates)──→ FAULT
                                                      │
                                              (relay opens, cooldown)
                                                      ↓
                                                   RECOVERY
                                                      │
                                           (voltage stable 10 samples)
                                                      ↓
                                                   NORMAL
                                                      
          FAULT ──(lockout-class OR trip_count > 3)──→ LOCKOUT
                                                          │
                                                  (API reset only)
                                                          ↓
                                                       RECOVERY
```

### Lockout-Class Faults (no auto-reclose)
- UV_INSTANT (< 150V)
- OV_INSTANT (> 270V)
- SC_INSTANT (> 27A)
- SENSOR_FAIL (frozen/saturated/impossible ADC)
- THERMAL (> 85°C)

---

## WiFi Module (Current Architecture)

### Boot Flow
```
setup()
  ├─ Register API routes on g_server (NOT started yet)
  ├─ Register WebSocket handler
  ├─ Set CORS headers
  ├─ Launch task_protection (Core 0)
  ├─ Launch task_comms (Core 1)
  ├─ Launch task_health (Core 1)
  └─ WiFiManager::startProvisionTask() (Core 1)
        │
        ├─ WiFi.mode(WIFI_STA)
        ├─ Scan visible networks (prints all SSIDs with RSSI)
        ├─ WiFi.begin("Lunch", "saikiran")  ← hardcoded for bench
        ├─ Wait 20 seconds
        │
        ├─ Connected?
        │   YES → g_server.begin() → print IP → done
        │   NO  → WiFi.disconnect() → WiFi.mode(WIFI_AP)
        │         → softAP("SGS-Setup", "sgs-setup-1234")
        │         → Register portal routes on g_server
        │         → g_server.begin() → DNS loop forever
        └─
```

### Key Design Decision
The HTTP server (`g_server.begin()`) is **only started after WiFi connects** or the captive portal launches. This prevents binding the listening socket to a dead network interface.

### Captive Portal
- **SSID:** `SGS-Setup`
- **Password:** `sgs-setup-1234`
- **IP:** `192.168.4.1`
- Handles Android (`/generate_204`) and iOS (`/hotspot-detect.html`) portal detection
- Saves credentials to NVS, reboots via async FreeRTOS task

---

## SIL Digital Twin (10kHz Virtual DSP Loop)

### Purpose
Replace flat, static numbers with a high-fidelity physics simulator running at 10,000 samples/second to verify protection logic under realistic AC stress (harmonics, sags, motor decay).

### Architecture
```
Browser Dashboard ──HTTP POST──→ Core 1 (API task)
                                     │
                             Zero-Allocation String Parser
                             (manual atoi/sscanf scraper)
                                     │
                             Push to SIL Command Queue
                             (std::atomic<float> p1, p2, cmd)
                                     │
Core 0 (100-step loop) ←── atomic_load(memory_order_acquire)
    │
    ├─ Voltage Model: 50Hz fundamental + 3/5/7 Harmonics + Flicker
    ├─ Current Model: Iterative Motor Physics + CT Saturation knee
    ├─ 10ms Window Integration: True RMS (Sum-of-Squares) 
    ├─ Flawless Ripple Rejection: Integrates exactly 1 half-cycle
    └─ FILTER TELEPORT: Instantly stabilize IIR filters on SIL toggle
```

### API Endpoint
```
POST /api/inject
Headers: X-API-Key: <key>, Content-Type: application/json

Motor Start:  {"cmd": "motor_start"}
Voltage Sag:  {"cmd": "sag", "depth": 0.3, "duration": 2.0}
Flicker ON:   {"cmd": "flicker_on"}
Disable SIL:  {"cmd": "disable"}
```

### Dashboard
Open `tools/phantom_dashboard/index.html` in Chrome. Direct command mapping to individual physics events.


## Serial Monitor Quick Reference

### On successful boot:
```
========================================
 🔐 API AUTHENTICATION KEY
    KEY: aec158f34ad787c
========================================

========================================
 🌐 NETWORK INTERFACE READY
    IP Address : 10.117.3.199
    RSSI       : -48 dBm
    Channel    : 11
========================================
```

### WiFi status codes (if connection fails):
| Code | Meaning |
|------|---------|
| 0 | WL_IDLE_STATUS |
| 1 | WL_NO_SSID_AVAIL — network not found |
| 4 | WL_CONNECT_FAILED — wrong password |
| 5 | WL_CONNECTION_LOST |
| 6 | WL_DISCONNECTED |

---

## Known Issues / TODO

- [ ] **OLED Display:** Uses Adafruit_SSD1306 driver; actual hardware is SH1106. Needs swap to U8g2.
- [x] **Production deployment:** `HARDWARE_BENCH_TESTING` macro removed (potentiometers retired). Sensor validation (EC-06/07/08) now unconditionally active.
- [ ] **ADC Calibration:** `VOLTAGE_FULL_SCALE` and `CURRENT_FULL_SCALE` need verification against a calibrated multimeter with real AC transformers.
- [ ] **Heap pressure:** With MQTT + WebSocket + API running, heap drops to ~60KB minimum. Monitor via `[HEALTH]` logs.
