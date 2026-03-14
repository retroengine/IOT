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
20. [Standards Compliance Matrix](#20-standards-compliance-matrix)
21. [Configuration Reference](#21-configuration-reference)

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
| IoT telemetry | ✗ | ✓ (MQTT TLS, REST API) |
| Remote reset / control | ✗ | ✓ (MQTT commands, Web API) |
| Event log (survives reboot) | ✗ | ✓ (NVS ring buffer, 50 events) |
| Load shedding on overload | ✗ | ✓ (auxiliary relay shed at WARNING) |
| Power quality metrics | ✗ | ✓ (ripple, sag, swell, flicker index) |

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
                        │ GPIO21 (SDA)                │
  [SSD1306 OLED] ───────┤ GPIO22 (SCL)                │
  128×64 px             │                             │
                        └──────────────────┬──────────┘
                                           │ Wi-Fi
                                    ┌──────┴──────┐
                           MQTT TLS │  HiveMQ      │  REST API
                           ─────────► Cloud Broker ◄──── Web Dashboard
                                    └─────────────┘
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
│  ║  4. FSM::tick()             ║  ║                               ║ │
│  ║  5. RelayControl::update()  ║  ║  + ESPAsyncWebServer (async   ║ │
│  ║  6. LedAlert::tick()        ║  ║    callbacks, event-driven)   ║ │
│  ║  7. Pack SensorReading      ║  ║                               ║ │
│  ║     under mutex             ║  ╚═══════════════════════════════╝ │
│  ║  8. xQueueOverwrite()       ║                                     │
│  ╚══════════════════════════════╝  ╔═══════════════════════════════╗ │
│                │                   ║  CORE 1 — task_health         ║ │
│          g_state_mutex             ║  Priority: 1  Stack: 2048w    ║ │
│         SemaphoreHandle_t          ║  Tick rate: 0.1Hz (10s)       ║ │
│                │                   ║                               ║ │
│                └───────────────────║  Stack HWM monitoring         ║ │
│                                    ║  Heap usage monitoring        ║ │
│                                    ║  WDT feed                     ║ │
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
  │      → Genuine SC always has rising or flat current            │
  │      → Inrush current decays exponentially from peak          │
  │    Outside blank window: unconditional trip                   │
  │    → FAULT_BIT_SC → LOCKOUT (no reclose)                      │
  │                                                               │
  │  Severe Overvoltage (P3): V ≥ 270V                            │
  │    Never blanked. Never debounced. 2-sample confirmation only. │
  │    At 270V the MOV clamps hard — every ms of exposure          │
  │    degrades semiconductor junctions and MOV lifetime           │
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
  │    Clears via hysteresis: only when V < 245V                  │
  │                                                               │
  │  IDMT Overcurrent (P6): accumulator ≥ 1.0                    │
  │    Accumulates when I > 21A (blanked during inrush window)    │
  │    Decays at 0.995×/tick below pickup (thermal memory)        │
  │    Clears when accumulator < 0.05 AND I < 16.5A               │
  │                                                               │
  │  Thermal Fault (P4): T ≥ 85°C for N samples                  │
  │    → FAULT_BIT_THERMAL → LOCKOUT (no reclose — fire risk)     │
  │    Clears via hysteresis: only when T < 70°C                  │
  │                                                               │
  │  UV Sustained (P7): V ≤ 207V for N samples                   │
  │    Suppressed during inrush blank (EC-09: motor sag)          │
  │    UV_INSTANT (V < 150V) is never suppressed                  │
  │    Clears via hysteresis: only when V > 215V                  │
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
  │               (predictive — current trending upward)          │
  └────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
  ┌───────────────────────────────────────────────────────────────┐
  │  STAGE 6 — Hysteresis Clear Logic                             │
  │                                                               │
  │  Active faults DO NOT self-clear when threshold is no longer  │
  │  exceeded. They clear only when the signal crosses the        │
  │  corresponding hysteresis dropout threshold.                  │
  │                                                               │
  │  This prevents chattering at threshold boundaries and         │
  │  matches the behavior expected from utility relay protection.  │
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

  Trip time curve (SGS, TMS=0.10, Is=21A):
  ──────────────────────────────────────────────────────────
  Time (s)
  │
  15 ┤ ●  22.0A
     │
  10 ┤
     │  ●  23.0A
   6 ┤
     │     ●  24.0A
   4 ┤
     │        ●  25.0A
   2 ┤
     │              ●  26.0A
   1 ┤
     │                    SC bypass → 27A trips in <30ms
   0 └─────────────────────────────────── Current (A)
```

---

## 10. Inrush Blanking — Handling Indian Loads

The single most common cause of nuisance tripping in any protection relay is
**inrush current** — the brief overcurrent that occurs when any load with a
magnetic core, motor, or large capacitor is switched on.

SGS uses a 3500ms inrush blank window after every relay close. This window was
derived from field measurements of Indian household loads:

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

  ═══════════════════════════════════════════════════════════════════

  What IS suppressed during blank window:
    ✓ IDMT overcurrent accumulator (frozen at 0)
    ✓ OC warning (WARN_OC bit)
    ✓ UV fault (EC-09: motor sag causes V drop during inrush)
    ✓ UV warning

  What is NEVER suppressed:
    ✗ SC_INSTANT (>27A) — genuine short circuits must trip immediately
    ✗ OV_INSTANT (>270V) — overvoltage has nothing to do with load start
    ✗ OV_FAULT (>253V) — same reasoning
    ✗ Sensor faults — hardware failures must always trip

  SC inside blank window — slope discrimination (EC-11):
  ─────────────────────────────────────────────────────
  After 300ms into blank window, current should be decaying (inrush
  peak has passed). If current is still RISING at that point, it is
  not inrush — it is a genuine short circuit developing.
  SGS checks: slope > 0.5A/tick AND I > SC_INSTANT → trips regardless
  of blank window being active.
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
  │  faults │     any_warn      │                   clean        │   │
  │  clear  │         ▼         │ any_fault        recovery      │   │
  │         │    ┌─────────┐    │                               │   │
  │         └────│ WARNING │    │                               │   │
  │              └────┬────┘    │                               │   │
  │                   │         │                               │   │
  │            fault  │         │                               │   │
  │            escalate│        │                               │   │
  │                   ▼         ▼                               │   │
  │              ┌─────────────────────────────────┐            │   │
  │              │             FAULT               │            │   │
  │              │  trip_count++                   │            │   │
  │              │  fault_ts_ms = now              │            │   │
  │              └──────────────┬──────────────────┘            │   │
  │                             │                                │   │
  │         ┌───────────────────┼──────────────────┐            │   │
  │         │                   │                  │            │   │
  │  lockout-class         auto-reclose        API reset        │   │
  │  or trips>3      (escalating dead time)   (temp guard)      │   │
  │         │                   │                  │            │   │
  │         │              trip1=5s                │            │   │
  │         │              trip2=15s               │            │   │
  │         │              trip3=30s               │            │   │
  │         │                   │                  │            │   │
  │         │                   └──────────────────┘            │   │
  │         │                            │                       │   │
  │         │                            ▼                       │   │
  │         │              ┌─────────────────────────────┐       │   │
  │         │              │          RECOVERY           │───────┘   │
  │         │              │  1. Wait 500ms settle        │           │
  │         │              │  2. Voltage must hold        │           │
  │         │              │     218.5–241.5V for         │           │
  │         │              │     50 consecutive samples   │           │
  │         │              │     (500ms of stable grid)   │           │
  │         │              └──────────────┬──────────────┘           │
  │         │                             │ fault                     │
  │         │                             │ re-asserts               │
  │         │                             ▼ trip++                    │
  │         │              ┌─────────────────────────────┐           │
  │         └─────────────►│           LOCKOUT           │           │
  │                        │  Only API reset exits here  │           │
  │                        │  Temperature guard: T < 60°C│           │
  │                        └─────────────────────────────┘           │
  └──────────────────────────────────────────────────────────────────┘
```

### State Descriptions

**BOOT** — Sensors are warming up. DS18B20 has a 2-second boot sentinel window (EC-04).
ADC IIR filter needs ~10 samples to converge. FSM waits minimum 1s and until
`DS18B20::isReady()` returns true before trusting any readings.

**NORMAL** — Both relays closed. Full load energised. Fault and warning detection active.
Any warning flags → WARNING. Any fault → FAULT (or direct LOCKOUT for lockout-class faults).

**WARNING** — Relay 1 remains closed (main load). Relay 2 opens (auxiliary load shed).
Buzzer: 1kHz, 50ms/450ms pattern. LED: 1Hz blink. If all warning flags clear → NORMAL.
If a fault escalates → FAULT.

**FAULT** — Both relays open. Load disconnected. Trip counter incremented.
Two exit paths:
1. **Auto-reclose** after escalating dead time (5s / 15s / 30s depending on trip count)
2. **API reset** (POST /api/reset or MQTT `reset` command)

Both paths are blocked if temperature ≥ 60°C.

**RECOVERY** — Relays re-close (or will close, RelayControl reads state). 500ms settle
wait, then voltage must be stable within ±5% (218.5–241.5V) for 50 consecutive
samples before declaring NORMAL. This prevents re-closing into an ongoing sag or swell.

**LOCKOUT** — Terminal state. Both relays open. Buzzer: 500Hz continuous. LED: solid.
Only exits via API reset AND temperature guard passed. Requires physical investigation
before reset by design.

### Why Escalating Reclose Delays?

```
  First trip  (trip=1) → 5s dead time
    Rationale: Most grid disturbances are transient (capacitor switching,
    lightning, nearby fault clearance). 5s is usually long enough for the
    source disturbance to clear while minimising service interruption.

  Second trip (trip=2) → 15s dead time
    Rationale: First reclose failed. The fault may be semi-permanent (a
    loose connection arcing intermittently). Longer dead time gives arc
    products time to de-ionise and lets the user investigate.

  Third trip  (trip=3) → 30s dead time → then LOCKOUT
    Rationale: Two reclosures failed. This is a persistent fault.
    Auto-reclosing into a persistent fault causes progressive damage.
    30s is the last attempt; failure → LOCKOUT for manual intervention.
```

---

## 12. Edge Cases Catalogue — EC-01 through EC-15

Every numbered edge case in the codebase represents a failure scenario that was
explicitly analysed and handled. None are theoretical — all occur in real Indian
residential/commercial installations.

```
  ┌────┬────────────────────────────────┬──────────────────────────────────────────┐
  │ EC │ Scenario                       │ How SGS Handles It                       │
  ├────┼────────────────────────────────┼──────────────────────────────────────────┤
  │ 01 │ Motor/compressor inrush        │ 3500ms inrush blank window post-close.   │
  │    │ 5–8× rated, 500ms–3s          │ IDMT accumulator frozen. UV suppressed.  │
  ├────┼────────────────────────────────┼──────────────────────────────────────────┤
  │ 02 │ SMPS capacitive inrush         │ Same blank window. SC slope check at     │
  │    │ 10–40×, 1–10ms                │ 300ms catches genuine SC (not decay).    │
  ├────┼────────────────────────────────┼──────────────────────────────────────────┤
  │ 03 │ Resistive cold inrush          │ Covered by 3500ms blank window.          │
  │    │ 10–15×, 50ms                  │ Well within window — no nuisance trip.   │
  ├────┼────────────────────────────────┼──────────────────────────────────────────┤
  │ 04 │ DS18B20 +85°C power-on default │ First 2s of boot, any 85.0°C reading     │
  │    │ scratchpad not yet converted   │ is silently discarded. After 2s, 85°C   │
  │    │                                │ is a real reading and IS acted upon.     │
  ├────┼────────────────────────────────┼──────────────────────────────────────────┤
  │ 05 │ DS18B20 -127°C disconnect      │ Debounced: 3 consecutive -127°C required │
  │    │ unplugged / bus shorted        │ (2.4s). Reconnect does not auto-clear   │
  │    │                                │ LOCKOUT. API reset required.             │
  ├────┼────────────────────────────────┼──────────────────────────────────────────┤
  │ 06 │ ADC saturation                 │ Raw integer ≤5 or ≥4090 for >50ms →     │
  │    │ open wire / op-amp clamp       │ FAULT_BIT_SENSOR → LOCKOUT.             │
  ├────┼────────────────────────────────┼──────────────────────────────────────────┤
  │ 07 │ Frozen ADC (variance = 0)      │ Last 20 raw integer values checked.     │
  │    │ ADC mux hang / IC lockup       │ AC mains always has ≥1-2 LSB jitter.    │
  │    │                                │ Zero variance = stuck → SENSOR_FAIL.    │
  │    │                                │ Must use raw int, not IIR output.        │
  ├────┼────────────────────────────────┼──────────────────────────────────────────┤
  │ 08 │ Physics impossibility          │ I > 2A with V < 5V simultaneously.      │
  │    │ cross-channel sanity fail      │ Impossible on live AC → sensor failed.  │
  ├────┼────────────────────────────────┼──────────────────────────────────────────┤
  │ 09 │ Motor-induced UV sag           │ UV fault and UV warn suppressed during   │
  │    │ (load's own inrush sags grid)  │ inrush blank. UV_INSTANT never blanked. │
  ├────┼────────────────────────────────┼──────────────────────────────────────────┤
  │ 10 │ OV instantaneous >270V         │ Zero debounce, 2-sample minimum.         │
  │    │ MOV protection zone            │ Never blanked. Clamp degradation starts  │
  │    │                                │ immediately at this level.               │
  ├────┼────────────────────────────────┼──────────────────────────────────────────┤
  │ 11 │ Short circuit inside           │ Slope discrimination: if current rising  │
  │    │ inrush blank window            │ at >0.5A/tick AND I>27A → SC trip.      │
  │    │                                │ Inrush decays; SC does not.              │
  ├────┼────────────────────────────────┼──────────────────────────────────────────┤
  │ 12 │ Thermal fault (T > 85°C)       │ Routes directly to LOCKOUT. No          │
  │    │ enclosure overheating          │ auto-reclose. Fire risk — physical       │
  │    │                                │ inspection before reset mandatory.       │
  ├────┼────────────────────────────────┼──────────────────────────────────────────┤
  │ 13 │ Short circuit trip escalation  │ SC routes directly to LOCKOUT. Possible  │
  │    │                                │ wiring damage — inspect before reset.    │
  ├────┼────────────────────────────────┼──────────────────────────────────────────┤
  │ 14 │ Voltage threshold chattering   │ Full hysteresis bands on all thresholds. │
  │    │ (voltage hovering at 253V)     │ Fault clears only at 245V (8V band).    │
  ├────┼────────────────────────────────┼──────────────────────────────────────────┤
  │ 15 │ IDMT thermal memory            │ Accumulator decays at 0.995×/tick (not  │
  │    │ (repeated brief overloads)     │ instant reset). Two 30s overloads in     │
  │    │                                │ succession are more dangerous than one.  │
  └────┴────────────────────────────────┴──────────────────────────────────────────┘
```

---

## 13. Sensor Validation — Operating Without Blind Faith

Most embedded protection devices assume their sensors are working. SGS does not.

Before acting on any measurement, the FaultEngine validates the sensor hardware
itself. This is the difference between a protection relay and a protection relay
that can be trusted.

```
  Sensor Validation Architecture:

  ADCSampler::tick()                  FaultEngine::evaluate()
  ─────────────────────               ─────────────────────────────────
  4× oversample                       receives:
  IIR filter                 ──────►    v       (filtered voltage)
  Rolling average            ──────►    raw_i   (filtered current)
  Expose getLastRawV()       ──────►    t       (temperature)
  Expose getLastRawI()       ──────►    raw_v_int (raw ADC int)
                                        raw_i_int (raw ADC int)

  raw_v_int / raw_i_int are the last oversampled ADC integer values,
  BEFORE any IIR filtering. They are used exclusively for hardware
  fault detection because:

  - Saturation (EC-06): IIR-filtered value can appear "normal"
    while the raw ADC is railing. A filtered 270V could be a genuine
    reading OR it could be a stuck-high ADC. Only the raw value reveals
    whether the ADC is physically saturated.

  - Frozen sensor (EC-07): IIR filtered values have near-zero variance
    even on a healthy AC signal (the filter collapses variance by design).
    Checking variance on IIR output would produce 100% false positives.
    Checking variance on raw integers works because real AC mains always
    produces ≥1–2 LSB of thermal and quantisation noise.
```

### ADC Calibration Quality

```
  Level 0 (no calibration): ADC uses factory defaults.
           Nonlinearity up to ±5% at ADC extremes.
           Acceptable for approximate monitoring only.

  Level 1 (eFuse Vref): Factory-measured Vref stored in eFuse.
           Corrects gain error. Nonlinearity ±2–3%.
           Available on most ESP32 chips.

  Level 2 (eFuse Two-Point): Both low and high reference voltages
           stored in eFuse. Best accuracy, ±1% typical.
           Available only on chips with two-point calibration burned.

  getCalibrationQuality() returns 0, 1, or 2.
  Reported in /api/diagnostics and telemetry payload.
  The confidence score for each channel is adjusted downward
  when calibration quality is 0.
```

---

## 14. Signal Processing Chain

```
  Raw ADC (GPIO34/35)
       │
       │  4× oversample (average) → +1 effective bit
       │  Reduces quantisation noise from ±0.5 LSB to ±0.25 LSB
       ▼
  Oversampled integer (0–4095)
       │
       ├──────────────────────────────────────────────────────────────►
       │  (stored as last_raw_v / last_raw_i for sensor HW checks)
       │
       │  IIR low-pass filter
       │    Voltage: α = 0.20 (responds to changes over ~5 samples)
       │    Current: α = 0.30 (slightly faster — current changes faster)
       │    Formula: iir = α × new_raw + (1 - α) × prev_iir
       ▼
  IIR-filtered float
       │
       │  Current deadband: if I < 0.10A → force to 0.00A
       │  (eliminates noise-floor current reading at idle)
       │
       │  Rolling average (window = 10 samples)
       │  Final display smoothing — eliminates sample-to-sample jitter
       ▼
  Final filtered value (getVoltage() / getCurrent())

  Parallel diagnostics tracked continuously:
  ┌───────────────────────────────────────────────────────────────────┐
  │  Noise floor : EMA of (raw - filtered)² → RMS noise in V or A    │
  │  Min/Max     : all-time extremes of filtered output since boot    │
  │  Drift rate  : (fast EMA α=0.10) - (slow EMA α=0.005) per second │
  │  Variance    : Welford online algorithm on rolling window         │
  │  SNR (dB)    : 20 × log10(mean / noise_rms)                      │
  │  Saturation  : raw hit 0 or 4095 → set flag + increment counter  │
  │  Sample rate : measured from real tick() wall-clock timing        │
  └───────────────────────────────────────────────────────────────────┘
```

---

## 15. Fault Priority System

Multiple faults can be simultaneously active. SGS uses a 16-bit bitmask to track all
of them, and a priority resolver to determine the FSM action.

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

  Example multi-fault scenario — stalled motor:
  ─────────────────────────────────────────────
  Motor stalls → draws locked rotor current (~8× FLA)
  → I > 21A → FAULT_BIT_OC_IDMT set (P6)
  → Load depresses line voltage → V < 207V → FAULT_BIT_UV set (P7)
  → getActiveFaultBits() = 0x0060 (both set)
  → getActiveFault() returns FAULT_OVERCURRENT (highest priority = P6)
  → FSM trips to FAULT state
  → Both fault bits visible in telemetry JSON fault_bits field
  → Dashboard can display "OVERCURRENT + UNDERVOLTAGE" simultaneously

  Lockout-class detection:
  ─────────────────────────
  isLockoutClass() = (THERMAL set) OR (SC set)
  When true, FSM routes directly to LOCKOUT, skipping auto-reclose.
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
  ─────────────────────────────────────────────────────────────────
  The relay modules used are active-LOW (common in Chinese relay boards).
  Energising the coil requires driving the pin LOW.
  The firmware drives pins HIGH BEFORE calling pinMode(OUTPUT).
  This prevents the brief LOW glitch that occurs when the ESP32
  boot ROM initialises GPIOs, which would cause a relay click on
  every boot and power cycle.

  API Override:
  ─────────────────────────────────────────────────────────────────
  POST /api/relay allows an operator to manually force relays.
  The override is accepted only in NORMAL or WARNING states.
  On any FAULT / LOCKOUT / BOOT transition, the override is
  automatically cleared by the protection task.
  The override flag is declared volatile — written from Core-1
  async handler, read from Core-0 protection task. Single bool
  write is atomic on Xtensa LX6.
```

---

## 17. Telemetry & Diagnostics

### JSON Schema v1.3

```json
{
  "schema_version": "1.3",
  "device_id": "sgs-a1b2c3",
  "ts": 1234567890,

  "sensors": {
    "voltage": { "pin": 34, "raw": 2987, "filtered": 229.8,
                 "unit": "V", "confidence": 91 },
    "current": { "pin": 35, "raw": 112,  "filtered": 0.82,
                 "unit": "A", "confidence": 88 },
    "temperature": { "pin": 4, "raw": 0, "filtered": 34.5,
                     "unit": "C", "confidence": 95 }
  },

  "power": {
    "real_power_w": 160.2,
    "apparent_power_va": 188.5,
    "power_factor": 0.85,
    "energy_wh": 1234.5
  },

  "state": {
    "fsm": "NORMAL",
    "fault": "NONE",
    "warn_flags": 0,
    "trip_count": 0,
    "risk_level": "LOW",
    "fault_bits": 0
  },

  "actuators": {
    "relay1": true,
    "relay2": true
  },

  "diagnostics": {
    "sensor_health": {
      "voltage":     { "noise_floor_v": 0.8, "snr_db": 49.2,
                       "drift_v_per_s": 0.02, "score": 94,
                       "label": "EXCELLENT" },
      "current":     { "noise_floor_a": 0.04, "snr_db": 26.1,
                       "score": 88, "label": "GOOD" },
      "temperature": { "success_rate_pct": 100, "disconnect_count": 0,
                       "score": 100, "label": "EXCELLENT" }
    },
    "adc": {
      "calibration": "EFUSE_VREF",
      "linearity_error_pct": 1.2,
      "actual_sample_rate_hz": 99.4,
      "saturation_events": 0
    },
    "power_quality": {
      "ripple_pct": 0.34,
      "flicker_index": 0.0012,
      "sag_depth_v": 0.0,
      "swell_height_v": 0.0,
      "score": 96,
      "label": "EXCELLENT"
    },
    "system": {
      "overall_health_score": 93,
      "health_status": "HEALTHY",
      "uptime_s": 7234,
      "uptime_quality": "STABLE",
      "free_heap_bytes": 187432,
      "cpu_load_estimate_pct": 0.6
    }
  },

  "network": {
    "rssi_dbm": -58,
    "mqtt_connected": true,
    "connect_attempts": 1,
    "connect_successes": 1,
    "publish_total": 1446,
    "publish_failed": 0,
    "tls_cert_verified": true
  }
}
```

### Health Scoring Methodology

```
  Each sub-score is 0–100 (100 = perfect).
  Deductions are additive penalties from 100 base.
  Final score clamped to [0, 100].

  Voltage health score deductions:
    noise_floor_v > 2V   → -20
    noise_floor_v > 1V   → -10
    saturated            → -40
    snr_db < 30          → -20
    drift_rate_abs > 1/s → -15
    variance > threshold → -10

  Overall health score = weighted average:
    Voltage score   × 0.30
    Current score   × 0.30
    Thermal score   × 0.25
    ADC score       × 0.15

  Health status labels:
    HEALTHY   : score ≥ 80
    DEGRADED  : score ≥ 50
    CRITICAL  : score < 50
```

---

## 18. REST API Reference

All endpoints require `X-API-Key: <key>` header.  
API key is randomly generated at first boot, stored in NVS, printed to Serial.  
CORS is fully open (`*`) for local dashboard use.

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
  POST    /api/reset            Request FSM reset (FAULT/LOCKOUT → RECOVERY)
  POST    /api/reboot           Reboot ESP32 (2s delay, scheduled task)
  POST    /api/factory-reset    Clear NVS + reboot (Wi-Fi reprovisioning)
  POST    /api/wifi             {"ssid":"...","pass":"..."} update creds
  POST    /api/relay            {"state":true/false} operator override
  POST    /api/log/clear        Clear NVS event log
  ──────────────────────────────────────────────────────────────────────

  Notes:
  • /api/reset is blocked if temperature ≥ 60°C
  • /api/relay override is cleared on any FAULT/LOCKOUT/BOOT
  • /api/health is suitable for uptime monitors (minimal payload)
  • All responses include Access-Control-Allow-Origin: *
```

---

## 19. MQTT Architecture

```
  Device (ESP32)                    HiveMQ Cloud (TLS 1.2+)
  ───────────────────────────────   ─────────────────────────────────
  TLS handshake using ISRG Root X1 certificate
  Port 8883
  Username / password authentication
  Client ID: sgs-{MAC lower 3 bytes}
  Socket timeout: 30s (allows for slow TLS handshake)
  Reconnect: exponential backoff 5s → 60s

  PUBLISH topics (device → broker):
  ┌─────────────────────────────────────┬─────────────────────────────┐
  │ Topic                               │ Trigger                     │
  ├─────────────────────────────────────┼─────────────────────────────┤
  │ sgs/device/sgs-XXXXXX/telemetry     │ Every 5 seconds (periodic)  │
  │ sgs/device/sgs-XXXXXX/fault        │ Immediately on FSM→FAULT/   │
  │                                     │ LOCKOUT transitions         │
  │ sgs/device/sgs-XXXXXX/state        │ Immediately on any FSM      │
  │                                     │ state transition             │
  └─────────────────────────────────────┴─────────────────────────────┘

  SUBSCRIBE topic (broker → device):
  ┌─────────────────────────────────────┬─────────────────────────────┐
  │ sgs/device/sgs-XXXXXX/cmd           │ QoS 1 (at-least-once)      │
  └─────────────────────────────────────┴─────────────────────────────┘

  Supported commands (JSON: {"cmd":"..."}):
  ┌────────────┬───────────────────────────────────────────────────────┐
  │ "reset"    │ Triggers FSM::requestReset() — same as POST /api/reset│
  │ "reboot"   │ Schedules ESP.restart() after 2s                      │
  │ "ping"     │ Responds with pong JSON on state topic                │
  └────────────┴───────────────────────────────────────────────────────┘

  Wi-Fi provisioning flow:
  ─────────────────────────────────────────────────────────────────────
  No stored credentials → starts AP "SGS-Setup" (pw: sgs-setup-1234)
  DNS wildcard catches all requests → redirects to 192.168.4.1
  Captive portal form → POST /save → stores SSID+pass to NVS → reboot
  Credentials survive firmware updates (NVS namespace: "sgs")
```

---

## 20. Standards Compliance Matrix

```
  Standard              Scope                      SGS Implementation
  ────────────────────────────────────────────────────────────────────
  IS 12360:2004         Indian voltage tolerance    OV_FAULT=253V (+10%)
                        ±10% consumer side          UV_FAULT=207V (-10%)
                                                    Recovery band 218.5–241.5V

  CEA Regs 2005         Supply voltage at PoD       OV_WARN=243V (+6%)
                        ±6%                         UV_WARN=216V (-6%)

  IS 8828 / IEC 60898   MCB trip curves             Rated base = 16A
                        Curve C for motor loads      IDMT tuned to mirror C-curve
                                                    behaviour at household scale

  IEC 60255-3           IDMT protection curves       Standard Inverse curve
                        (Overcurrent relays)         k=0.140, α=0.020
                                                    TMS=0.10 (tunable in config.h)
                                                    Accumulator-based integration

  ANSI 50               Instantaneous OC protection  SC_INSTANT = 27A (no debounce)
                        (Short circuit)              Bypasses inrush blank window

  ANSI 51               Time-overcurrent protection  IDMT accumulator implementation
                        (Inverse time OC relay)

  ANSI 59               Overvoltage protection       OV_INSTANT = 270V (instantaneous)
                                                    OV_FAULT = 253V (timed)

  IEC 61000-4-15        Flicker measurement          Flicker index = variance/mean²
                        (Power quality)              (DC-proxy; true IEC requires
                                                     AC waveform sampling)

  EN 50160              Voltage characteristics       Event classification labels
  (adopted by BIS)      of public distribution        Sag/swell/rapid variation
                        systems                       categories used in diagnostics
  ────────────────────────────────────────────────────────────────────
  Note: SGS is a monitoring and protection device, not a certified relay.
  The implementations above are engineering-faithful approximations using
  the reference formulas and thresholds from these standards.
```

---

## 21. Configuration Reference

All tuneable parameters are in `config.h`. The table below summarises the most
important ones with their current values and the rationale for each choice.

```
  Parameter                Value     Rationale
  ─────────────────────────────────────────────────────────────────────
  NOMINAL_VOLTAGE_V        230.0V    Indian single-phase standard
  VOLTAGE_FULL_SCALE       300V      Headroom above OV_INSTANT (270V)
  CURRENT_FULL_SCALE       30A       Covers 16A MCB + SC detection at 27A
  RATED_CURRENT_A          16A       Standard Indian household MCB
  IIR_ALPHA_VOLTAGE        0.20      ~5-sample smoothing on voltage
  IIR_ALPHA_CURRENT        0.30      Slightly faster — current changes faster
  CURR_DEADBAND_A          0.10A     0.33% of 30A scale — noise floor
  MOVING_AVG_DEPTH         10        100ms window for display smoothing
  ADC_OVERSAMPLE           4         +1 ENOB; 4× chosen for 100Hz budget
  SENSOR_LOOP_MS           10ms      100Hz — protection task tick rate
  COMMS_LOOP_MS            50ms      20Hz — OLED + MQTT comms tick rate
  WDT_TIMEOUT_S            10s       Watchdog: panic if protection task hangs
  INRUSH_BLANK_MS          3500ms    Worst-case Indian load: water pump
  INRUSH_BLANK_WARN_MS     1000ms    Shorter blank for warning-level events
  VOLT_RECOVERY_CONFIRM_N  50        500ms of stable voltage before reclose
  RECLOSE_DELAY_1_MS       5000ms    Trip 1 → 5s dead time
  RECLOSE_DELAY_2_MS       15000ms   Trip 2 → 15s dead time
  RECLOSE_DELAY_3_MS       30000ms   Trip 3 → 30s dead time → LOCKOUT
  MAX_TRIP_COUNT           3         Three strikes before LOCKOUT
  IDMT_TMS                 0.10      Time Multiplier — adjust trip speed
  TEMP_FAULT_C             85°C      Electrolytic capacitor rated limit
  TEMP_RESET_BLOCK_C       60°C      Must cool before reset allowed
  HEAP_WARN_BYTES          20000B    Warn if free heap falls below ~20KB
  EVENT_LOG_CAPACITY       50        NVS ring buffer entries
  MQTT_PUB_INTERVAL_MS     5000ms    Telemetry publish rate
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
     themselves cannot be trusted (saturated, frozen, physically impossible
     readings), the protection is meaningless. SGS knows when it is blind.

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