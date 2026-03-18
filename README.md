# Smart Grid Sentinel

```
███████╗ ██████╗ ███████╗
██╔════╝██╔════╝ ██╔════╝
███████╗██║  ███╗███████╗
╚════██║██║   ██║╚════██║
███████║╚██████╔╝███████║
╚══════╝ ╚═════╝ ╚══════╝
  Smart Grid Sentinel — ESP32 Grid Protection & Monitoring System
```

> **Real-time protection. Self-healing reclosure. Zero-compromise sensor validation.**  
> A production-hardened ESP32 firmware for single-phase Indian grid (230V / 50Hz) that
> combines utility-grade protection logic with IoT telemetry — built entirely on free
> and open embedded tooling.

---

## Table of Contents

1. [What Is This?](#1-what-is-this)
2. [Why It Exists — The Indian Grid Problem](#2-why-it-exists--the-indian-grid-problem)
3. [Hardware Architecture](#3-hardware-architecture)
4. [Software Architecture — Dual-Core Design](#4-software-architecture--dual-core-design)
5. [The Voltage Zone Map](#5-the-voltage-zone-map)
6. [The Current Zone Map](#6-the-current-zone-map)
7. [The Temperature Zone Map](#7-the-temperature-zone-map)
8. [Fault Detection Pipeline](#8-fault-detection-pipeline)
9. [IDMT Overcurrent — Why Not Just a Threshold?](#9-idmt-overcurrent--why-not-just-a-threshold)
10. [Inrush Blanking — Handling Indian Loads](#10-inrush-blanking--handling-indian-loads)
11. [The Protection FSM — State Machine Deep Dive](#11-the-protection-fsm--state-machine-deep-dive)
12. [Edge Cases Catalogue — EC-01 through EC-15](#12-edge-cases-catalogue--ec-01-through-ec-15)
13. [Sensor Validation — Operating Without Blind Faith](#13-sensor-validation--operating-without-blind-faith)
14. [Signal Processing Chain](#14-signal-processing-chain)
15. [Fault Priority System](#15-fault-priority-system)
16. [Relay Logic & Load Shedding](#16-relay-logic--load-shedding)
17. [Telemetry & Diagnostics](#17-telemetry--diagnostics)
18. [REST API Reference](#18-rest-api-reference)
19. [MQTT Architecture](#19-mqtt-architecture)
20. [Dashboard & Relay Server](#20-dashboard--relay-server)
21. [Standards Compliance Matrix](#21-standards-compliance-matrix)
22. [Configuration Reference](#22-configuration-reference)

---

## 1. What Is This?

Smart Grid Sentinel (SGS) is an ESP32-based **electrical protection relay and IoT monitor**
for single-phase residential and light-commercial loads on the Indian 230V / 50Hz grid.

It does what a commercial MCB cannot:

| Capability | Standard MCB | SGS |
|---|---|---|
| Overvoltage trip | ✗ | ✓ (IS 12360) |
| Undervoltage trip | ✗ | ✓ (IS 12360) |
| IDMT overcurrent curve | Fixed curve | ✓ (IEC 60255 Standard Inverse, tunable) |
| Thermal monitoring | ✗ | ✓ (DS18B20, enclosure temp) |
| Auto-reclose with validation | ✗ | ✓ (3-attempt, escalating delay) |
| Sensor self-test | ✗ | ✓ (saturation, frozen, physics cross-check) |
| IoT telemetry | ✗ | ✓ (MQTT TLS, REST API, WebSocket push) |
| Remote reset / control | ✗ | ✓ (MQTT commands, Web API) |
| Event log (survives reboot) | ✗ | ✓ (NVS ring buffer, 50 events) |
| Load shedding on overload | ✗ | ✓ (auxiliary relay shed at WARNING) |
| Power quality metrics | ✗ | ✓ (ripple, sag, swell, flicker index) |
| Live browser dashboard | ✗ | ✓ (5-page industrial UI, 100ms refresh) |

---

## 2. Why It Exists — The Indian Grid Problem

The Indian distribution grid is characterised by conditions that stress equipment daily:

```
Typical Indian grid voltage events (monitored over a week):

 Voltage (V)
  270 ──────────────────────────────── OV_INSTANT ← MOV protection zone
       │                  ▲ Swell
  253 ─┼────────────────▲─┤──────────── OV_FAULT  ← IS 12360 +10%
       │               /  │
  243 ─┼──────────────/───┤──────────── OV_WARN   ← CEA +6%
       │             /    │
  230 ─┼────────────/──────────────────── NOMINAL
       │           │
  216 ─┼───────────┤──────────────────── UV_WARN   ← CEA -6%
       │           │  ▼ Sag (motor start)
  207 ─┼───────────┼▼─────────────────── UV_FAULT  ← IS 12360 -10%
       │            │
  150 ─┼────────────┴─────────────────── UV_INSTANT← Near collapse
       │
    0  └──────────────────────────────── Time →

  Typical events per day in urban/peri-urban India:
    Voltage swells  : 3–8  (transformer tap changes, capacitor switching)
    Voltage sags    : 10–25 (large motor starts, feeder load changes)
    Brief outages   : 1–3  (utility switching operations)
```

A standard MCB handles only overcurrent. All voltage events above pass through it
completely — damaging compressors, TVs, refrigerators, and washing machine motors.

SGS intercepts all of them.

---

## 3. Hardware Architecture

### Block Diagram

```
                        ┌─────────────────────────────────────┐
                        │         ESP32 DevKit C               │
                        │                                      │
  230V AC ──[ZMPT101B]──┤ GPIO34 (ADC1_CH6)   GPIO26 ├──[RELAY1]── Load 1
              (V sense) │ 0-300V scale                │
                        │                     GPIO27 ├──[RELAY2]── Load 2
  230V AC ──[SCT-013]───┤ GPIO35 (ADC1_CH7)           │
   or [ACS758]  (I sense)│ 0-30A scale         GPIO25 ├──[BUZZER] (LEDC)
                        │                             │
  1-Wire Bus ──[DS18B20]┤ GPIO4               GPIO2  ├──[LED]    (Alert)
              (temp)    │                             │
                        │ GPIO17              GPIO17 ├──[LED]    (Load1 green)
                        │ GPIO16              GPIO16 ├──[LED]    (Load2 yellow)
                        │                             │
                        │ GPIO21 (SDA)                │
  [SSD1306 OLED] ───────┤ GPIO22 (SCL)                │
  128×64 px             │                             │
                        └──────────────────┬──────────┘
                                           │ Wi-Fi
                              ┌────────────┴────────────┐
                     WS push  │     relay-server          │  MQTT TLS
                    (100ms)   │     (Node.js, LAN PC)     │  (5s, HiveMQ)
                    ◄─────────┤                           ├─────────────►
                              └────────────┬────────────┘
                                           │ WebSocket
                                    Browser Dashboard
                                    http://localhost:3000
```

### Sensor Selection Rationale

**ZMPT101B (Voltage)**  
Isolation transformer + op-amp output. Scales 230V AC to 0–3.3V ADC range.
Full scale set to 300V to headroom above OV_INSTANT threshold of 270V.

**SCT-013-030 / ACS758 (Current)**  
Split-core CT or Hall-effect sensor. Full scale 30A covers Indian household
MCB ratings (6A, 10A, 16A, 20A, 25A, 32A). Chosen over 5A range specifically
because a 16A MCB installation needs SC detection at 27A — impossible on a
5A-scale ADC without loss of resolution in normal range.

**DS18B20 (Temperature)**  
12-bit, ±0.5°C accuracy. 1-Wire protocol — single GPIO for unlimited sensors.
Chosen for its known disconnect sentinel value (−127°C) which allows the firmware
to detect a physically unplugged sensor as a hardware fault, not a temperature reading.

### GPIO Map

```
ESP32 Pin   Direction   Function                    Notes
─────────   ─────────   ────────────────────────    ──────────────────────────────
GPIO34      INPUT       ADC1_CH6 — Voltage          ADC1 only (no Wi-Fi conflict)
GPIO35      INPUT       ADC1_CH7 — Current          ADC1 only (no Wi-Fi conflict)
GPIO4       INPUT       DS18B20 1-Wire data         4.7kΩ pullup to 3.3V required
GPIO21      I/O         I²C SDA — OLED              Wire.begin(21, 22)
GPIO22      OUTPUT      I²C SCL — OLED
GPIO25      OUTPUT      LEDC Buzzer PWM             Channel 0, 8-bit resolution
GPIO26      OUTPUT      Relay Load 1 (active-LOW)   HIGH before pinMode (boot fix)
GPIO27      OUTPUT      Relay Load 2 (active-LOW)   HIGH before pinMode (boot fix)
GPIO2       OUTPUT      Alert LED                   Built-in LED on most DevKit C
GPIO16      OUTPUT      Load 2 indicator (yellow)   HIGH = relay closed
GPIO17      OUTPUT      Load 1 indicator (green)    HIGH = relay closed
```

> **Why GPIO34/35 for ADC?** ADC2 channels are shared with Wi-Fi and become unusable
> when Wi-Fi is active. ADC1 channels (GPIO32–GPIO39) are independent. All signal
> sensing is on ADC1 to guarantee sampling works alongside MQTT.

---

## 4. Software Architecture — Dual-Core Design

The ESP32 has two Xtensa LX6 cores. SGS splits real-time work and communications
work deliberately so that a slow MQTT broker, OLED render, or HTTP request can
**never** delay a protection trip.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ESP32 FreeRTOS                               │
│                                                                      │
│  ╔══════════════════════════════╗  ╔═══════════════════════════════╗ │
│  ║  CORE 0 — task_protection   ║  ║  CORE 1 — task_comms          ║ │
│  ║  Priority: 5  Stack: 4096w  ║  ║  Priority: 3  Stack: 6144w    ║ │
│  ║  Tick rate: 100Hz (10ms)    ║  ║  Tick rate: 20Hz (50ms)       ║ │
│  ║                              ║  ║                               ║ │
│  ║  1. ADCSampler::tick()      ║  ║  1. OLEDDisplay::update()     ║ │
│  ║  2. DS18B20::tick()         ║  ║  2. Buzzer::tick()            ║ │
│  ║  3. FaultEngine::evaluate() ║  ║  3. MQTTClient::tick()        ║ │
│  ║  4. FSM::tick()             ║  ║  4. WSServer::tick()  ← NEW   ║ │
│  ║  5. RelayControl::update()  ║  ║                               ║ │
│  ║  6. LedAlert::tick()        ║  ║  + ESPAsyncWebServer (async   ║ │
│  ║  7. Pack SensorReading      ║  ║    callbacks, event-driven)   ║ │
│  ║     under mutex             ║  ║                               ║ │
│  ╚══════════════════════════════╝  ╚═══════════════════════════════╝ │
│                │                                                      │
│          g_state_mutex             ╔═══════════════════════════════╗ │
│         SemaphoreHandle_t          ║  CORE 1 — task_health         ║ │
│                │                   ║  Priority: 1  Stack: 2048w    ║ │
│                └───────────────────║  Tick rate: 0.1Hz (10s)       ║ │
│                                    ║  Stack HWM + heap monitoring  ║ │
│                                    ╚═══════════════════════════════╝ │
│                                                                      │
│  Watchdog: esp_task_wdt — 10s timeout — panic on miss               │
└─────────────────────────────────────────────────────────────────────┘
```

### Why This Split Works

**Protection task (Core 0, priority 5)** runs first always. Because it has the highest
priority and is pinned to Core 0, no other task on that core can preempt it.
The 10ms tick means trip decisions are made within one sample period of the fault
appearing. A relay trip from fault detection to pin change takes **one loop iteration**.

**Comms task (Core 1, priority 3)** can stall, delay, or block on MQTT/TLS without
any consequence to protection logic. A slow DNS resolution or HiveMQ reconnect
takes 30 seconds — during that entire time, the relay is still protecting the load.

**The mutex** protects the single shared data structure (SensorReading + FSMContext).
It is held for less than 5 microseconds — just long enough to copy eight floats and
two state enums. Neither task blocks the other meaningfully.

---

## 5. The Voltage Zone Map

```
 Volts
 ┌──────────────────────────────────────────────────────────────────┐
 │  300V ─────────────────────────────────── ADC FULL SCALE        │
 │                                                                   │
 │  270V ═══════════════════════════════════ OV_INSTANT  ← ANSI 59 │
 │        ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  MOV CLAMPING ZONE      │
 │  253V ───────────────────────────────── OV_FAULT  ← IS12360+10% │
 │        ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  EQUIPMENT DAMAGE ZONE   │
 │  245V ···············  OV_FAULT_HYSTERESIS (fault holds to here) │
 │  243V ───────────────────────────────── OV_WARN   ← CEA +6%     │
 │  241V ···············  RECOVERY BAND UPPER (±5% of 230V)        │
 │  240V ···············  OV_WARN_HYSTERESIS                        │
 │                                                                   │
 │  230V ═══════════════════════════════════ NOMINAL 230V           │
 │                                                                   │
 │  220V ···············  UV_WARN_HYSTERESIS                        │
 │  219V ···············  RECOVERY BAND LOWER (±5% of 230V)        │
 │  216V ───────────────────────────────── UV_WARN   ← CEA -6%     │
 │  215V ···············  UV_FAULT_HYSTERESIS (fault holds to here) │
 │  207V ───────────────────────────────── UV_FAULT  ← IS12360-10% │
 │        ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  MOTOR OVERHEAT ZONE     │
 │  150V ───────────────────────────────── UV_INSTANT← near collapse│
 │        ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  SUPPLY COLLAPSE ZONE   │
 │    0V ─────────────────────────────────── ZERO                  │
 └──────────────────────────────────────────────────────────────────┘

 LEGEND:
   ═══  Hard threshold (trip or warn triggers here)
   ───  Hysteresis threshold (condition clears here)
   ···  Calculated band boundary
   ░░░  Hazard zone
   ▒▒▒  Extreme hazard zone
```

### Why Hysteresis Matters

Without hysteresis, a voltage sitting at exactly 253.1V would cause the relay to
trip, recover, re-trip, recover — chattering at potentially hundreds of Hz. This
destroys relay contacts, causes electrical noise, and is meaningless from a
protection standpoint. The 8V hysteresis band (253V trip, 245V clear) mirrors
guidance from EN 50160 and means a fault clears only when the grid has genuinely
moved away from the problem zone.

### Why Two Thresholds per Level?

Each level has a **warning** (CEA ±6%) and a **fault** (IS 12360 ±10%) threshold.
This gives the operator advance notice: at warning, only the auxiliary load (Relay 2)
is shed. The main load remains. At fault, both relays open and the trip counter
increments. This staged response reduces unnecessary service interruptions.

---

## 6. The Current Zone Map

```
 Amps
 ┌──────────────────────────────────────────────────────────────────┐
 │   30A ─────────────────────────────── ADC FULL SCALE            │
 │                                                                   │
 │   27A ═══════════════════════════════ SC_INSTANT  ← ANSI 50     │
 │        ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  SHORT CIRCUIT ZONE        │
 │   21A ═══════════════════════════════ OC_FAULT / IDMT PICKUP     │
 │        ░░░░░░░░░░░░░░░░░░░░░░░░░░░░  OVERLOAD ZONE (IDMT timer) │
 │  16.5A ···············  OC_FAULT_HYSTERESIS                      │
 │   18A ───────────────────────────── OC_WARN (112% rated)         │
 │   16A ═══════════════════════════════ RATED_CURRENT (IS 8828)    │
 │   15A ···············  OC_WARN_HYSTERESIS                        │
 │   12A ───────────────────────────── LOAD_HEAVY threshold         │
 │         (above this: debounce N=5 instead of N=3)                │
 │                                                                   │
 │  0.1A ───────────────────────────── DEADBAND                     │
 │    0A ─────────────────────────────── ZERO (forced to 0.00A)     │
 └──────────────────────────────────────────────────────────────────┘

 IDMT Trip Time (IEC 60255 Standard Inverse, TMS=0.10, Is=21A):
 ┌────────────────────────────────────────────────────────┐
 │  Current │  Multiple of Is  │  Trip Time               │
 │──────────┼──────────────────┼──────────────────────────│
 │  22A     │  1.05×           │  ~15.0 seconds           │
 │  24A     │  1.14×           │  ~6.5  seconds           │
 │  25A     │  1.19×           │  ~4.0  seconds           │
 │  26A     │  1.24×           │  ~2.5  seconds           │
 │  27A     │  1.29×           │  INSTANT (<30ms) — SC    │
 └────────────────────────────────────────────────────────┘
```

---

## 7. The Temperature Zone Map

```
 Celsius
 ┌──────────────────────────────────────────────────────────────────┐
 │  130°C ────────────── FR4 PCB delamination (catastrophic)        │
 │  105°C ────────────── Electrolytic capacitor absolute max        │
 │                                                                   │
 │   85°C ═══════════════════════════════ TEMP_FAULT → LOCKOUT      │
 │          ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  THERMAL LOCKOUT ZONE      │
 │   70°C ═══════════════════════════════ TEMP_WARN / FAULT_HYST    │
 │          ░░░░░░░░░░░░░░░░░░░░░░░░░░  THERMAL WARNING ZONE       │
 │   60°C ───────────────────────────── TEMP_RESET_BLOCK            │
 │         (API reset blocked above 60°C — must cool before reset)  │
 │                                                                   │
 │   25°C ────────────── Normal ambient (last_valid_temp default)   │
 │                                                                   │
 │  -40°C ────────────── DS18B20 rated lower limit                  │
 │ -127°C ═══════════════════════════════ DISCONNECT SENTINEL       │
 │          ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  SENSOR ABSENT → LOCKOUT  │
 └──────────────────────────────────────────────────────────────────┘

 DS18B20 Special Values:
   +85.0°C  ← Power-on scratchpad default (not real — ignored for 2s at boot)
   -127.0°C ← Library disconnect sentinel (triggers LOCKOUT after 3 consecutive)
```

---

## 8. Fault Detection Pipeline

Every call to `FaultEngine::evaluate()` runs six stages in sequence. Understanding
each stage explains why SGS trips when it does — and crucially, why it does **not**
trip during normal load switching.

```
  Raw ADC (v_int, i_int)
  Filtered (v, i) from ADCSampler
  Temperature (t) from DS18B20
          │
          ▼
  ┌───────────────────────────────────────────────────────────────┐
  │  STAGE 1 — Signal Pre-Processing                              │
  │                                                               │
  │  3-sample median filter on current                            │
  │    → Eliminates single-cycle EMI spikes and                   │
  │      commutation transients from motor drives                 │
  │                                                               │
  │  Asymmetric IIR on the median output:                         │
  │    Rise: α = 0.50  (fast response to current surges)          │
  │    Fall: α = 0.10  (slow decay — holds fault condition)        │
  │                                                               │
  │  5-sample slope buffer (current trend)                        │
  │    slope = (buf[newest] - buf[oldest]) / 5                    │
  │    Used to distinguish inrush (decaying) from SC (rising)     │
  └────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
  ┌───────────────────────────────────────────────────────────────┐
  │  STAGE 2 — Sensor Hardware Validation           [PRIORITY: P1]│
  │                                                               │
  │  EC-06: Saturation check (raw_v_int, raw_i_int)               │
  │    If ADC ≤5 or ≥4090 for >50ms → FAULT_BIT_SENSOR           │
  │    Indicates: open wire, op-amp rail clamp, short to GND/3V3  │
  │                                                               │
  │  EC-07: Frozen sensor check (raw int buffer, N=20)            │
  │    Variance of last 20 RAW integers == 0 → FAULT_BIT_SENSOR   │
  │    NOTE: Must use raw ints, not IIR output. IIR collapses      │
  │    variance to near-zero even on healthy sensors              │
  │                                                               │
  │  EC-08: Physics cross-check                                   │
  │    I > 2A AND V < 5V simultaneously → FAULT_BIT_SENSOR        │
  │    Physically impossible on live AC mains — at least one       │
  │    sensor has failed or is wired to wrong signal               │
  │                                                               │
  │  Any P1 hit → sets LOCKOUT flag → FSM skips auto-reclose      │
  └────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
  ┌───────────────────────────────────────────────────────────────┐
  │  STAGE 3 — Instantaneous Fault Detection       [NO DEBOUNCE]  │
  │                                                               │
  │  Short Circuit (P2): I ≥ 27A                                  │
  │    During inrush blank window:                                │
  │      → Only trips if slope is RISING (not decaying inrush)    │
  │    Outside blank window: unconditional trip                   │
  │    → FAULT_BIT_SC → LOCKOUT (no reclose)                      │
  │                                                               │
  │  Severe Overvoltage (P3): V ≥ 270V                            │
  │    Never blanked. Never debounced. 2-sample confirmation only. │
  │    → FAULT_BIT_OV_INSTANT                                      │
  └────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
  ┌───────────────────────────────────────────────────────────────┐
  │  STAGE 4 — Debounced Sustained Fault Detection                │
  │                                                               │
  │  Debounce threshold: N=3 (normal), N=5 (I>12A heavy load)     │
  │  At 100Hz: N=3 → 30ms confirmation window                    │
  │                                                               │
  │  OV Sustained (P5): V ≥ 253V for N samples                   │
  │  IDMT Overcurrent (P6): accumulator ≥ 1.0                    │
  │  Thermal Fault (P4): T ≥ 85°C → LOCKOUT (fire risk)          │
  │  UV Sustained (P7): V ≤ 207V for N samples                   │
  └────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
  ┌───────────────────────────────────────────────────────────────┐
  │  STAGE 5 — Warning Detection                                  │
  │                                                               │
  │  OV_WARN  : V ≥ 243V and V < 253V                            │
  │  UV_WARN  : V ≤ 216V and V > 207V (suppressed during inrush)  │
  │  OC_WARN  : I ≥ 18A and I < 21A   (suppressed during inrush)  │
  │  THERMAL  : T ≥ 70°C and T < 85°C                            │
  │  CURR_RISING: slope > 0.05 AND I > 0.5A AND I < 21A          │
  └────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
  ┌───────────────────────────────────────────────────────────────┐
  │  STAGE 6 — Hysteresis Clear Logic                             │
  │                                                               │
  │  Active faults DO NOT self-clear when threshold is no longer  │
  │  exceeded. They clear only when the signal crosses the        │
  │  corresponding hysteresis dropout threshold.                  │
  └───────────────────────────────────────────────────────────────┘
```

---

## 9. IDMT Overcurrent — Why Not Just a Threshold?

A fixed overcurrent threshold (e.g., "trip at 21A") would fail in practice:
- A 16A load briefly drawing 22A during a cold start would false-trip
- A load drawing 21.5A continuously for 10 minutes would not trip fast enough

The **Inverse Definite Minimum Time (IDMT)** characteristic solves this by making
trip time inversely proportional to how far above the pickup the current is:

```
  IEC 60255 Standard Inverse Formula:
  ──────────────────────────────────────────────────────────
                        k
  t(I)  =  TMS × ─────────────────
                  (I / Is)^α  -  1

  Where:
    t    = trip time in seconds
    TMS  = 0.10  (Time Multiplier Setting — tunable)
    k    = 0.140 (Standard Inverse constant)
    α    = 0.020 (Standard Inverse exponent)
    Is   = 21.0A (pickup current = OC_FAULT threshold)
    I    = measured current

  Implementation:
  ──────────────────────────────────────────────────────────
  Each 10ms tick, the accumulator increments by:
    Δ = SENSOR_LOOP_MS / t_trip_ms
      = 10 / (t(I) × 1000)

  When accumulator ≥ 1.0 → FAULT_BIT_OC_IDMT trips

  Below pickup, accumulator decays:
    accumulator × 0.995 per tick
    This is the IEC "thermal memory" — partial heating is
    remembered. Two 30-second overloads separated by 1 minute
    are more dangerous than one isolated overload.
```

---

## 10. Inrush Blanking — Handling Indian Loads

```
  Indian Load Inrush Profile (SGS blanking rationale):
  ═══════════════════════════════════════════════════════════════════

  Load Type              Inrush   Duration   SGS Blank  Status
  ─────────────────────────────────────────────────────────────────
  Ceiling fan            3–5×     200–500ms   covered   SUPPRESSED
  Tube light (magnetic)  5–8×     100–300ms   covered   SUPPRESSED
  Refrigerator compressor 5–8×FLA 500ms–2s   covered   SUPPRESSED
  Water pump (fractional) 6–10×   500ms–3s   covered   SUPPRESSED  ← worst case
  Mixer/grinder          2–4×     50–100ms    covered   SUPPRESSED
  LED TV / SMPS caps    10–20×    1–10ms      covered   SUPPRESSED
  Washing machine motor   5–8×    500ms–2s   covered   SUPPRESSED
  Iron / heater          1.5–2×   50ms        covered   SUPPRESSED

  3500ms window = worst-case water pump start (EC-01/02/03 all covered)

  What IS suppressed during blank window:
    ✓ IDMT overcurrent accumulator (frozen at 0)
    ✓ OC warning (WARN_OC bit)
    ✓ UV fault (EC-09: motor sag causes V drop during inrush)
    ✓ UV warning

  What is NEVER suppressed:
    ✗ SC_INSTANT (>27A) — genuine short circuits must trip immediately
    ✗ OV_INSTANT (>270V) — overvoltage unrelated to load start
    ✗ OV_FAULT (>253V) — same reasoning
    ✗ Sensor faults — hardware failures must always trip
```

---

## 11. The Protection FSM — State Machine Deep Dive

```
  ┌──────────────────────────────────────────────────────────────────┐
  │                    SGS PROTECTION FSM                            │
  │                                                                  │
  │                         ┌──────┐                                │
  │              boot OK     │ BOOT │                                │
  │          (1s + DS18B20)  └──┬───┘                               │
  │                             │                                    │
  │                             ▼                                    │
  │              ┌──────────────────────────────┐                   │
  │         ┌───►│          NORMAL              │◄──────────────┐   │
  │         │    └──────────────┬───────────────┘               │   │
  │         │                   │                                │   │
  │  faults │     any_warn      │ any_fault          clean       │   │
  │  clear  │         ▼         │                  recovery      │   │
  │         │    ┌─────────┐    │                               │   │
  │         └────│ WARNING │    │                               │   │
  │              └────┬────┘    │                               │   │
  │                   │         │                               │   │
  │            fault  │         │                               │   │
  │                   ▼         ▼                               │   │
  │              ┌─────────────────────────────────┐            │   │
  │              │             FAULT               │            │   │
  │              │  trip_count++                   │            │   │
  │              └──────────────┬──────────────────┘            │   │
  │                             │                                │   │
  │         ┌───────────────────┼──────────────────┐            │   │
  │         │                   │                  │            │   │
  │  lockout-class         auto-reclose        API reset        │   │
  │  or trips>3        trip1=5s/trip2=15s/    (temp guard)      │   │
  │         │          trip3=30s→LOCKOUT           │            │   │
  │         │                   └──────────────────┘            │   │
  │         │                            │                       │   │
  │         │                            ▼                       │   │
  │         │              ┌─────────────────────────────┐       │   │
  │         │              │          RECOVERY           │───────┘   │
  │         │              │  Voltage holds 218.5–241.5V │           │
  │         │              │  for 50 consecutive samples │           │
  │         │              └──────────────┬──────────────┘           │
  │         │                             │ fault re-asserts          │
  │         │                             ▼                           │
  │         └─────────────►┌─────────────────────────────┐           │
  │                        │           LOCKOUT           │           │
  │                        │  Only API reset exits here  │           │
  │                        │  Temperature guard: T < 60°C│           │
  │                        └─────────────────────────────┘           │
  └──────────────────────────────────────────────────────────────────┘
```

---

## 12. Edge Cases Catalogue — EC-01 through EC-15

```
  ┌────┬────────────────────────────────┬──────────────────────────────────────────┐
  │ EC │ Scenario                       │ How SGS Handles It                       │
  ├────┼────────────────────────────────┼──────────────────────────────────────────┤
  │ 01 │ Motor/compressor inrush        │ 3500ms inrush blank window post-close.   │
  │ 02 │ SMPS capacitive inrush         │ SC slope check catches genuine SC.       │
  │ 03 │ Resistive cold inrush          │ Covered by 3500ms blank window.          │
  │ 04 │ DS18B20 +85°C boot sentinel    │ Ignored for 2s after init().             │
  │ 05 │ DS18B20 -127°C disconnect      │ 3 consecutive readings → LOCKOUT.        │
  │ 06 │ ADC saturation                 │ Raw ≤5 or ≥4090 for >50ms → SENSOR_FAIL.│
  │ 07 │ Frozen ADC (variance=0)        │ 20 raw samples, zero variance → LOCKOUT. │
  │ 08 │ Physics impossibility          │ I>2A with V<5V simultaneously → LOCKOUT. │
  │ 09 │ Motor-induced UV sag           │ UV suppressed during inrush blank.       │
  │ 10 │ OV instantaneous >270V         │ Zero debounce, 2-sample minimum.         │
  │ 11 │ SC inside inrush blank window  │ Slope discrimination: rising=SC, not     │
  │    │                                │ inrush. Current >27A + rising → trips.   │
  │ 12 │ Thermal fault (T>85°C)         │ Direct LOCKOUT. No auto-reclose.         │
  │ 13 │ Short circuit trip escalation  │ Direct LOCKOUT after SC.                 │
  │ 14 │ Voltage threshold chattering   │ 8V hysteresis bands on all thresholds.   │
  │ 15 │ IDMT thermal memory            │ Accumulator decays at 0.995×/tick.       │
  └────┴────────────────────────────────┴──────────────────────────────────────────┘
```

---

## 13. Sensor Validation — Operating Without Blind Faith

Most embedded protection devices assume their sensors are working. SGS does not.

Before acting on any measurement, the FaultEngine validates the sensor hardware
itself. This is the difference between a protection relay and a protection relay
that can be trusted.

```
  raw_v_int / raw_i_int are the last oversampled ADC integer values,
  BEFORE any IIR filtering. They are used exclusively for hardware
  fault detection because:

  - Saturation (EC-06): IIR-filtered value can appear "normal"
    while the raw ADC is railing. Only the raw value reveals
    whether the ADC is physically saturated.

  - Frozen sensor (EC-07): IIR filtered values have near-zero variance
    even on a healthy AC signal (the filter collapses variance by design).
    Checking variance on raw integers works because real AC mains always
    produces ≥1–2 LSB of thermal and quantisation noise.
```

---

## 14. Signal Processing Chain

```
  Raw ADC (GPIO34/35)
       │
       │  4× oversample (average) → +1 effective bit
       ▼
  Oversampled integer (0–4095)
       │
       ├─────────────────────────────────────────────────────────────►
       │  (stored as last_raw_v / last_raw_i for sensor HW checks)
       │
       │  IIR low-pass filter
       │    Voltage: α = 0.20
       │    Current: α = 0.30
       ▼
  IIR-filtered float
       │
       │  Current deadband: if I < 0.10A → force to 0.00A
       │  Rolling average (window = 10 samples)
       ▼
  Final filtered value (getVoltage() / getCurrent())
```

---

## 15. Fault Priority System

```
  FAULT_BIT_* Priority Map (highest → lowest destructive potential):

  Bit    Hex     Name           Priority  FSM Action
  ─────────────────────────────────────────────────────────────────────
  0x0001 SENSOR  Sensor HW fail    P1     LOCKOUT (cannot protect blind)
  0x0002 SC      Short circuit     P2     LOCKOUT (wiring damage possible)
  0x0004 OV_INST Severe OV >270V  P3     FAULT → auto-reclose eligible
  0x0008 THERMAL Temperature       P4     LOCKOUT (fire risk)
  0x0010 OV      Sustained OV      P5     FAULT → auto-reclose eligible
  0x0020 OC_IDMT IDMT overcurrent  P6     FAULT → auto-reclose eligible
  0x0040 UV      Undervoltage      P7     FAULT → auto-reclose eligible
```

---

## 16. Relay Logic & Load Shedding

```
  FSM State    → Relay 1 (Main)  Relay 2 (Auxiliary)   Rationale
  ──────────────────────────────────────────────────────────────────
  BOOT         →   OPEN             OPEN            Safe until ready
  NORMAL       →   CLOSED           CLOSED          Full service
  WARNING      →   CLOSED           OPEN            Shed aux, protect main
  FAULT        →   OPEN             OPEN            Both disconnected
  RECOVERY     →   CLOSED           CLOSED          Re-energise for test
  LOCKOUT      →   OPEN             OPEN            Terminal protection

  Active-LOW relay note:
  GPIO HIGH before pinMode(OUTPUT) prevents boot-time relay click.
  Single bool write for API override is atomic on Xtensa LX6.
  Override is cleared automatically on FAULT/LOCKOUT/BOOT.
```

---

## 17. Telemetry & Diagnostics

The firmware publishes schema v1.3 JSON via three transports simultaneously:

| Transport | Path | Rate | Range |
|---|---|---|---|
| WebSocket push | `ws://<ip>/ws/telemetry` | 100ms | LAN only |
| HTTP REST | `GET /api/telemetry` | on-demand | LAN only |
| MQTT TLS | `sgs/device/<id>/telemetry` | 5s | Internet |

The relay server (Node.js) sits between the ESP32 and browser:
- Connects to ESP32 WebSocket as a client
- Forwards every frame instantly to connected browsers
- Falls back to MQTT when ESP32 WebSocket is unreachable
- Falls back to synthetic mock data when both are offline

Health scoring weights: Voltage 30% + Current 30% + Thermal 25% + ADC 15%

---

## 18. REST API Reference

All endpoints require `X-API-Key: <key>` header.  
Key is randomly generated at first boot, stored in NVS, printed to Serial.

```
  Method  Path                  Description
  ──────────────────────────────────────────────────────────────────────
  GET     /api/telemetry        Full telemetry JSON (schema v1.3)
  GET     /api/state            FSM state, fault type, warn flags only
  GET     /api/log              NVS event log (50 most recent entries)
  GET     /api/config           Active configuration thresholds
  GET     /api/diagnostics      Full DiagnosticsSnapshot (sensor health)
  GET     /api/health           Lightweight: overall score + status only
  GET     /api/wifi             Current Wi-Fi connection details + RSSI
  GET     /api/wifi/scan        Nearby Wi-Fi networks scan results
  GET     /api/key-hint         First 4 chars of API key (recovery hint)
  ──────────────────────────────────────────────────────────────────────
  POST    /api/reset            FSM reset (FAULT/LOCKOUT → RECOVERY)
  POST    /api/reboot           Reboot ESP32 (2s delay)
  POST    /api/factory-reset    Clear NVS + reboot (Wi-Fi reprovisioning)
  POST    /api/wifi             {"ssid":"...","pass":"..."} update creds
  POST    /api/relay            {"state":true/false} operator override
  POST    /api/log/clear        Clear NVS event log
  ──────────────────────────────────────────────────────────────────────
```

---

## 19. MQTT Architecture

```
  Device (ESP32)                    HiveMQ Cloud (TLS 1.2+)
  Port 8883 · ISRG Root X1 cert · Username/password auth
  Client ID: sgs-{MAC lower 3 bytes}
  Reconnect: exponential backoff 5s → 60s

  PUBLISH topics:
    sgs/device/sgs-XXXXXX/telemetry  ← every 5 seconds
    sgs/device/sgs-XXXXXX/fault      ← on FSM→FAULT/LOCKOUT
    sgs/device/sgs-XXXXXX/state      ← on any FSM transition

  SUBSCRIBE topic:
    sgs/device/sgs-XXXXXX/cmd        ← QoS 1

  Supported commands: {"cmd": "reset"} / {"cmd": "reboot"} / {"cmd": "ping"}

  Wi-Fi provisioning:
    No credentials → AP "SGS-Setup" (pw: sgs-setup-1234)
    Captive portal at 192.168.4.1 → POST /save → NVS → reboot
    Credentials survive firmware updates (NVS namespace: "sgs")
```

---

## 20. Dashboard & Relay Server

### Architecture

```
ESP32 (ws_server.cpp)
  │  WebSocket push every 100ms
  │  ws://10.x.x.x/ws/telemetry
  ▼
relay-server/ (Node.js — runs on your PC)
  ├── esp32WsClient.js   connects to ESP32 WS, forwards instantly
  ├── mqttClient.js      HiveMQ fallback (5s resolution)
  ├── dataRouter.js      priority: ESP32 WS → MQTT → Mock
  ├── mockGenerator.js   synthetic data matching schema v1.3 exactly
  ├── wsRelay.js         serves dashboard files + browser WebSocket
  ├── server.js          entry point
  └── config.js          all settings (edit this file only)
  │
  │  WebSocket push to browser (instant, no timer)
  │  ws://localhost:3000/ws/telemetry
  │  HTTP file serving: http://localhost:3000
  ▼
dashboard_ip/ (5-page browser UI)
  ├── Page 1 — Live Status (voltage, current, temp, waveform, health)
  ├── Page 2 — Faults & Control (fault matrix, alarm log, relay toggle)
  ├── Page 3 — Diagnostics (sensor health, ADC, power quality)
  ├── Page 4 — Cloud / MQTT (HiveMQ status, payload inspector)
  └── Page 5 — Analytics (historical charts, requires backend)
```

### Setup

```bash
# 1. Flash ESP32 via PlatformIO (firmware already complete)
# 2. First boot: connect to "SGS-Setup" hotspot → browser → 192.168.4.1
#    Enter WiFi credentials → ESP32 reboots and connects
# 3. Note from Serial monitor (115200 baud):
#    [WiFi] Connected. IP: 10.x.x.x
#    [API]  key: aec158f34ad787c

# 4. Edit relay-server/config.js:
#    esp32.ip     → your ESP32's IP
#    esp32.apiKey → your API key

# 5. Start relay server
cd relay-server
npm install
node server.js

# 6. Open dashboard
# http://localhost:3000
```

### Firmware Files Added

| File | Purpose |
|---|---|
| `src/ws_server.cpp` | AsyncWebSocket server — pushes telemetry at 100ms |
| `src/ws_server.h` | Header for ws_server |
| `src/main.cpp` | Updated — WSServer::init() + WSServer::tick() in task_comms |
| `include/config.h` | Updated — added `WS_PUSH_INTERVAL_MS 100` |

### Dashboard Files Changed

| File | Change |
|---|---|
| `dashboard_ip/main.js` | connect('localhost:3000'), DEV_MODE fix for port 3000 |
| `dashboard_ip/telemetry/telemetryPoller.js` | Data stream watchdog (10s), ping interval 60s, pong timeout 30s |

---

## 21. Standards Compliance Matrix

```
  Standard              Scope                      SGS Implementation
  ────────────────────────────────────────────────────────────────────
  IS 12360:2004         Indian voltage tolerance    OV_FAULT=253V (+10%)
                        ±10% consumer side          UV_FAULT=207V (-10%)
  CEA Regs 2005         Supply voltage at PoD       OV_WARN=243V (+6%)
                        ±6%                         UV_WARN=216V (-6%)
  IS 8828 / IEC 60898   MCB trip curves             Rated base = 16A
  IEC 60255-3           IDMT protection curves       Standard Inverse
                                                    k=0.140, α=0.020, TMS=0.10
  ANSI 50               Instantaneous OC             SC_INSTANT = 27A
  ANSI 51               Time-overcurrent             IDMT accumulator
  ANSI 59               Overvoltage protection       OV_INSTANT = 270V
  IEC 61000-4-15        Flicker measurement          Flicker index (DC-proxy)
  EN 50160 (BIS)        Voltage characteristics      Event classification labels
  ────────────────────────────────────────────────────────────────────
  Note: SGS is a monitoring and protection device, not a certified relay.
```

---

## 22. Configuration Reference

```
  Parameter                Value     Rationale
  ─────────────────────────────────────────────────────────────────────
  NOMINAL_VOLTAGE_V        230.0V    Indian single-phase standard
  VOLTAGE_FULL_SCALE       300V      Headroom above OV_INSTANT (270V)
  CURRENT_FULL_SCALE       30A       Covers 16A MCB + SC detection at 27A
  RATED_CURRENT_A          16A       Standard Indian household MCB
  IIR_ALPHA_VOLTAGE        0.20      ~5-sample smoothing on voltage
  IIR_ALPHA_CURRENT        0.30      Slightly faster response
  CURR_DEADBAND_A          0.10A     0.33% of 30A scale — noise floor
  MOVING_AVG_DEPTH         10        100ms display smoothing window
  ADC_OVERSAMPLE           4         +1 ENOB; 4× chosen for 100Hz budget
  SENSOR_LOOP_MS           10ms      100Hz — protection task tick rate
  COMMS_LOOP_MS            50ms      20Hz — OLED + MQTT + WS comms tick
  WS_PUSH_INTERVAL_MS      100ms     WebSocket push to browser (10Hz)
  WDT_TIMEOUT_S            10s       Watchdog panic timeout
  INRUSH_BLANK_MS          3500ms    Worst-case Indian load: water pump
  VOLT_RECOVERY_CONFIRM_N  50        500ms stable voltage before reclose
  RECLOSE_DELAY_1_MS       5000ms    Trip 1 → 5s dead time
  RECLOSE_DELAY_2_MS       15000ms   Trip 2 → 15s dead time
  RECLOSE_DELAY_3_MS       30000ms   Trip 3 → 30s dead time → LOCKOUT
  MAX_TRIP_COUNT           3         Three strikes before LOCKOUT
  IDMT_TMS                 0.10      Time Multiplier — adjust trip speed
  TEMP_FAULT_C             85°C      Electrolytic capacitor rated limit
  TEMP_RESET_BLOCK_C       60°C      Must cool before reset allowed
  HEAP_WARN_BYTES          20000B    Warn if free heap falls below ~20KB
  EVENT_LOG_CAPACITY       50        NVS ring buffer entries
  MQTT_PUB_INTERVAL_MS     5000ms    Telemetry MQTT publish rate
  OLED_PAGE_FLIP_MS        4000ms    OLED page cycle time
  ─────────────────────────────────────────────────────────────────────
```

---

## Design Philosophy

```
  "A protection relay that you cannot trust is worse than no protection relay."

  Every decision in SGS follows from three principles:

  1. Fail safe, not fail open
     When in doubt, the relay opens. The cost of an unnecessary trip is
     inconvenience. The cost of a missed fault is equipment damage, fire,
     or electrocution. All ambiguous sensor states → LOCKOUT.

  2. Validate before you protect
     Stage 2 of the fault pipeline runs before all others. If the sensors
     themselves cannot be trusted, the protection is meaningless.
     SGS knows when it is blind.

  3. Intelligence proportional to risk
     Instantaneous trips (SC, severe OV) have near-zero latency. Debounced
     trips (sustained OV, IDMT) take 30ms–60s depending on severity.
     Auto-reclose uses escalating delays. LOCKOUT is permanent until human
     confirmation. The system is more aggressive as the stakes increase.
```

---

*Smart Grid Sentinel — Built for 230V / 50Hz Indian grid conditions.*  
*All thresholds, curves, and logic are derived from IS 12360, CEA 2005, IEC 60255,*  
*IEC 60898, ANSI 50/51/59, and field observation of Indian residential load behaviour.*