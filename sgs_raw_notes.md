# SMART GRID SENTINEL (SGS) — COMPLETE RAW RESEARCH NOTES
## For IEEE Paper Preparation
### Compiled from: config.h (Rev 3.0), firmware extractions, HIL test suite, HIL results, gap analysis sessions
### Status: Living document — all gaps resolved except D1, D2, D4 (pending author confirmation)

---

# PART 1 — SYSTEM IDENTITY

## 1.1 System Name & Purpose

- **Full Name:** Smart Grid Sentinel (SGS)
- **Type:** Real-time single-phase electrical protection relay + grid monitoring IoT device
- **Target Grid:** Indian residential/light-industrial grid — 230V nominal, 50Hz, single-phase
- **Primary Function:** Autonomously protect connected loads from power quality anomalies and electrical faults by tripping relay-controlled outputs and alerting operators
- **Secondary Functions:** Cloud telemetry streaming, local HMI (OLED + buzzer + LEDs), local HTTP REST API, WebSocket push server

## 1.2 Faults Protected Against

1. Overvoltage (OV) — instant and sustained
2. Undervoltage (UV) — instant (supply collapse) and sustained
3. Overcurrent (OC) — via IDMT IEC 60255 accumulator
4. Short Circuit (SC) — ANSI 50 instantaneous
5. Thermal Overload — DS18B20 temperature sensing
6. Sensor Hardware Failure — ADC saturation, frozen sensor, physics impossibility

## 1.3 Standards Compliance Targets

| Standard | Scope |
|---|---|
| IS 12360 | Indian voltage tolerance ±10% consumer side |
| CEA Regulations 2005 | Supply voltage ±6% at point of delivery |
| IS 8828 | MCB trip curves (mirrors IEC 60898) |
| IEC 60255 | IDMT overcurrent protection curves |
| IEC 60898 | MCB Curve B/C/D trip multiples |
| IEC 61000-4-15 | Flicker / power quality |
| EN 50160 | Voltage event classification (adopted by BIS) |

**NOTE FOR PAPER:** Compliance is design-intent, not lab-certified. EC-06/07/08 (sensor faults) verified by author on hardware. IDMT verified via HIL to ±0.5% of formula.

## 1.4 Firmware Revision

- `config.h` header: **REVISION 3.0 — Full Indian Grid Compliance**
- `HARDWARE_BENCH_TESTING` flag: **SET TO 1** in current config — disables Stage 2 sensor fault detection (EC-06/07/08) — MUST BE 0 FOR PRODUCTION BINARY
- **SECURITY NOTE:** MQTT credentials are hardcoded plaintext in config.h — rotate before paper publication (lines 447–448)

---

# PART 2 — HARDWARE

## 2.1 Bill of Materials (Complete)

| Component | Model | Role | Firmware File |
|---|---|---|---|
| MCU | ESP32 (dual-core Xtensa LX6) | Main controller, FreeRTOS execution, ADC, GPIO, WiFi | `main.cpp`, `config.h` |
| Voltage Sensor | ZMPT101B | Voltage transformer, maps 0–300V AC to 0–3.3V ADC range | `config.h` |
| Current Sensor (primary) | SCT-013-030 | Split-core CT, 0–30A → 0–1V output | `config.h` |
| Current Sensor (alt) | ACS758-30AB | Hall-effect sensor, 0–30A — alternative to SCT-013 | `config.h` |
| Temperature Sensor | DS18B20 | 1-Wire digital, 12-bit resolution, ±0.5°C accuracy | `ds18b20.cpp`, `config.h` |
| Display | SSD1306 OLED | 128×64 pixels, I²C, local status display | `oled_display.cpp`, `config.h` |
| Relay Module | Active-LOW Relay ×2 | Switches Load1 and Load2 (line-side isolation) | `relay_control.cpp`, `config.h` |
| Buzzer | Piezo buzzer | Driven via ESP32 LEDC peripheral | `buzzer.cpp`, `config.h` |
| Alert LED | Single LED | Blink/solid patterns for fault states | `led_alert.cpp`, `config.h` |
| Load Status LEDs | Green + Yellow ×4 | Green/Yellow pair per relay (Load1, Load2) | `led_alert.cpp`, `config.h` |

## 2.2 GPIO Pin Assignments (from config.h)

| Signal | GPIO Pin | Direction | Notes |
|---|---|---|---|
| PIN_RELAY_LOAD1 | 26 | Output | Active-LOW |
| PIN_RELAY_LOAD2 | 27 | Output | Active-LOW |
| PIN_ALERT_LED | 14 | Output | |
| PIN_BUZZER | 25 | Output | LEDC PWM |
| PIN_DS18B20 | 13 | Bidirectional | 1-Wire bus |
| PIN_OLED_SDA | 32 | I²C | NOT GPIO 34/35 (input-only) |
| PIN_OLED_SCL | 33 | I²C | |
| PIN_LED_LOAD1_GREEN | 17 | Output | Load1 closed indicator |
| PIN_LED_LOAD1_YELLOW | 16 | Output | Load1 open indicator |
| PIN_LED_LOAD2_GREEN | 18 | Output | Load2 closed indicator |
| PIN_LED_LOAD2_YELLOW | 19 | Output | Load2 open indicator |
| ADC Voltage (ZMPT101B) | GPIO34 / ADC1_CH6 | Analog Input | Input-only pin |
| ADC Current (SCT-013) | GPIO35 / ADC1_CH7 | Analog Input | Input-only pin |

## 2.3 Interface Summary

| Interface | Detail | Used By |
|---|---|---|
| GPIO (Digital Output) | Relay pins 26,27; Alert LED 14; Buzzer 25; Load LEDs 16,17,18,19 | relay_control, led_alert, buzzer |
| GPIO (Digital I/O) | DS18B20 1-Wire on GPIO 13 | ds18b20.cpp |
| ADC | ESP32 12-bit, 4× oversampling, voltage + current channels | adc_sampler.cpp |
| I²C | SSD1306 at 0x3C; SDA=32, SCL=33; 400kHz | oled_display.cpp |
| 1-Wire | DS18B20 on GPIO 13 | ds18b20.cpp |
| LEDC (PWM) | Channel 0, 8-bit resolution; buzzer at 500/1000/2000 Hz | buzzer.cpp |
| WiFi 802.11 b/g/n | STA mode; fallback to AP "SGS-Setup" captive portal | wifi_manager.cpp |
| MQTT over TLS | Port 8883, HiveMQ Cloud | mqtt_client.cpp |
| HTTP REST | Port 80, ESPAsyncWebServer | api_server.cpp |
| WebSocket | ws://[ip]/ws/telemetry, 1 Hz push | ws_server.cpp |
| UART/USB-CDC | 115200 baud, debug + HIL command interface | main.cpp |
| NVS Flash | Preferences library, stores WiFi creds, MQTT config, 50-entry event log | nvs_log.cpp, mqtt_client.cpp, wifi_manager.cpp |

---

# PART 3 — FIRMWARE ARCHITECTURE

## 3.1 File Roles (Complete)

| File | Role |
|---|---|
| `config.h` | Central config: GPIO pins, thresholds, timing, RTOS params, fault bitmasks, standards |
| `main.cpp` | Entry point; RTOS task creation+pinning; shared state + seqlock setup; boot orchestration |
| `adc_sampler.cpp` | ADC oversampling + IIR/moving-avg filtering for V and I; exposes calibrated physical values |
| `ds18b20.cpp` | DS18B20 1-Wire driver; non-blocking conversion; boot+disconnect sentinel handling |
| `fault_engine.cpp` | Protection logic core: all fault conditions, IDMT accumulator, inrush blanking |
| `fsm.cpp` | Finite state machine (BOOT→NORMAL→WARNING→FAULT→RECOVERY→LOCKOUT) |
| `relay_control.cpp` | Active-LOW relay driver; safe GPIO init order; atomic API override |
| `led_alert.cpp` | Non-blocking blink patterns; load status LED updates |
| `buzzer.cpp` | Non-blocking LEDC tone sequencer; FSM-state-to-tone mapping |
| `oled_display.cpp` | Two-page SSD1306 driver; Page1=live V/I/T/P; Page2=fault/relay/recovery status |
| `sensor_diagnostics.cpp` | Sliding-window diagnostics: variance, saturation, physics cross-checks |
| `nvs_log.cpp` | NVS ring-buffer event log (50 entries); mutex-protected |
| `mqtt_client.cpp` | MQTT/TLS client; structured telemetry; remote commands; exponential backoff reconnect |
| `wifi_manager.cpp` | WiFi provisioning: STA connect 20s timeout; NVS cred storage; AP fallback |
| `api_server.cpp` | REST API registration: /api/telemetry, /api/reset, /api/relay, /api/state, /api/config, /api/log |
| `ws_server.cpp` | WebSocket push: broadcast telemetry snapshot at 1 Hz |
| `telemetry_builder.cpp` | Serialises SensorReading + FSMContext to JSON; seqlock-protected snapshot |
| `GridVoltageSimulator.cpp` | Software 50Hz grid: harmonics (H3/H5/H7), flicker, sag/swell, AWGN — HIL/SIL testing |
| `GridCurrentSimulator.cpp` | Motor inrush model: DC offset decay, slip-dependent rotor, CT saturation — HIL/SIL testing |
| `phantom_grid.cpp` | Shared atomic state for SIL command bus between USB HIL listener and simulator tasks |

## 3.2 FreeRTOS Task Parameters (from config.h)

| Task | Stack Words | Priority | Loop Period |
|---|---|---|---|
| Protection (sensor + fault engine + FSM) | 4096 | **5 (highest)** | 10 ms (100 Hz) |
| Comms (MQTT + WebSocket + REST) | 6144 | 3 | 50 ms (20 Hz) |
| Health Monitor | 2048 | **1 (lowest)** | 10,000 ms |

- **Core pinning:** Not specified in config.h — located in `main.cpp` via `xTaskCreatePinnedToCore()` calls — NOT YET EXTRACTED
- Watchdog timeout: **30 seconds** (`WDT_TIMEOUT_S`)
- Heap warning threshold: **20,000 bytes** (`HEAP_WARN_BYTES`)

## 3.3 Shared State Concurrency Model

- `telemetry_builder.cpp` maintains a seqlock-protected snapshot of SensorReading + FSMContext
- Async readers (WebSocket, REST API) read from this snapshot — never block the protection task
- API override encoded in single `atomic<uint32_t>`: bit0=active, bit1=desired_close
- **Seqlock algorithm not fully extracted** — in main.cpp — NOT YET DOCUMENTED

---

# PART 4 — DATA FLOW (COMPLETE)

## 4.1 Physical Mode (Production) — Sensor Acquisition

```
ADC1_CH6 (GPIO34) [ZMPT101B voltage]
  → adc1_get_raw() × 4 oversample (average n_ok reads)
  → rawToVoltage()  [polynomial cal — see Section 5.1]
  → raw_v_phys      ←── PROTECTION PATH STOPS HERE
  → IIR filter (α=0.20)
  → 10-sample rolling average
  → v_filtered      ←── TELEMETRY / DISPLAY PATH

ADC1_CH7 (GPIO35) [SCT-013 / ACS758 current]
  → adc1_get_raw() × 4 oversample
  → rawToCurrent()  [IDF calibration — see Section 5.1]
  → raw_i_phys      ←── PROTECTION PATH STOPS HERE
  → IIR filter (α=0.30)
  → deadband snap to 0.00A if raw_i_phys < 0.10A
  → 10-sample rolling average
  → i_filtered      ←── TELEMETRY / DISPLAY PATH

DS18B20 (GPIO 13, 1-Wire)
  → non-blocking: requestTemperatures() → wait 800ms → getTempCByIndex(0)
  → classify() → STATE_VALID / BOOT_SENTINEL / DISCONNECTED / INVALID_RANGE
  → last_valid_temp (written ONLY on STATE_VALID)
  → DS18B20::getTemp(), isReady(), isDisconnected()
```

## 4.2 SIL Mode (Simulation Active) — Sensor Acquisition

```
GridVoltageSimulator::tick(dt=100µs) × 100 iterations → accumulate acc_v_sq
GridCurrentSimulator::tick(dt=100µs) × 100 iterations → accumulate acc_i_sq

v_new = sqrt(acc_v_sq / 100)    [True RMS over effective half-cycle]
i_new = sqrt(acc_i_sq / 100)

Physics coupling (EC-08 prevention in SIL):
  if v_new < SENSOR_PHYSICS_V_MAX (5.0V):
    i_new *= v_new / SENSOR_PHYSICS_V_MAX
    [prevents physics-impossible combinations in simulation — see Contradiction D5]

ADC mapping:
  raw_v = round((v_new / 300.0) × 4095) + gaussian_noise (3 uniform[-1..1] summed)
  raw_i = round((i_new / 30.0)  × 4095) + gaussian_noise

Saturation guard:
  raw_v, raw_i clamped to [6, 4089]  [avoids false saturation trips]

→ continues SAME pipeline as Physical mode from raw_v_phys onward
```

## 4.3 Protection Path (FaultEngine Input)

```
raw_i_phys → 3-sample median filter (EMI spike rejection) → i_med
           → asymmetric IIR (α_rise=0.90, α_fall=0.10) → i  [protection current]

raw_v_phys → v  [voltage — passed DIRECTLY, no additional filter in FaultEngine]
```

## 4.4 Downstream (Complete Signal Flow)

```
v, i, t → FaultEngine::evaluate() [runs every 10ms]
        → fault_bits (uint16), warn_bits (uint16)

fault_bits + warn_bits → FSM::tick()
                       → FSMContext (state, fault_type, trip_count, timers, etc.)

FSMContext → RelayControl::update() → GPIO26, GPIO27 (relays open/close)
FSMContext → LedAlert::tick()       → GPIO14 (alert LED blink), GPIO16-19 (load LEDs)
FSMContext → Buzzer::tick()         → LEDC CH0 (audio alert tones)
FSMContext + SensorReading → OLEDDisplay::update() → I²C SSD1306
FSMContext + SensorReading → TelemetryBuilder::update() → seqlock snapshot
                           → MQTTClient::tick()  → WiFi/TLS → HiveMQ Cloud (every 5s)
                           → WSServer::tick()    → WiFi → browser (every 1s)
```

---

# PART 5 — ADC & SIGNAL PROCESSING

## 5.1 ADC Conversion Functions

### rawToVoltage() — Three Modes (compile-time toggle)

**MODE 1 (ACTIVE): USE_ADC_CAL_POLYNOMIAL = 1**
```
v = a·x³ + b·x² + c·x + d
  where x = raw ADC value (0–4095)
  a = 4.198 × 10⁻¹⁰
  b = -2.13 × 10⁻⁶
  c = 0.0768
  d = 0.50
Output clamped to ≥ 0V
```

**MODE 2 (OFF): USE_ADC_CAL_LUT = 1**
```
9-point LUT:
  (0→0V), (500→36.6V), ..., (4095→300V)
  Linear interpolation between segments
```

**FALLBACK: IDF calibration**
```
v = (esp_adc_cal_raw_to_voltage(raw) / 3300.0) × 300.0
```

### rawToCurrent()
```
i = (esp_adc_cal_raw_to_voltage(raw) / 3300.0) × 30.0
```

**NOTE:** Polynomial constants (a,b,c,d) are hardcoded — no documented calibration procedure against reference meter. For paper: note as empirical fit, mark as design-intent calibration.

## 5.2 ADC Oversampling

- 4× oversample → average of n_ok reads
- Effective ENOB: ~13-bit on stable signal (12-bit + 1 from oversampling)
- Comment in config.h: "16× recommended for +2 ENOB but increases loop latency — use 4× at 100Hz"
- ADC_MAX_RAW = 4095.0

## 5.3 IIR Filter (Exponential Moving Average) — Telemetry Path

```
output(n) = α × new_val + (1 − α) × output(n−1)

Voltage (telemetry): α = 0.20  (slower — grid V doesn't change instantaneously)
Current (telemetry): α = 0.30  (faster response)
```

## 5.4 Asymmetric IIR — Protection Path

```
α = α_rise  if new_val ≥ prev
α = α_fall  if new_val < prev

output = α × new_val + (1 − α) × prev

α_rise = 0.90  [catches 30A fault in ~1 sample]
α_fall = 0.10  [rejects transient downward spikes]
```

Applied to: `i_med` (median-filtered current) → `i` (protection current)

## 5.5 Rolling Average (10-sample) — Display/Telemetry Path

```
Circular buffer, depth = MOVING_AVG_DEPTH = 10
Mean recomputed from live entries every tick
Variance uses Bessel's correction: denominator = (count − 1)
```

## 5.6 Noise Floor Tracking

```
residual_v = raw_v_phys − iir_v
residual_i = raw_i_phys − iir_i

noise_v_rms_sq(n) = 0.05 × residual_v² + 0.95 × noise_v_rms_sq(n−1)
noise_i_rms_sq(n) = 0.05 × residual_i² + 0.95 × noise_i_rms_sq(n−1)

getNoiseFloorV() = sqrt(noise_v_rms_sq)
getNoiseFloorI() = sqrt(noise_i_rms_sq)
```

## 5.7 Drift Detection (Dual-EMA)

```
v_ema_fast(n) = 0.10  × v_filtered + 0.90  × v_ema_fast(n−1)
v_ema_slow(n) = 0.005 × v_filtered + 0.995 × v_ema_slow(n−1)

Every DRIFT_UPDATE_MS (1000ms):
  v_drift_rate = (v_ema_fast − v_ema_slow) / dt_s   [V/s]
  i_drift_rate = (i_ema_fast − i_ema_slow) / dt_s   [A/s]

Fast α=0.10, Slow α=0.005
```

## 5.8 Current Slope (5-sample circular buffer)

```
slope = (buf[newest] − buf[oldest]) / (5 × SENSOR_LOOP_MS / 1000)  [A/s]
      = (buf[newest] − buf[oldest]) / 0.050  [A/s]

Valid only when buffer is full (≥ 5 ticks = 50ms after startup)
Used for: SC detection inside inrush window (INRUSH_SC_SLOPE_A_PER_S = 10.0 A/s)
Used for: WARN_CURR_RISING (slope ≥ 2.0 A/s)
```

## 5.9 Sample Rate Measurement

```
Measured over 2000ms window
actual_rate_hz = count × 1000.0 / elapsed_ms
Target: 100 Hz (SENSOR_LOOP_MS = 10ms)
```

## 5.10 Saturation Detection

```
Voltage channel:
  saturated  = (raw_v ≤ 5  OR  raw_v ≥ 4090)
  cleared    = (raw_v > 1000 AND raw_v < 4045)

Current channel:
  saturated  = (raw_i ≥ 4090)  ← LOW RAIL NOT INCLUDED (raw_i=0 valid at no-load)
  cleared    = (raw_i < 4045)
```

**⚠ CONTRADICTION D1:** Stage 2 (EC-06) code checks `i_sat = (raw_i ≤ 5 OR raw_i ≥ 4090)` — includes low rail. Section 2.9 says current saturated ONLY on high rail. Author to confirm correct behavior.

## 5.11 Debounce Logic (Generic)

```
if condition:
    counter++
    if counter ≥ threshold: return true  [cap counter at threshold]
else:
    counter = 0
    return false
```

### Adaptive Debounce Thresholds

```
if i ≥ LOAD_HEAVY_A (12.0A):
    fault_thresh = FAULT_DEBOUNCE_HEAVY = 5  [50ms @ 10ms/tick]
    warn_thresh  = WARN_DEBOUNCE_HEAVY  = 4  [40ms]
else:
    fault_thresh = FAULT_DEBOUNCE_N     = 3  [30ms]
    warn_thresh  = WARN_DEBOUNCE_N      = 2  [20ms]

FAULT_DEBOUNCE_INSTANT = 2  [20ms — for OV_INST, UV_INST, SC]
```

---

# PART 6 — VOLTAGE & CURRENT THRESHOLDS (ALL VALUES CONFIRMED FROM config.h)

## 6.1 Grid Reference

| Parameter | Value | Standard |
|---|---|---|
| NOMINAL_VOLTAGE_V | 230.0 V | IS 12360 |
| GRID_FREQ_HZ | 50.0 Hz | Indian grid |
| VOLTAGE_FULL_SCALE | 300.0 V | ADC rail |
| CURRENT_FULL_SCALE | 30.0 A | Changed from 5A prototype |
| RATED_CURRENT_A | 16.0 A | IS 8828 MCB |

## 6.2 Voltage Zone Diagram

```
Volts: 0   150   170  207  216  218.5  230  241.5  243  253  270  300
       |    |     |    |    |    |      |    |      |    |    |    |
     VOID  UV_   [gap] UV_  UV_  RA_LO  NOM  RA_HI  OV_  OV_  OV_  RAIL
           INST        FLT  WRN             OV     WRN  FLT  INST
```

## 6.3 Overvoltage Thresholds

| Parameter | Value | Description | Standard |
|---|---|---|---|
| VOLT_OV_WARN_V | 243.0 V | CEA +6% — WARNING issued | CEA 2005 |
| VOLT_OV_WARN_HYST_V | 240.0 V | Warning dropout | — |
| VOLT_OV_FAULT_V | 253.0 V | IS 12360 +10% — debounced FAULT | IS 12360 |
| VOLT_OV_FAULT_HYST_V | 245.0 V | OV fault dropout (8V band) | EN 50160 |
| VOLT_OV_INSTANT_V | 270.0 V | MOV protection zone — ZERO debounce (EC-10) | — |

## 6.4 Undervoltage Thresholds

| Parameter | Value | Description | Standard |
|---|---|---|---|
| VOLT_UV_WARN_V | 216.0 V | CEA -6% — WARNING issued | CEA 2005 |
| VOLT_UV_WARN_HYST_V | 220.0 V | UV warning dropout | — |
| VOLT_UV_FAULT_V | 207.0 V | IS 12360 -10% — debounced FAULT | IS 12360 |
| VOLT_UV_FAULT_HYST_V | 215.0 V | UV fault dropout (8V band) | EN 50160 |
| VOLT_UV_STARTUP_V | 160.0 V | Expanded UV tolerance during motor inrush (EC-09) | — |
| VOLT_UV_INSTANT_V | 150.0 V | Supply collapse — LOCKOUT class (EC-05b) | — |

## 6.5 Recovery Window

| Parameter | Value | Description |
|---|---|---|
| VOLT_RECOVERY_LO_V | 218.5 V | IS 12360 Range A lower (230×0.95) |
| VOLT_RECOVERY_HI_V | 250.0 V | IS 12360 Range A upper (230×~1.087) |
| VOLT_RECOVERY_CONFIRM_N | 50 samples | 50 × 10ms = 500ms of stable voltage |

## 6.6 Current Zones

```
Amperes: 0   0.1   0.5   12   15   16.5  18   19.2  21   27   30
         |    |     |     |    |    |     |    |     |    |    |
       DEAD NOISE IDLE  HEAVY OC_  OC_   OC_  RATED_  IDMT  SC   RAIL
            FLOOR       LOAD  WARN  HYST  FLT  ×1.2   ZONE INST
```

| Parameter | Value | Description |
|---|---|---|
| CURR_DEADBAND_A | 0.10 A | Noise floor — forced to 0.00A |
| CURR_IDLE_LIMIT_A | 0.5 A | Load detection threshold |
| LOAD_HEAVY_A | 12.0 A | Heavy-load adaptive debounce (75% rated) |
| CURR_OC_WARN_A | 18.0 A | 112% rated — OC WARNING |
| CURR_OC_WARN_HYST_A | 15.0 A | OC warning dropout |
| CURR_OC_FAULT_A | 21.0 A | 131% rated — IDMT accumulator starts |
| CURR_OC_FAULT_HYST_A | 16.5 A | OC fault dropout |
| CURR_SC_RUNNING_INSTANT_A | 27.0 A | SC trip while running (169% of 16A rated) |
| CURR_SC_STARTUP_INSTANT_A | 110.0 A | SC trip during motor startup |
| CURR_SC_HARD_A | 120.0 A | Catastrophic SC — ALWAYS active |

---

# PART 7 — IDMT OVERCURRENT (IEC 60255 STANDARD INVERSE)

## 7.1 Formula

```
t(I) = TMS × K / ((I/Is)^α − 1)

Constants (CONFIRMED from config.h, consistent with test generator):
  K     = IDMT_K     = 0.140   [Standard Inverse curve constant]
  α     = IDMT_ALPHA = 0.020   [Standard Inverse exponent]
  TMS   = IDMT_TMS   = 0.10    [Time Multiplier Setting — tuned for 16A Indian household]
  Is    = IDMT_IS    = CURR_OC_FAULT_A = 21.0A  [pickup current]
```

## 7.2 Trip Time Reference Values (at TMS=0.10, Is=21A)

| Current | I/Is | Theory (ms) | HIL Actual (ms) | Error |
|---|---|---|---|---|
| 21.5A | 1.024× | 29,742 | 29,770 | +0.09% |
| 22.0A | 1.048× | 15,040 | 15,060 | +0.13% |
| 22.5A | 1.071× | 10,139 | 10,170 | +0.31% |
| 23.0A | 1.095× | 7,688 | 7,720 | +0.42% |
| 23.5A | 1.119× | 6,216 | 6,240 | +0.39% |
| 24.0A | 1.143× | 5,235 | 5,250 | +0.29% |
| 24.5A | 1.167× | 4,534 | 4,550 | +0.35% |
| 25.0A | 1.190× | 4,008 | 4,020 | +0.30% |
| 25.5A | 1.214× | 3,598 | 3,610 | +0.33% |
| 26.0A | 1.238× | 3,271 | 3,280 | +0.28% |
| 26.5A | 1.262× | 3,002 | 3,010 | +0.27% |
| 27A+ | — | SC INSTANT trip bypasses IDMT | <30ms | — |
| 22A (example) | 1.048× | ~15,000 | — | — |
| 25A (example) | 1.190× | ~4,000 | — | — |

**ALL 11 HIL IDMT tests PASS within ±30% IEC 60255 compliance window.**
**Actual error ≤ 0.5% — well within window. PUBLISHABLE RESULT.**

## 7.3 Accumulator Method (Discrete Integration)

```
Per tick (every SENSOR_LOOP_MS = 10ms), if NOT startup_active:

IF i < IDMT_IS (21A):
    idmt_accumulator *= IDMT_ACCUMULATOR_DECAY  (= 0.995 per tick → 0.5%/tick thermal decay)

IF i ≥ IDMT_IS:
    ratio = i / IDMT_IS
    denom = exp(IDMT_ALPHA × ln(ratio)) − 1.0
    IF denom ≤ 1e-6:  [singularity guard]
        accumulator += SENSOR_LOOP_MS / IDMT_MAX_TRIP_MS
    ELSE:
        t_trip_ms = IDMT_TMS × IDMT_K / denom × 1000
        t_trip_ms = clamp(t_trip_ms, IDMT_MIN_TRIP_MS, IDMT_MAX_TRIP_MS)
        idmt_accumulator += 10 / t_trip_ms
    cap accumulator at 2.0  [anti-windup]

TRIP when: idmt_accumulator ≥ 1.0
```

## 7.4 IDMT Parameters (All Confirmed from config.h)

| Parameter | Value | Description |
|---|---|---|
| IDMT_K | 0.140 | Standard Inverse curve constant |
| IDMT_ALPHA | 0.020 | Standard Inverse exponent |
| IDMT_TMS | 0.10 | Time Multiplier Setting |
| IDMT_IS | 21.0A | Pickup = CURR_OC_FAULT_A |
| IDMT_ACCUMULATOR_DECAY | 0.995 | Per-tick decay factor below pickup (0.5%/tick) |
| IDMT_MIN_TRIP_MS | 200 ms | Hardware minimum (relay mechanical delay) |
| IDMT_MAX_TRIP_MS | 60,000 ms | Maximum — beyond = sustained overload handling |

## 7.5 IDMT Hysteresis & Clear Rules

```
Hysteresis (OC):
  Latch: i ≥ CURR_OC_FAULT_A (21A)
  Release: i < CURR_OC_FAULT_HYST_A (16.5A)

Clear FAULT_BIT_OC_IDMT:
  ONLY when NOT hysteresis-latched AND accumulator < 0.05
  NOT cleared by trip/reset alone

clearLatched(): resets accumulator to 0.0, clears OC_IDMT bit, resets debounce counters
```

---

# PART 8 — FAULT ENGINE (6-STAGE PIPELINE, runs every 10ms)

## 8.1 Stage 1 — Signal Pre-processing

```
1. 3-sample median filter on raw_i_phys → i_med   [EMI spike rejection]
2. asymIIR(i_med, iir_i, α_rise=0.90, α_fall=0.10) → i   [protection current]
3. Update 5-sample slope buffer → currentSlope()
```

## 8.2 Stage 2 — Sensor Hardware Validation

**⚠ ENTIRELY SKIPPED when HARDWARE_BENCH_TESTING = 1 (currently set in config)**
**Author confirms EC-06/07/08 verified manually on hardware.**

### EC-06 — ADC Saturation Fault

```
v_sat = (raw_v ≤ 5  OR  raw_v ≥ 4090)
i_sat = (raw_i ≤ 5  OR  raw_i ≥ 4090)   ← NOTE: Both rails for voltage; D1 unresolved for current

If saturation starts: record v_sat_start_ms / i_sat_start_ms
If (now − sat_start_ms) ≥ SENSOR_SAT_WINDOW_MS (50ms):
    → set FAULT_BIT_SENSOR → LOCKOUT class

Clear voltage saturation: raw_v > 1000 AND raw_v < 4045
Clear current saturation: raw_i < 4045

VERIFIED by author on hardware. ✅
```

### EC-07 — Frozen Sensor

```
Voltage frozen:
    intBufVariance(frozen_v_buf, 20) < 0.01 → FAULT_BIT_SENSOR (immediate)

Current frozen:
    intBufVariance(frozen_i_buf, 20) < 0.01
    AND load_state != IDLE         [i=0 at idle is NORMAL]
    AND voltage variance ≥ 1.0     [voltage sensor alive — cross-check]
    AND frozen_i_consec_cnt ≥ 200  [200 consecutive ticks = 2.0s]
    → FAULT_BIT_SENSOR

Variance method: Bessel-corrected sample variance = (Σx² − n×mean²)/(n−1)

VERIFIED by author on hardware. ✅
```

### EC-08 — Physics Impossibility

```
Condition: i_med ≥ 2.0A  AND  v < 5.0V  AND  i_med < CURR_SC_RUNNING_INSTANT_A (27A)
Reasoning: AC mains physically cannot have significant current with near-zero voltage
           UNLESS it's a true short circuit (SC exception: SC is real, not impossible)
→ FAULT_BIT_SENSOR → LOCKOUT class

SIL NOTE: SIL mode actively prevents this by scaling i_new when v_new < 5V → EC-08 
          untestable in SIL. Moot point: HARDWARE_BENCH_TESTING=1 disables Stage 2 entirely.

VERIFIED by author on hardware. ✅
```

## 8.3 Stage 2.5 — Load State Machine (Motor Startup Model)

### States

| State | Description |
|---|---|
| LOAD_STATE_IDLE | i ≤ 0.5A — no load |
| LOAD_STATE_STARTING | startup_active=true; motor drawing inrush |
| LOAD_STATE_RUNNING | motor running at steady state |
| LOAD_STATE_FAULT | locked rotor timeout — fault state |

### Transitions

```
IDLE:
  if i > CURR_IDLE_LIMIT_A (0.5A):
    if force_resistive → RUNNING
    else:
      → STARTING
        startup_active = true
        load_state_timer_ms = now
        inrush_blank_warn_until_ms = now + 1000ms  [suppress UV/OC warnings 1s]

STARTING (startup_active = true):
  instant_trip_threshold = CURR_SC_STARTUP_INSTANT_A (110A)
  if i < (RATED_CURRENT_A × 1.2) = 19.2A:
    → RUNNING
      startup_exit_ms = now
  if (now − load_state_timer_ms) > T_START_MAX_MS (8000ms):
    → FAULT_BIT_OC_IDMT, initiateLockout(T_LOCKOUT_DOB_MS=180,000ms)
    → LOAD_STATE_FAULT
    threshold = CURR_SC_STARTUP_INSTANT_A (110A)

RUNNING:
  instant_trip_threshold = CURR_SC_RUNNING_INSTANT_A (27A)
  if i < CURR_IDLE_LIMIT_A (0.5A):
    → IDLE
      initiateLockout(T_LOCKOUT_DOB_MS=180,000ms)  [DOB: 3 min compressor safety]

FAULT (load state):
  instant_trip_threshold = CURR_SC_STARTUP_INSTANT_A (110A)
  if i < CURR_IDLE_LIMIT_A → IDLE
```

### Inrush Blanking Window

Indian load inrush profiles (from config.h comments):

| Load Type | Inrush Multiple | Duration | Blank Needed |
|---|---|---|---|
| Ceiling fan | 3–5× | 200–500ms | 600ms |
| Tube light (magnetic) | 5–8× | 100–300ms | 400ms |
| Refrigerator compressor | 5–8× FLA | 500ms–2s | 2,500ms |
| Water pump (fractional) | 6–10× | 500ms–3s | **3,500ms ← worst case** |
| Mixer/grinder | 2–4× brief | 50–100ms | 200ms |
| LED TV / SMPS | 10–20× capacitive | 1–10ms | 50ms |
| Washing machine motor | 5–8× | 500ms–2s | 2,500ms |
| Iron / heater | 1.5–2× cold | 50ms | 150ms |

**T_START_MAX_MS = 8,000ms covers worst-case pump start (3.5s) with margin.**

## 8.4 Stage 3 — Instantaneous Faults (No Blanking, Near-Zero Debounce)

### P3 — Severe OV Instantaneous (EC-10)

```
Trigger: debounce(v ≥ 270.0V, cnt_ov_instant, FAULT_DEBOUNCE_INSTANT=2)
         → 20ms confirmation window
→ FAULT_BIT_OV_INSTANT
Hysteresis clear: v < 265.0V  (5V band)
```

### P3b — UV Supply Collapse (EC-05b)

```
Trigger: (now ≥ uv_mute_ms)  [1000ms from start, or 100ms in bench mode]
         AND debounce(v ≤ 150.0V, cnt_uv_instant, FAULT_DEBOUNCE_INSTANT=2)
→ FAULT_BIT_UV_INSTANT → LOCKOUT class
```

### P2 — Short Circuit ANSI 50 (EC-11)

```
Hard limit (ALWAYS active, no debounce):
  if i ≥ CURR_SC_HARD_A (120A): → FAULT_BIT_SC immediately

Dynamic threshold:
  sc_instant_trip = (i ≥ instant_trip_threshold)
    [27A while RUNNING / 110A while STARTING]

SC detection during startup (slope-gated):
  sc_inside_rising = startup_active AND sc_instant_trip
                     AND slope ≥ INRUSH_SC_SLOPE_A_PER_S (10.0 A/s)

Trip condition:
  debounce(sc_instant_trip AND (NOT startup_active OR sc_inside_rising),
           cnt_sc, FAULT_DEBOUNCE_INSTANT=2)
  → FAULT_BIT_SC → LOCKOUT class

INRUSH_SC_SLOPE_A_PER_S = 10.0 A/s
  Derivation: 0.5A over 50ms window = 10 A/s
  (renamed from INRUSH_SC_SLOPE_A_PER_TICK — old code had incorrect units)
```

## 8.5 Stage 4 — Debounced Sustained Faults

### P5 — Sustained Overvoltage

```
ov_pickup = debounce(v ≥ 253.0V, cnt_ov, fault_thresh)
ov_latched = (FAULT_BIT_OV set) AND hysteresisOV(v)
  hysteresisOV: latch at v ≥ 253V, release at v < 245V

if ov_pickup OR ov_latched: → FAULT_BIT_OV
else: clear FAULT_BIT_OV
```

### P6 — IDMT Overcurrent

*(See Section 7 for full algorithm)*

```
tickIDMT(i, startup_active)
  if startup_active: FREEZE accumulator (no increment, no decay)
  → see Section 7.3 for tick logic

Trip: accumulator ≥ 1.0 → FAULT_BIT_OC_IDMT
```

### P4 — Thermal Limit (EC-12) — LOCKOUT CLASS

```
temp_pickup = debounce(t ≥ TEMP_FAULT_C (85.0°C), cnt_temp_fault, fault_thresh)
temp_latched = (FAULT_BIT_THERMAL set) AND hysteresisTemp(t)
  hysteresisTemp: latch at t ≥ 85°C, release at t < TEMP_FAULT_HYST_C (70°C)

if temp_pickup OR temp_latched: → FAULT_BIT_THERMAL → LOCKOUT class

NOTE: TEMP_FAULT_HYST_C = TEMP_WARN_C = 70°C — same threshold.
      Thermal fault goes DIRECTLY to LOCKOUT (not FAULT→RECOVERY).
      Forces physical inspection before re-energisation. FIRE RISK.
```

### P7 — Sustained Undervoltage

```
Conditional threshold:
  IF startup_active OR (just became RUNNING AND < 500ms elapsed):
    uv_condition = (v ≤ 160.0V)   [expanded tolerance — EC-09]
  ELSE:
    uv_condition = (v ≤ 207.0V)

uv_pickup = debounce(uv_condition, cnt_uv, fault_thresh)
uv_latched = (FAULT_BIT_UV set) AND hysteresisUV(v)
  hysteresisUV: latch at v ≤ 207V, release at v > 215V

if (now ≥ uv_mute_ms) AND (uv_pickup OR uv_latched): → FAULT_BIT_UV
```

## 8.6 Stage 5 — Warning Detection

| Warning Bit | Trigger Condition | Suppressed During | Debounced |
|---|---|---|---|
| WARN_OV | v ≥ 243V AND v < 253V | — | Yes |
| WARN_UV | v ≤ 216V AND v > 207V | Inrush blank (first 1000ms) | Yes |
| WARN_OC | i ≥ 18A AND i < 21A | Inrush blank (first 1000ms) | Yes |
| WARN_THERMAL | t ≥ 70°C AND t < 85°C | — | Yes |
| WARN_CURR_RISING | slope ≥ 2.0 A/s AND i > 0.5A AND i < 21A AND NOT startup | startup_active | No |

## 8.7 Stage 6 — Hysteresis Clear

Each fault has explicit dropout threshold. Fault bits cleared in Stage 4 when neither pickup nor latch condition holds.

## 8.8 Fault Bitmask (from config.h)

| Bit | Hex | Priority | Fault Class |
|---|---|---|---|
| FAULT_BIT_NONE | 0x0000 | — | — |
| FAULT_BIT_SENSOR | 0x0001 | P1 — highest | LOCKOUT |
| FAULT_BIT_SC | 0x0002 | P2 | LOCKOUT |
| FAULT_BIT_OV_INSTANT | 0x0004 | P3 | FAULT |
| FAULT_BIT_THERMAL | 0x0008 | P4 | LOCKOUT |
| FAULT_BIT_OV | 0x0010 | P5 | FAULT |
| FAULT_BIT_OC_IDMT | 0x0020 | P6 | FAULT |
| FAULT_BIT_UV | 0x0040 | P7 | FAULT |
| FAULT_BIT_UV_INSTANT | 0x0080 | P3b | LOCKOUT |

### Priority Resolution Order (highest → lowest)

```
FAULT_BIT_SENSOR    → FAULT_SENSOR
FAULT_BIT_SC        → FAULT_SHORT_CIRCUIT
FAULT_BIT_OV_INSTANT→ FAULT_OVERVOLTAGE
FAULT_BIT_UV_INSTANT→ FAULT_UNDERVOLT (LOCKOUT)
FAULT_BIT_THERMAL   → FAULT_THERMAL (LOCKOUT)
FAULT_BIT_OV        → FAULT_OVERVOLTAGE
FAULT_BIT_OC_IDMT   → FAULT_OVERCURRENT
FAULT_BIT_UV        → FAULT_UNDERVOLT
```

### Lockout Class Faults (no auto-reclose)

```
isLockoutClass() = FAULT_BIT_SENSOR OR FAULT_BIT_THERMAL OR FAULT_BIT_SC OR FAULT_BIT_UV_INSTANT
```

## 8.9 Fault Clearing Rules

### clearLatched() — Called on: auto-reclose, manual reset, RECOVERY→NORMAL

```
Clears: OV, UV, OC_IDMT, SC, OV_INSTANT, UV_INSTANT bits
Resets: IDMT accumulator to 0.0
Resets: all debounce counters
DOES NOT clear: FAULT_BIT_SENSOR, FAULT_BIT_THERMAL
```

### clearAll() — Called ONLY from LOCKOUT manual reset path

```
Clears: ALL fault and warn bits (including SENSOR and THERMAL)
Resets: load state machine to IDLE
Resets: DOB lockout timer to 0
Resets: asymmetric IIR state
Resets: frozen ADC buffers to mid-scale (2048)
Resets: saturation timers
```

## 8.10 Delay-on-Break (DOB) Lockout

```
T_LOCKOUT_DOB_MS = 180,000ms (3 minutes) — compressor safety window

Triggers:
  LOAD_STATE_RUNNING → IDLE (motor stopped)
  LOAD_STATE_STARTING → LOAD_STATE_FAULT (locked rotor timeout)
  Any fault_bits set while state != LOAD_STATE_FAULT

initiateLockout(duration_ms):
  lockout_dob_timer_ms = now + duration_ms

isInLockoutDOB():
  lockout_dob_timer_ms > 0 AND now < lockout_dob_timer_ms

BLOCKS:
  FSM auto-reclose  ← blocked during active DOB
  FSM manual reset  ← blocked during active DOB
  API relay override ← blocked during active DOB  [D4: enforcement method unconfirmed]
```

---

# PART 9 — FINITE STATE MACHINE (FSM)

## 9.1 States

| State | Description | Relay State |
|---|---|---|
| FSM_BOOT | Power-on stabilization; sensors warming up | L1=OFF, L2=OFF |
| FSM_NORMAL | All parameters in range | L1=ON, L2=ON |
| FSM_WARNING | One or more warning conditions active | L1=ON, L2=OFF (shed aux load) |
| FSM_FAULT | Fault tripped; counting down to reclose | L1=OFF, L2=OFF |
| FSM_RECOVERY | Reclose attempted; validating voltage | L1=ON, L2=ON |
| FSM_LOCKOUT | Terminal state; manual reset required | L1=OFF, L2=OFF |

## 9.2 State Transitions (Complete)

### BOOT → NORMAL

```
Condition: millis() ≥ 1000ms
           AND (DS18B20::isReady() OR millis() ≥ DS18B20_BOOT_IGNORE_MS(2000ms) + 500ms)
Action: FaultEngine::clearLatched()  [flush IIR boot-transient faults]
```

### NORMAL → WARNING

```
Condition: any_warn == true AND any_fault == false
```

### NORMAL → FAULT

```
Condition: any_fault == true AND NOT isLockoutClass() AND trip_count ≤ MAX_TRIP_COUNT(3)
Actions:
  trip_count++
  fault_ts_ms = now
  severity = max(severity_I, severity_V)   [see Section 9.3]
  base_delay = f(severity)
  backoff_shift = clamp(trip_count−1, 0, 3)
  active_delay_ms = base_delay × 2^backoff_shift
  target_reclose_ms = now + active_delay_ms
  transition(FSM_FAULT, fault_type)
```

### NORMAL → LOCKOUT

```
Condition: any_fault == true AND (isLockoutClass() OR trip_count > MAX_TRIP_COUNT)
Action: trip_count++, transition(FSM_LOCKOUT)
```

### WARNING → NORMAL

```
Condition: any_warn == false AND any_fault == false
Action: FaultEngine::clearLatched()
```

### WARNING → FAULT / LOCKOUT

Same conditions as NORMAL → FAULT / LOCKOUT

### FAULT → LOCKOUT (in-state escalation)

```
Condition: FaultEngine::isLockoutClass() becomes true while in FAULT state
```

### FAULT → RECOVERY (auto-reclose, Path B)

```
Condition: now ≥ target_reclose_ms
           AND temp_c < TEMP_RESET_BLOCK_C (60.0°C)
           AND NOT FaultEngine::isInLockoutDOB()
Action: FaultEngine::clearLatched(), recovery_v_confirm_count = 0
```

### FAULT → RECOVERY (manual reset, Path A)

```
Condition: reset_requested == true
           AND temp_c < TEMP_RESET_BLOCK_C (60.0°C)
           AND NOT FaultEngine::isInLockoutDOB()
Action: target_reclose_ms = now, FaultEngine::clearLatched()
```

### RECOVERY — Settle Period

```
if (now − target_reclose_ms) < 500ms: do nothing  [sensor settle — relays just closed]
```

### RECOVERY → FAULT (re-trip)

```
Condition: settle ≥ 500ms AND any_fault == true
Actions:
  trip_count++
  if isLockoutClass() OR trip_count > MAX_TRIP_COUNT → LOCKOUT
  else → FAULT (new delay calculation)
```

### RECOVERY → NORMAL

```
Condition: settle ≥ 500ms AND any_fault == false AND voltageStableForRecovery() == true
Actions:
  trip_count = 0
  FaultEngine::clearLatched()
```

### LOCKOUT → RECOVERY (manual reset ONLY)

```
Condition: reset_requested == true
           AND temp_c < TEMP_RESET_BLOCK_C (60.0°C)
           AND NOT FaultEngine::isInLockoutDOB()
Action: FaultEngine::clearAll(), trip_count = 0, active_delay_ms = 0
```

### ANY STATE → LOCKOUT (DS18B20 disconnect, EC-05)

```
Condition: DS18B20::isDisconnected() == true AND state != FSM_LOCKOUT
Action: transition(FSM_LOCKOUT, FAULT_SENSOR)
```

## 9.3 Recovery Voltage Confirmation (voltageStableForRecovery)

```
if v ∈ [VOLT_RECOVERY_LO_V (218.5V), VOLT_RECOVERY_HI_V (250.0V)]:
    recovery_v_confirm_count++
    if recovery_v_confirm_count ≥ VOLT_RECOVERY_CONFIRM_N (50):
        return true   [50 × 10ms = 500ms of stable in-band voltage]
else:
    recovery_v_confirm_count = 0  [restart confirmation window]
    return false
```

**⚠ CONTRADICTION D2 (unresolved):** The 500ms settle period and 500ms voltage confirmation window both reference `target_reclose_ms`. If they run concurrently from the same timestamp, effective total RECOVERY time could be just 500ms. If sequential, it would be 1,000ms. Author to confirm.

## 9.4 Adaptive Severity & Reclose Delay

```
severity_I = max(0, (i − RATED_CURRENT_A) / RATED_CURRENT_A)
           = max(0, (i − 16.0) / 16.0)

severity_V:
  if v > VOLT_OV_FAULT_V (253V): (v − 253.0) / (230.0 × 0.10)
  if v < VOLT_UV_FAULT_V (207V): (207.0 − v) / (230.0 × 0.10)
  else: 0

severity = max(severity_I, severity_V)

base_delay:
  severity ≥ 2.5 → DELAY_SEVERE_MS   (180,000ms = 3 min)
  severity ≥ 1.5 → DELAY_MODERATE_MS (120,000ms = 2 min)
  else           → DELAY_MILD_MS     ( 60,000ms = 1 min)

backoff_shift = clamp(trip_count − 1, 0, 3)
active_delay_ms = base_delay × 2^backoff_shift

Examples:
  Trip 1, mild:   60,000 × 1 =  60,000ms (1 min)
  Trip 2, mild:   60,000 × 2 = 120,000ms (2 min)
  Trip 3, severe: 180,000 × 4 = 720,000ms (12 min) — max cap at shift=3
```

## 9.5 Reclose / Lockout Timing Constants

| Parameter | Value | Description |
|---|---|---|
| DELAY_MILD_MS | 60,000 ms | Severity < 1.5 (minor transient) |
| DELAY_MODERATE_MS | 120,000 ms | Severity 1.5–2.5 |
| DELAY_SEVERE_MS | 180,000 ms | Severity ≥ 2.5 (extreme anomaly) |
| DELAY_PENALTY_MS | 60,000 ms | Added if grid still unstable after wait |
| MAX_TRIP_COUNT | 3 | After 3 trips → LOCKOUT |
| T_LOCKOUT_DOB_MS | 180,000 ms | DOB lockout duration (3 min, compressor) |
| T_START_MAX_MS | 8,000 ms | Max motor startup time before locked-rotor |
| TEMP_RESET_BLOCK_C | 60.0 °C | Reset blocked above this temperature |

## 9.6 Relay Control Logic

```
FSM State → Load1 desired, Load2 desired:
  FSM_BOOT     → false, false  (clears api_override)
  FSM_NORMAL   → true,  true
  FSM_WARNING  → true,  false  (shed auxiliary load)
  FSM_RECOVERY → true,  true
  FSM_FAULT    → false, false
  FSM_LOCKOUT  → false, false  (clears api_override)

API Override:
  Encoded in single atomic<uint32_t>:
    bit0 = override active
    bit1 = desired_close
  Applies only in FSM_NORMAL or FSM_WARNING
  Cleared atomically on FAULT/LOCKOUT/BOOT
  Blocked if DOB active  [D4: enforcement method unconfirmed]

Relay init order (active-LOW safety):
  digitalWrite(pin, HIGH) BEFORE pinMode(pin, OUTPUT)
  → prevents closure glitch during GPIO mode switch
```

## 9.7 DS18B20 Sentinel Handling

### EC-04 — Boot Sentinel (+85°C)

```
DS18B20 scratchpad initialises to exactly +85°C on power-up.
First conversion takes up to 750ms.

Boot window: DS18B20_BOOT_IGNORE_MS = 2,000ms after init()
Within window: if reading == +85.0°C (±0.1°C): DISCARD silently
After window:  +85.0°C treated as REAL thermal fault reading
```

### EC-05 — Disconnect Sentinel (-127°C)

```
Reading = -127.0°C (DEVICE_DISCONNECTED_C):
  disc_debounce_count++
  if disc_debounce_count ≥ DISC_DEBOUNCE_N (3):
    sensor_disconnected = true → triggers FSM LOCKOUT on next tick

On any valid reading: disc_debounce_count = 0

Reconnection detection:
  if valid reading while sensor_disconnected == true:
    sensor_disconnected = false
    sensor_reconnected = true  [pulsed flag; FSM clears via clearReconnectedFlag()]
    NOTE: Reconnection does NOT auto-clear LOCKOUT — manual reset still required

Invalid range: t < -40.0°C OR t > 125.0°C → discard, no update to last_valid_temp
```

---

# PART 10 — HMI BEHAVIOR

## 10.1 Buzzer (LEDC)

| FSM State | Frequency | Pattern |
|---|---|---|
| FSM_BOOT | — | Silent |
| FSM_NORMAL | — | Silent |
| FSM_RECOVERY | — | Silent |
| FSM_WARNING | 1,000 Hz | 50ms ON / 450ms OFF (non-blocking) |
| FSM_FAULT | 2,000 Hz | 200ms ON / 200ms OFF |
| FSM_LOCKOUT | 500 Hz | Continuous (set once, stays on) |

LEDC: Channel 0, 8-bit resolution (BUZZER_LEDC_CHANNEL=0, BUZZER_LEDC_RES_BITS=8)
50% duty = 128 (BUZZER_DUTY_50)

## 10.2 Alert LED

| FSM State | Pattern |
|---|---|
| FSM_BOOT / NORMAL / RECOVERY | Off |
| FSM_WARNING | 500ms ON / 500ms OFF |
| FSM_FAULT | 125ms ON / 125ms OFF |
| FSM_LOCKOUT | Solid ON (steady) |

## 10.3 Load Status LEDs

```
Load1 closed: PIN_LED_LOAD1_GREEN (17) = HIGH, PIN_LED_LOAD1_YELLOW (16) = LOW
Load1 open:   PIN_LED_LOAD1_GREEN (17) = LOW,  PIN_LED_LOAD1_YELLOW (16) = HIGH
(Same logic for Load2: pins 18 green, 19 yellow)
```

## 10.4 OLED Display (SSD1306 128×64)

```
Two-page display, flip every OLED_PAGE_FLIP_MS = 4,000ms
Page 1: Live V / I / T / P readings
Page 2: Fault type / relay status / recovery status
I²C Address: 0x3C
```

---

# PART 11 — SIMULATION ALGORITHMS

## 11.1 GridVoltageSimulator — Coupled-Form Oscillator

```
Each oscillator stores (x1, x2, c, s):
  x1(n+1) = c·x1 − s·x2   [cosine channel]
  x2(n+1) = s·x1 + c·x2   [sine channel]
  c = cos(2π·f·dt), s = sin(2π·f·dt)  [computed ONCE at construction]

Five oscillators:
  Fundamental:  50.0 Hz
  Harmonic H3: 150.0 Hz
  Harmonic H5: 250.0 Hz
  Harmonic H7: 350.0 Hz
  Flicker:       8.8 Hz
```

### Voltage Synthesis

```
v(t) = A(t) × [sin(ω₀t) + α₃·sin(3ω₀t) + α₅·sin(5ω₀t) + α₇·sin(7ω₀t)] + AWGN

Harmonic clamping (IEEE 519-2022):
  α_h3 ≤ 0.05, α_h5 ≤ 0.05, α_h7 ≤ 0.05
```

### Amplitude Modulation

```
Flicker:
  A(t) = v_peak × (1 + flicker_m × sin(2π × 8.8 × t))

Sag/Swell (IIR ramp):
  alpha += (target − alpha) × 0.02 per tick  [smooth transition]
  A(t) *= (1 + alpha)
  target = −depth for sag, +height for swell
```

### Renormalization (numerical stability)

```
Every kNormPeriod ticks:
  r = sqrt(x1² + x2²)
  x1 /= r, x2 /= r  [projects back onto unit circle — prevents drift]
```

### AWGN — Box-Muller with z1 caching

```
u1, u2 ~ Uniform(0,1] via Xorshift32 PRNG
mag = sqrt(−2 × ln(u1))
z0 = mag × cos(2π × u2)
z1 = mag × sin(2π × u2)
Return z0×σ one tick, z1×σ the next tick [halves transcendental cost — cached]
```

### Xorshift32 PRNG

```
state ^= state << 13
state ^= state >> 17
state ^= state << 5
output = (float(state) + 1) × 2.328×10⁻¹⁰  [maps to (0,1]]
```

## 11.2 GridCurrentSimulator — Motor Inrush Model

### Motor Start Initialization

```
I_LR_peak = V_phase / |Z_total(s=1)|   [locked-rotor impedance]
I_DC_state = −I_LR_peak × sin(φ_close_rad)  [DC offset from closing angle]
slip = 1.0   [full slip, cold start]
```

### Per-Tick Computation

```
1. Advance 50Hz oscillator (same coupled-form as voltage simulator)
2. DC offset decay: I_DC_state *= dc_decay_factor
   dc_decay_factor = exp(−dt / τ_stator)   [pre-computed at construction]
3. Slip decay toward s_rated:
   slip = s_rated + (slip − s_rated) × slip_decay_factor
   slip_decay_factor = exp(−dt / τ_mech)   [pre-computed]
4. Slip-dependent rotor parameters (linear skin-effect model):
   R2(s) = R2N + (R2_standstill − R2N) × s
   X2(s) = X2a + (X2N − X2a) × (1 − s)
5. AC peak current (T-equivalent circuit, IEEE 112):
   Re = R1 + R2(s_clamped) / s_clamped    [s clamped to s_rated — singularity guard]
   Im = X1 + X2(s_clamped)
   Z_mag = sqrt(Re² + Im²)
   I_AC_peak = V_phase / Z_mag
6. Composite output:
   i_primary = I_DC_state + I_AC_peak × osc_curr.x2
```

### CT Saturation Model

```
Leaky flux integration:
  V_x = i_sec_ideal × (R_CT + Z_burden)
  flux_accum = flux_accum × flux_leak + V_x × dt

Hard saturation:
  if |flux_accum| ≥ phi_sat:
    return 0.0   [CT blind — secondary collapses — no current measurement]

Arctangent smooth compression (knee region):
  denom = arctan(arctan_a × I_knee)
  i_sec_sat = I_sat × arctan(arctan_a × i_primary/turns_ratio) / denom
  clamped to [−I_sat, I_sat]
```

---

# PART 12 — SENSOR DIAGNOSTICS SCORING

## 12.1 Voltage Stability Score (0–100)

```
Start: 100
noise_v > 10V:  −35;  > 5V: −20;  > 2V: −10;  > 1V: −5
SNR < 15dB:     −30;  < 25dB: −15;  < 35dB: −5
saturated:      −30
cal_type == 0:  −15;  cal_type == 1: −5
sample_count < MOVING_AVG_DEPTH (10): −20
```

## 12.2 Current Stability Score (0–100)

```
Start: 100
noise_a > 0.5A: −35;  > 0.2A: −20;  > 0.1A: −10;  > 0.05A: −5
SNR < 15dB:     −30;  < 25dB: −15;  < 35dB: −5
saturated:      −30
cal_type == 0:  −15;  cal_type == 1: −5
sample_count < MOVING_AVG_DEPTH: −20
```

## 12.3 Thermal Stability Score (0–100)

```
Returns 0 immediately if sensor not present (disconnected)
success_rate < 50%: −40;  < 80%: −20;  < 95%: −10
disconnects > 10:   −30;  > 3: −15;  > 0: −5
variance > 16°C²:   −20;  > 4°C²: −10;  > 1°C²: −5
```

## 12.4 ADC Health Score (0–100)

```
cal_type == 0: −20;  cal_type == 1: −8
rate_dev > 20%: −20;  > 10%: −10
saturation_events > 0: −15
linearity_error > 4%: −10;  > 2%: −5
```

## 12.5 Power Quality Score (0–100)

```
Based on 60-sample sliding window of voltage
voltage_deviation > 15%: −40;  > 10%: −25;  > 5%: −10;  > 2%: −5
sag_depth > 50V: −25;  > 20V: −15;  > 10V: −5
swell_height > 30V: −20;  > 15V: −10
ripple_pct > 10%: −20;  > 5%: −10;  > 2%: −5
flicker_index > 0.05: −15;  > 0.02: −7

Derived metrics:
  mean_v             = mean of 60-sample window
  voltage_deviation% = |mean_v − 230| / 230 × 100
  sag_depth_v        = max(0, 230 − v_min)
  swell_height_v     = max(0, v_max − 230)
  ripple_pct         = (v_max − v_min) / mean_v × 100
  flicker_index      = variance / mean_v²
  apparent_power_va  = mean_v × current_a
  real_power_w       = apparent_power_va × 0.85  [assumed PF=0.85]
```

## 12.6 Overall Health Score (Weighted)

```
overall = voltage_score × 0.25
        + current_score × 0.20
        + thermal_score × 0.20
        + adc_score     × 0.15
        + pq_score      × 0.20

Score labels:
  ≥ 90: EXCELLENT
  ≥ 75: GOOD
  ≥ 50: DEGRADED
   < 50: FAULT

System status:
  ≥ 85: HEALTHY
  ≥ 60: DEGRADED
   < 60: CRITICAL

Uptime quality:
  < 300s: WARMING_UP
  < 3600s: SETTLING
  ≥ 3600s: STABLE
```

## 12.7 SNR Computation

```
SNR = 20 × log10(|signal| / noise_rms)   [dB]
Returns 0 if noise < 1×10⁻⁶ or signal < 1×10⁻³
```

## 12.8 Linearity Error Estimate

```
base_error:
  cal_type == 2: 1.0%
  cal_type == 1: 2.5%
  cal_type == 0: 5.0%

pos = raw_v / 4095.0
if pos ∈ (0.25, 0.75):
  mid_penalty = (0.25 − |pos − 0.5|) × 2.0
else: mid_penalty = 0

linearity_error = base_error + mid_penalty
```

---

# PART 13 — HIL TESTING (PIPELINE A ONLY)

## 13.1 Test Setup

**Type:** Hardware-in-the-Loop (HIL) — firmware running on real ESP32 silicon
**Interface:** USB-UART serial, 115200 baud (CP210x / CH340 / FTDI)
**Orchestrator:** `hil_orchestrator.ps1` (PowerShell)
**Test Suite:** `hil_test_suite_comprehensive.json` — 343 cases
**Suite Generator:** `generate_hil_matrix.py` — uses actual firmware constants from config.h

**Injection format:** `V,I,motor_flag,ticks` payloads over serial
**Response format:** JSON object with `status`, `sim_time_ms`, `cpu_math_ms`

## 13.2 Test Case Distribution

| Category | Count | Description |
|---|---|---|
| VOLTAGE | 199 | UV/OV sweeps, transient rejection, sustained sags |
| NOISE_IMMUNITY | 57 | Normal band — must-NOT-trip cases |
| MOTOR_INRUSH | 54 | Motor startup blanking validation |
| BOUNDARY | 12 | Exact threshold tests at firmware constants |
| IDMT | 11 | Inverse-time OC at 21.5A–26.5A |
| SHORT_CIRCUIT | 10 | Instant trip at ≥27A |
| **TOTAL** | **343** | |

## 13.3 Firmware Thresholds Used as Injection Targets

```
UV_INSTANT:  150V   UV_FAULT:    207V   UV_STARTUP:  160V
OV_FAULT:    253V   OV_INSTANT:  270V
OC_FAULT:     21A   SC_INSTANT:   27A
Nominal:     230V   Rated:        16A   Sensor loop:  10ms
```

## 13.4 Validation Method (Pipeline A)

```
Pass/Fail rules (in order):
  1. No device response     → FAIL (hardware lockup)
  2. Trip ≠ expected        → FAIL (wrong outcome)
  3. SimTime_ms > expected_time_max_ms → FAIL (sluggish relay)
  4. SimTime_ms < expected_time_min_ms (IDMT only) → FAIL (premature trip)
  5. All other → PASS
```

IDMT windows computed as: `t_theory × 0.70` to `t_theory × 1.30` (±30%)

## 13.5 Results — Two Runs (Confirmed Separate Silicon Runs)

**Evidence of two genuine separate runs:**
- CPUTime_ms differs in 342/343 rows between runs (mean diff = 6.1ms → hardware jitter)
- SimTime_ms differs in 6 rows between runs with small deltas:
  - IDMT_23.0A: 7700ms vs 7720ms (accumulator timing noise)
  - IDMT_23.5A: 6230ms vs 6240ms
  - IDMT_24.0A: 5260ms vs 5250ms
  - SC_INSTANT_35.0A: 30ms vs 20ms
  - SC_INSTANT_120.0A: 30ms vs 20ms
  - BOUNDARY_OC_FAULT_EXACT: 60090ms vs 60080ms

**All-PASS anomaly RESOLVED: Firmware genuinely passes all 343 tests across both runs.**

## 13.6 Results Summary by Category

| Category | Tests | Pass | Fail |
|---|---|---|---|
| VOLTAGE | 199 | 199 | 0 |
| NOISE_IMMUNITY | 57 | 57 | 0 |
| MOTOR_INRUSH | 54 | 54 | 0 |
| BOUNDARY | 12 | 12 | 0 |
| IDMT | 11 | 11 | 0 |
| SHORT_CIRCUIT | 10 | 10 | 0 |
| **TOTAL** | **343** | **343** | **0** |

## 13.7 SimTime_ms Statistics by Category

| Category | Min | Mean | Max |
|---|---|---|---|
| VOLTAGE | 20ms | 24.1ms | 30ms |
| SHORT_CIRCUIT | 20ms | 27.0ms | 90ms |
| BOUNDARY | 20ms | 6,528ms | 60,080ms |
| MOTOR_INRUSH | 20ms | 675.6ms | 1,200ms |
| NOISE_IMMUNITY | 200ms | 1,182ms | 1,200ms |
| IDMT | 3,010ms | 8,425ms | 29,770ms |

## 13.8 CPUTime_ms Statistics

| Metric | Value |
|---|---|
| Min | 1.6 ms |
| Mean | 30.4 ms |
| Std Dev | 21.8 ms |
| Max | 292.2 ms (BOUNDARY_OC_FAULT_EXACT) |

**CPU spike EXPLAINED:** 292ms for BOUNDARY_OC_FAULT_EXACT with SimTime=60,080ms is TOTAL ACCUMULATED CPU time across all ticks of a 60-second IDMT test.
Per-tick cost = 292ms / 6,008 ticks ≈ 0.049ms — well within 10ms SENSOR_LOOP_MS. **No real-time violation.**

## 13.9 IDMT Results (Full Table)

| TestID | Current | Theory (ms) | Window (±30%) | Actual (ms) | Error | Result |
|---|---|---|---|---|---|---|
| IDMT_21.5A | 21.5A | 29,742 | [20,818–38,663] | 29,770 | +0.09% | PASS ✅ |
| IDMT_22.0A | 22.0A | 15,040 | [10,528–19,552] | 15,060 | +0.13% | PASS ✅ |
| IDMT_22.5A | 22.5A | 10,139 | [7,096–13,179] | 10,170 | +0.31% | PASS ✅ |
| IDMT_23.0A | 23.0A | 7,688 | [5,380–9,993] | 7,720 | +0.42% | PASS ✅ |
| IDMT_23.5A | 23.5A | 6,216 | [4,351–8,080] | 6,240 | +0.39% | PASS ✅ |
| IDMT_24.0A | 24.0A | 5,235 | [3,664–6,805] | 5,250 | +0.29% | PASS ✅ |
| IDMT_24.5A | 24.5A | 4,534 | [3,173–5,894] | 4,550 | +0.35% | PASS ✅ |
| IDMT_25.0A | 25.0A | 4,008 | [2,804–5,209] | 4,020 | +0.30% | PASS ✅ |
| IDMT_25.5A | 25.5A | 3,598 | [2,518–4,677] | 3,610 | +0.33% | PASS ✅ |
| IDMT_26.0A | 26.0A | 3,271 | [2,289–4,251] | 3,280 | +0.28% | PASS ✅ |
| IDMT_26.5A | 26.5A | 3,002 | [2,101–3,902] | 3,010 | +0.27% | PASS ✅ |

**Max deviation: 0.42% at 23.0A. All within ±1% of IEC formula. PUBLISHABLE.**

## 13.10 Short Circuit Results

| TestID | Current | SimTime_ms | Expected | Result |
|---|---|---|---|---|
| SC_INSTANT_27.0A | 27.0A | 90ms | TRIP | PASS ✅ |
| SC_INSTANT_30.0A | 30.0A | 20ms | TRIP | PASS ✅ |
| SC_INSTANT_35.0A | 35.0A | 20ms | TRIP | PASS ✅ |
| SC_INSTANT_40.0A | 40.0A | 20ms | TRIP | PASS ✅ |
| SC_INSTANT_50.0A | 50.0A | 20ms | TRIP | PASS ✅ |
| SC_INSTANT_60.0A | 60.0A | 20ms | TRIP | PASS ✅ |
| SC_INSTANT_70.0A | 70.0A | 20ms | TRIP | PASS ✅ |
| SC_INSTANT_80.0A | 80.0A | 20ms | TRIP | PASS ✅ |
| SC_INSTANT_100.0A | 100.0A | 20ms | TRIP | PASS ✅ |
| SC_INSTANT_120.0A | 120.0A | 20ms | TRIP | PASS ✅ |

SC at 27A (threshold): 90ms (2× FAULT_DEBOUNCE_INSTANT × 10ms + debounce ticks)
SC above threshold: 20ms (immediate hard limit or minimum debounce)

## 13.11 Boundary Results

| TestID | SimTime_ms | ExpectedResult | Result |
|---|---|---|---|
| BOUNDARY_UV_INSTANT_EXACT | 20ms | TRIP | PASS ✅ |
| BOUNDARY_UV_INSTANT_PLUS1 | 30ms | TRIP | PASS ✅ |
| BOUNDARY_UV_FAULT_EXACT | 30ms | TRIP | PASS ✅ |
| BOUNDARY_UV_FAULT_PLUS1 | 5,000ms | NO_TRIP | PASS ✅ |
| BOUNDARY_OV_FAULT_EXACT | 30ms | TRIP | PASS ✅ |
| BOUNDARY_OV_FAULT_MINUS1 | 5,000ms | NO_TRIP | PASS ✅ |
| BOUNDARY_OV_INSTANT_EXACT | 20ms | TRIP | PASS ✅ |
| BOUNDARY_OV_INSTANT_MINUS1 | 30ms | TRIP | PASS ✅ |
| BOUNDARY_OC_FAULT_EXACT | 60,080ms | TRIP | PASS ✅ |
| BOUNDARY_OC_FAULT_MINUS1 | 5,000ms | NO_TRIP | PASS ✅ |
| BOUNDARY_SC_INSTANT_EXACT | 90ms | TRIP | PASS ✅ |
| BOUNDARY_SC_INSTANT_MINUS1 | 3,010ms | TRIP | PASS ✅ |

## 13.12 Noise Immunity

- 57/57 tests correctly produced NO_TRIP
- All within normal voltage/current band
- SimTime range: 200ms–1,200ms (full test duration)

## 13.13 Motor Inrush

- 30/30 expected NO_TRIP cases passed (inrush blanking correctly suppressed faults)
- 24/24 expected TRIP cases passed (fault correctly detected after inrush window)
- SimTime range: 20ms–1,200ms

## 13.14 Known Limitations / Caveats (Must Disclose in Paper)

| Limitation | Detail |
|---|---|
| HARDWARE_BENCH_TESTING=1 | Stage 2 (EC-06/07/08) disabled during HIL tests. Sensor fault cases not tested by Pipeline A. Author confirms manual hardware verification. |
| Sensor fault tests absent | Pipeline A has no test cases for EC-06, EC-07, EC-08 in the 343-case suite. |
| No frequency deviation tests | All scenarios are voltage magnitude faults. 50Hz frequency drift not tested. |
| No phase / THD tests | Single-phase magnitude only. Harmonic content and THD not characterized. |
| No live mains testing | All HIL uses software-simulated waveforms injected over serial. No real mains. |
| FailureReason column all NaN | float64 column never populated — forensic review of future failures requires code fix. |
| 100ms boundary line in chart | The visualization uses 100ms as "catastrophic limit boundary" — this is not an IEC standard limit, it is a visual marker only. |

---

# PART 14 — TIMING & TASK CONSTANTS (ALL CONFIRMED)

| Parameter | Value | Description |
|---|---|---|
| SENSOR_LOOP_MS | 10 ms | Protection task period (100 Hz) |
| COMMS_LOOP_MS | 50 ms | Comms task period (20 Hz) |
| HEALTH_LOOP_MS | 10,000 ms | Health monitor period |
| TEMP_READ_INTERVAL_MS | 2,000 ms | DS18B20 read interval (0.5 Hz) |
| MQTT_PUB_INTERVAL_MS | 5,000 ms | MQTT telemetry publish interval |
| WS_PUSH_INTERVAL_MS | 1,000 ms | WebSocket push interval |
| WDT_TIMEOUT_S | 30 s | Hardware watchdog |
| SIL physics steps/tick | 100 iterations | at dt=100µs per step |
| OLED_PAGE_FLIP_MS | 4,000 ms | OLED page switch interval |
| EVENT_LOG_CAPACITY | 50 entries | NVS ring buffer |

---

# PART 15 — CONTRADICTIONS & STATUS

| ID | Description | Status |
|---|---|---|
| D1 | Current saturation (EC-06): §2.9 says low-rail (raw_i≤5) does NOT trigger saturation. Stage 2 code says it DOES (both rails). Which is correct? | ⚠ UNRESOLVED — Author to confirm |
| D2 | RECOVERY→NORMAL: 500ms settle timer and 500ms voltage confirmation window — sequential (1s total) or concurrent (500ms total)? | ⚠ UNRESOLVED — Author to confirm |
| D3 | IDMT constants in test generator vs firmware config — same values? | ✅ RESOLVED — K=0.140, α=0.020, TMS=0.10 confirmed identical in config.h |
| D4 | DOB blocking of API override — explicit guard in relay_control.cpp or FSM-level enforcement only? | ⚠ UNRESOLVED — Author to confirm |
| D5 | EC-08 untestable in SIL mode (SIL scales i_new when v_new<5V, preventing the condition) | ✅ RESOLVED (moot) — HARDWARE_BENCH_TESTING=1 disables Stage 2 entirely; EC-08 verified by author on hardware |

---

# PART 16 — EDGE CASES (from config.h — all 15 documented)

| EC | Name | Mechanism | Resolution |
|---|---|---|---|
| EC-01 | Motor/compressor inrush | 5–8× rated, 500ms–3s | T_START_MAX=8s blank window + slope-gated SC |
| EC-02 | SMPS capacitive inrush | 20–40×, 1–10ms | SC_INSTANT bypass (>27A always trips, inrush decays <10ms) |
| EC-03 | Resistive load cold inrush | 10–15×, 50ms | Covered by T_START_MAX + inrush window |
| EC-04 | DS18B20 +85°C boot sentinel | Default scratchpad value at power-on | Ignore for DS18B20_BOOT_IGNORE_MS=2000ms |
| EC-05 | DS18B20 -127°C disconnect | 1-Wire bus fault | 3× debounce → LOCKOUT |
| EC-06 | ADC saturation | Wire break / op-amp rail short | 50ms saturation window → FAULT_BIT_SENSOR → LOCKOUT |
| EC-07 | ADC frozen (zero variance) | ADC mux hang / IC lockup | Variance=0 in 20 samples → FAULT_BIT_SENSOR |
| EC-08 | Physics impossibility | I>2A with V<5V | Cross-channel sanity → FAULT_BIT_SENSOR → LOCKOUT |
| EC-09 | Motor-induced UV sag | Motor draws 8× rated, depresses local V | UV detection suppressed during 1000ms inrush blank |
| EC-10 | OV instantaneous >270V | MOV protection zone | Zero-debounce trip (FAULT_DEBOUNCE_INSTANT=2) |
| EC-11 | SC bypasses inrush blank | Genuine SC during startup | Slope logic: SC trip if current RISING (≥10 A/s) during startup |
| EC-12 | Thermal fault → LOCKOUT | Fire risk | Direct LOCKOUT, no auto-reclose |
| EC-13 | SC → LOCKOUT | Wiring damage possible | Lockout class, manual reset only |
| EC-14 | Voltage hysteresis bands | Chattering at threshold | 8V OV band (245–253V), 8V UV band (207–215V) — EN 50160 guidance |
| EC-15 | IDMT thermal memory | Accumulator decay below pickup | IDMT_ACCUMULATOR_DECAY=0.995 per tick |

---

# PART 17 — PAPER-READY CLAIMS (CONFIRMED, SOURCED)

## Ready to Write (High Confidence)

1. **IDMT curve compliance:** All 11 test cases (21.5A–26.5A) verified against IEC 60255 Standard Inverse formula with ≤0.42% error, well within ±30% compliance window.

2. **SC response time:** Instantaneous trip at ≥27A in 20–90ms across all test cases. At threshold (27A): 90ms. Above threshold: 20ms.

3. **UV/OV instant response:** 20ms for UV_INSTANT (≤150V), 20ms for OV_INSTANT (≥270V) — FAULT_DEBOUNCE_INSTANT=2 ticks × 10ms.

4. **Motor inrush immunity:** 30/30 correct no-trip cases during motor startup at voltages ≥160V. 24/24 correct trip cases after inrush window expiry.

5. **Noise immunity:** 57/57 correct no-trip cases within normal operating band.

6. **Boundary compliance:** Both UV_FAULT_EXACT (207V) and OV_FAULT_EXACT (253V) produce TRIP; one volt inside boundary produces NO_TRIP.

7. **IDMT accumulator accuracy:** Discrete integration with 10ms tick produces trip times within 0.5% of continuous-formula value across all tested currents.

8. **Two independent test runs:** Hardware confirmed by CPUTime_ms variation across 342/343 rows and SimTime_ms variation in 6 rows between runs.

9. **Real-time performance:** Max per-tick CPU load ~0.05ms against 10ms loop deadline (0.5% utilization). No deadline violations observed.

10. **DS18B20 boot sentinel:** 2,000ms ignore window prevents false thermal trips at +85°C power-on default.

## Cannot Claim Without Further Evidence

1. EC-06/07/08 sensor fault validation via automated HIL (HARDWARE_BENCH_TESTING=1 disabled these)
2. IEC 61000-4-15 flicker compliance (simulated, not tested against standard)
3. IS 12360 / CEA 2005 lab-certified compliance (design-intent, not lab-verified)
4. ZMPT101B calibration accuracy (polynomial constants empirical, procedure not documented)
5. WiFi/MQTT latency characterization (no measurements in any file)
6. Power consumption data (not measured anywhere)
7. Flash/RAM footprint (build output not provided)

---

# PART 18 — ITEMS STILL NEEDED (OPEN CHECKLIST)

| # | Item | Priority | Where To Get |
|---|---|---|---|
| 1 | D1 confirmation: current saturation low-rail behavior | HIGH | Author judgment / relay_control.cpp |
| 2 | D2 confirmation: settle timer vs confirmation window timing | HIGH | fsm.cpp logic |
| 3 | D4 confirmation: DOB API override enforcement | MEDIUM | relay_control.cpp |
| 4 | Core pinning (which tasks on Core 0 vs Core 1) | MEDIUM | main.cpp — xTaskCreatePinnedToCore() |
| 5 | Seqlock algorithm | LOW | main.cpp shared state section |
| 6 | Build output: flash+RAM usage | LOW | Arduino IDE / platformio build log |
| 7 | Firmware version string | LOW | main.cpp or VERSION define |
| 8 | ESP32 chip revision | LOW | esptool or Serial boot log |

