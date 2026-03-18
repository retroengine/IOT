# CODE.md — Smart Grid Sentinel Technical Reference
## Calculations, Thresholds, Protection Logic, Health Scoring

---

## 1. Sensor Signal Chain

### 1.1 ADC Oversampling

The ESP32 ADC is 12-bit (0–4095) but has significant nonlinearity and noise. To improve effective resolution, 4× oversampling is applied.

```cpp
// config.h
#define ADC_OVERSAMPLE   4        // 4 samples averaged → +1 ENOB
#define ADC_MAX_RAW      4095.0f

// adc_sampler.cpp — oversample loop
int32_t sum = 0;
for (int k = 0; k < ADC_OVERSAMPLE; k++) {
    sum += analogRead(pin);
}
int raw = sum / ADC_OVERSAMPLE;
```

At 4× oversampling with 12-bit ADC, effective noise bits ≈ 12.5 bits. The averaging also suppresses single-sample spikes from ESP32 ADC DNL errors.

### 1.2 Voltage Reconstruction

```cpp
// Sensor: ZMPT101B — stepped-down AC mapped to 0–3.3V → ADC range
// Full scale: 300V maps to ADC 4095

#define VOLTAGE_FULL_SCALE  300.0f   // V — ADC upper rail = 300V

float voltage_v = (raw / ADC_MAX_RAW) * VOLTAGE_FULL_SCALE;
// Example: raw=3140 → (3140/4095) × 300 = 230.2V
```

### 1.3 Current Reconstruction

```cpp
// Sensor: SCT-013-030 (0–30A → 0–1V output) or ACS758-30AB
// Full scale: 30A maps to ADC 4095

#define CURRENT_FULL_SCALE  30.0f    // A

float current_a = (raw / ADC_MAX_RAW) * CURRENT_FULL_SCALE;
// Example: raw=1638 → (1638/4095) × 30 = 12.0A
```

### 1.4 IIR Low-Pass Filter

Applied to smooth sensor readings without introducing significant lag.

```cpp
// config.h
#define IIR_ALPHA_VOLTAGE  0.2f   // heavier smoothing — grid voltages change slowly
#define IIR_ALPHA_CURRENT  0.3f   // lighter smoothing — current can spike fast

// IIR formula: output = α × new_sample + (1-α) × previous_output
filtered_v = IIR_ALPHA_VOLTAGE * raw_v + (1.0f - IIR_ALPHA_VOLTAGE) * filtered_v;
filtered_i = IIR_ALPHA_CURRENT * raw_i + (1.0f - IIR_ALPHA_CURRENT) * filtered_i;
```

Why α=0.2 for voltage: a step change in voltage reaches 99% of new value in ~22 samples = 220ms at 100Hz. Fast enough to catch real faults, slow enough to reject 50Hz ripple noise.

Why α=0.3 for current: slightly faster response because overcurrent faults need to be detected within a few hundred milliseconds per IEC 60255.

### 1.5 Moving Average (Final Display Smoothing)

After IIR, a 10-sample moving average is applied for the display value only. The fault engine uses the IIR-filtered value directly — not the moving average — to preserve fault detection speed.

```cpp
#define MOVING_AVG_DEPTH  10

// Ring buffer of last 10 samples
sum -= window[head];
window[head] = iir_filtered;
sum += window[head];
head = (head + 1) % MOVING_AVG_DEPTH;
display_value = sum / MOVING_AVG_DEPTH;
```

### 1.6 Current Deadband

Noise suppression at idle. Below 0.1A the current is forced to 0.00A.

```cpp
#define CURR_DEADBAND_A  0.10f   // 30A scale: 0.33% of full scale

if (current_a < CURR_DEADBAND_A) current_a = 0.0f;
```

---

## 2. Temperature Measurement (DS18B20)

### 2.1 Resolution and Timing

```
Resolution: 12-bit → 0.0625°C per LSB
Conversion time: 750ms maximum
Sample interval: 2000ms (0.5Hz)
Method: non-blocking (requestTemperatures → wait 800ms → read)
```

### 2.2 Boot Sentinel Filter (EC-04)

DS18B20 scratchpad initialises to exactly +85.0°C on power-up. Any reading of 85.0°C within 2 seconds of init() is silently discarded — it is not a real temperature.

```cpp
#define DS18B20_BOOT_IGNORE_MS  2000
#define DS18B20_SENTINEL_HOT    85.0f

if (!boot_window_done && fabsf(t - DS18B20_SENTINEL_HOT) < 0.1f) {
    // discard — boot sentinel
    return;
}
```

### 2.3 Disconnect Detection (EC-05)

DallasTemperature returns -127.0°C when sensor is physically disconnected or bus is shorted. Three consecutive -127.0°C readings trigger LOCKOUT.

```cpp
#define DS18B20_SENTINEL_DISC  -127.0f
#define DISC_DEBOUNCE_N         3      // 3 × 800ms = 2.4s before declaring disconnected

if (t <= DS18B20_SENTINEL_DISC + 1.0f) {
    disc_debounce_count++;
    if (disc_debounce_count >= DISC_DEBOUNCE_N) {
        sensor_disconnected = true;   // FSM will enter LOCKOUT
    }
}
```

Why debounce: a single marginal contact or 1-Wire bus glitch can produce one spurious -127.0°C reading. Three consecutive readings is unambiguous.

---

## 3. Power Calculations

### 3.1 Apparent Power

```cpp
float apparent_power_va = voltage_v * current_a;
// Example: 230.5V × 12.3A = 2835 VA
```

### 3.2 Power Factor

The firmware uses an estimated fixed power factor of 0.85 (typical Indian residential load mix). True PF requires AC waveform sampling with phase measurement which the current ADC setup cannot do accurately.

```cpp
#define POWER_FACTOR_ESTIMATED  0.85f

float real_power_w = apparent_power_va * POWER_FACTOR_ESTIMATED;
// Example: 2835 × 0.85 = 2409W
```

### 3.3 Energy Integration (Trapezoidal Rule)

```cpp
// Called every telemetry build cycle
void updateEnergy(float power_w) {
    uint32_t now = millis();
    if (s_last_energy_ts > 0) {
        float dt_h = (now - s_last_energy_ts) / 3600000.0f;  // ms → hours
        // Trapezoidal: average of current and previous power × time
        s_energy_wh += ((power_w + s_last_power_w) * 0.5f) * dt_h;
    }
    s_last_power_w   = power_w;
    s_last_energy_ts = now;
}
```

Trapezoidal integration is used (not simple rectangular) because it halves the integration error for linearly changing power loads.

---

## 4. Voltage Protection Thresholds (IS 12360 / CEA 2005)

### 4.1 Zone Diagram

```
  0    150   170   207   216  218.5  230  241.5  243   253   270   300V
  |     |     |     |     |     |     |     |     |     |     |     |
  |VOID |     |UV_I |UV_F |UV_W |RA_L | NOM |RA_H |OV_W |OV_F |OV_I |RAIL
```

| Zone | Threshold | Standard | Action |
|---|---|---|---|
| UV Instant | < 150V | Supply collapse | FAULT, zero debounce |
| UV Fault | < 207V | IS 12360 -10% | FAULT after debounce |
| UV Warning | < 216V | CEA -6% | WARNING |
| Range A Lo | 218.5V | 230V × 0.95 | Recovery confirmation lower bound |
| Nominal | 230V | IS 12360 | — |
| Range A Hi | 241.5V | 230V × 1.05 | Recovery confirmation upper bound |
| OV Warning | > 243V | CEA +6% | WARNING |
| OV Fault | > 253V | IS 12360 +10% | FAULT after debounce |
| OV Instant | > 270V | MOV MCOV 275V | FAULT, zero debounce |

### 4.2 Hysteresis Bands

Prevents relay chattering at threshold boundaries.

```cpp
// Overvoltage — fault clears only when V drops below 245V (not 253V)
#define VOLT_OV_FAULT_HYST_V   245.0f   // 8V band below fault threshold
#define VOLT_OV_WARN_HYST_V    240.0f

// Undervoltage — fault clears only when V rises above 215V (not 207V)
#define VOLT_UV_FAULT_HYST_V   215.0f   // 8V band above fault threshold
#define VOLT_UV_WARN_HYST_V    220.0f
```

### 4.3 Recovery Validation

Before the relay re-closes after a fault, voltage must hold inside Range A (218.5V–241.5V) for 500ms continuously.

```cpp
#define VOLT_RECOVERY_LO_V       218.5f
#define VOLT_RECOVERY_HI_V       241.5f  // corrected to 230×1.05
#define VOLT_RECOVERY_CONFIRM_N  50       // 50 × 10ms = 500ms

// In fsm.cpp — recovery confirmation counter
if (v >= VOLT_RECOVERY_LO_V && v <= VOLT_RECOVERY_HI_V) {
    recovery_confirm_count++;
    if (recovery_confirm_count >= VOLT_RECOVERY_CONFIRM_N) {
        // relay re-closes
    }
} else {
    recovery_confirm_count = 0;  // reset if voltage leaves the band
}
```

---

## 5. Current Protection (IEC 60255 IDMT)

### 5.1 Thresholds

```cpp
#define RATED_CURRENT_A    16.0f   // IS 8828 16A MCB rated
#define CURR_OC_WARN_A     18.0f   // 112% rated — WARNING
#define CURR_OC_FAULT_A    21.0f   // 131% rated — IDMT trip zone
#define CURR_SC_INSTANT_A  27.0f   // 169% — short circuit, instant trip
```

### 5.2 IDMT Formula (IEC Standard Inverse Curve)

```
t(I) = TMS × k / ((I/Is)^α - 1)

Where:
  k     = 0.140  (IEC Standard Inverse constant)
  α     = 0.020  (IEC Standard Inverse exponent)
  TMS   = 0.10   (Time Multiplier Setting — tuned for 16A household)
  Is    = 21.0A  (pickup current = CURR_OC_FAULT_A)
  I     = measured current
  t     = trip time in seconds
```

```cpp
#define IDMT_K      0.140f
#define IDMT_ALPHA  0.020f
#define IDMT_TMS    0.10f
#define IDMT_IS     CURR_OC_FAULT_A   // 21.0A

float ratio = current_a / IDMT_IS;
if (ratio > 1.0f) {
    float trip_time_s = IDMT_TMS * IDMT_K / (powf(ratio, IDMT_ALPHA) - 1.0f);
    // accumulator increments by loop_period / trip_time each tick
    idmt_accumulator += (SENSOR_LOOP_MS / 1000.0f) / trip_time_s;
}
```

**Trip time examples at TMS=0.10, Is=21A:**

| Current | Multiple of Is | Trip time |
|---|---|---|
| 22A | 1.05× | ~15 seconds |
| 25A | 1.19× | ~4 seconds |
| 27A+ | SC threshold | Instant (bypasses IDMT) |

### 5.3 IDMT Accumulator

```cpp
// Accumulator reaches 1.0 → trip
// Decays at 0.5%/tick when below pickup (thermal memory per EC-15)
#define IDMT_ACCUMULATOR_DECAY  0.995f

if (current_a < IDMT_IS) {
    idmt_accumulator *= IDMT_ACCUMULATOR_DECAY;  // slow decay
} else {
    // increment as above
}

if (idmt_accumulator >= 1.0f) {
    // FAULT — overcurrent trip
}
```

Thermal memory means a motor that ran at 110% for 30s cannot immediately restart at 110% — the accumulator retains partial charge, so the second trip comes faster. This matches real MCB behavior.

### 5.4 Short Circuit (Instant, ANSI 50)

```cpp
// SC bypasses IDMT accumulator AND inrush blank window
if (current_a >= CURR_SC_INSTANT_A) {
    if (sc_debounce >= FAULT_DEBOUNCE_INSTANT) {  // 2 samples = 20ms
        // immediate FAULT → LOCKOUT (no auto-reclose for SC)
    }
}
```

---

## 6. Temperature Protection

```cpp
#define TEMP_WARN_C        70.0f   // WARNING — shed auxiliary load
#define TEMP_FAULT_C       85.0f   // FAULT → LOCKOUT (capacitor rated limit)
#define TEMP_RESET_BLOCK_C 60.0f   // manual reset blocked above this

// Thermal fault goes directly to LOCKOUT — no auto-reclose
// Rationale: 85°C = electrolytic capacitor rated limit.
// Continuing to energise above this risks capacitor venting or fire.
// Physical inspection required before re-energisation.
```

---

## 7. Inrush Blanking

Motors, compressors, and pumps draw 5–10× rated current for 0.5–3 seconds on startup. Without blanking, every motor start would trip the protection.

```cpp
#define INRUSH_BLANK_MS       3500   // OC fault + UV suppressed for 3.5s after relay close
#define INRUSH_BLANK_WARN_MS  1000   // OC warning + UV warning suppressed for 1s

// Applied in fault_engine.cpp — armed by RelayControl::notifyRelayClosed()
// What is NEVER blanked (per EC-11):
//   CURR_SC_INSTANT (>27A) — always trips instantly
//   VOLT_OV_INSTANT (>270V) — always trips instantly
//   VOLT_UV_INSTANT (<150V) — always trips instantly
```

**Why 3500ms:** Worst case Indian load — water pump / submersible pump with fractional HP motor. Inrush can last up to 3 seconds. 3500ms provides 500ms margin.

---

## 8. Fault Priority Bitmask

Multiple simultaneous faults are tracked via bitmask. The highest-priority active bit determines FSM action.

```cpp
// config.h — priority order
#define FAULT_BIT_SENSOR     0x0001U   // P1 — sensor hardware failure
#define FAULT_BIT_SC         0x0002U   // P2 — short circuit ANSI 50
#define FAULT_BIT_OV_INSTANT 0x0004U   // P3 — severe OV >270V
#define FAULT_BIT_THERMAL    0x0008U   // P4 — thermal limit
#define FAULT_BIT_OV         0x0010U   // P5 — sustained OV
#define FAULT_BIT_OC_IDMT    0x0020U   // P6 — IDMT overcurrent
#define FAULT_BIT_UV         0x0040U   // P7 — undervoltage
```

Example: stalled motor draws high current AND causes voltage sag → both `FAULT_BIT_OC_IDMT` and `FAULT_BIT_UV` are set. The dashboard can display both simultaneously.

---

## 9. FSM (Finite State Machine)

### 9.1 States

| State | Meaning | Relay | LED | Buzzer |
|---|---|---|---|---|
| BOOT | Initialising | OPEN | OFF | Silent |
| NORMAL | All parameters OK | CLOSED | OFF | Silent |
| WARNING | Parameter approaching limit | CLOSED (R1), OPEN (R2) | 1Hz blink | 50ms beep / 450ms |
| FAULT | Protection tripped | OPEN (both) | 4Hz blink | 200ms / 200ms |
| RECOVERY | Reclose sequence | CLOSED (after validation) | OFF | Silent |
| LOCKOUT | Max trips reached | OPEN (both) | Solid | 500Hz continuous |

### 9.2 State Transitions

```
BOOT → NORMAL          : sensors ready, voltage in range, no fault bits set
NORMAL → WARNING        : any warn flag set (OV/UV/OC/thermal)
NORMAL → FAULT          : any fault bit set above priority threshold
WARNING → FAULT         : warn condition exceeds fault threshold
WARNING → NORMAL        : all warn flags cleared
FAULT → RECOVERY        : auto-reclose delay expired (5s/15s/30s escalating)
RECOVERY → NORMAL       : voltage holds Range A for 500ms, relay closes
RECOVERY → FAULT        : fault bit set again during recovery attempt
FAULT → LOCKOUT         : trip_count >= 3, OR thermal/SC/sensor fault
ANY → LOCKOUT           : DS18B20 disconnected (EC-05), ADC frozen (EC-07)
LOCKOUT → RECOVERY      : manual API reset (only if temp < 60°C and no SENSOR_FAIL)
```

### 9.3 Auto-Reclose Dead Times (Escalating)

```cpp
#define RECLOSE_DELAY_1_MS  5000    // Trip 1: 5 second wait
#define RECLOSE_DELAY_2_MS  15000   // Trip 2: 15 second wait
#define RECLOSE_DELAY_3_MS  30000   // Trip 3: 30 second wait → then LOCKOUT
#define MAX_TRIP_COUNT      3
```

---

## 10. Sensor Diagnostics Calculations

### 10.1 Voltage Stability Score

```cpp
// Maintain sliding window of N samples, compute variance
float variance_v = computeVariance(v_window, WINDOW_SIZE);
float sigma_v    = sqrtf(variance_v);

// Map σ → score: 0V noise = 100, 0.5V noise = 0
float stability_score_v = constrain(100.0f - (sigma_v / 0.5f) * 100.0f, 0.0f, 100.0f);
```

### 10.2 Current Stability Score

```cpp
float sigma_i = sqrtf(computeVariance(i_window, WINDOW_SIZE));

// Map σ → score: 0A noise = 100, 0.05A noise = 0
float stability_score_i = constrain(100.0f - (sigma_i / 0.05f) * 100.0f, 0.0f, 100.0f);
```

### 10.3 Temperature Stability Score

```cpp
float sigma_t = sqrtf(computeVariance(t_window, WINDOW_SIZE));

// Map σ → score: 0°C noise = 100, 0.5°C noise = 0
float stability_score_t = constrain(100.0f - (sigma_t / 0.5f) * 100.0f, 0.0f, 100.0f);
```

### 10.4 SNR (Signal-to-Noise Ratio)

```cpp
// SNR in dB: how much bigger the signal is compared to its noise floor
float snr_db_v = 20.0f * log10f(mean_v / (sigma_v + 0.001f));
// +0.001 prevents log(0). Typical good value: >40dB
```

### 10.5 ADC Health Score

```cpp
// Composite: 70% from voltage stability, 30% from saturation absence
float adc_health = (stability_score_v * 0.7f) + (saturation_events == 0 ? 30.0f : 10.0f);
adc_health = constrain(adc_health, 0.0f, 100.0f);

// Calibration label thresholds:
// adc_health >= 85 → "CALIBRATED (2-POINT)"
// adc_health >= 65 → "CALIBRATED (EFUSE_VREF)"
// adc_health <  65 → "NOT CALIBRATED"
```

### 10.6 Overall System Health Score

```cpp
// Weighted composite of all subsystem scores
float overall = (stability_score_v * 0.25f) +   // voltage channel
                (stability_score_i * 0.25f) +   // current channel
                (stability_score_t * 0.20f) +   // temperature channel
                (adc_health        * 0.20f) +   // ADC quality
                (heap_score        * 0.10f);    // memory health

// heap_score: (free_heap / 320000) × 100, clamped 0–100
float heap_score = constrain((free_heap / 320000.0f) * 100.0f, 0.0f, 100.0f);
```

### 10.7 Power Quality Label

| Condition | Label |
|---|---|
| Voltage deviation < 2% AND PF > 0.9 | `"GOOD"` |
| Voltage deviation < 5% OR PF > 0.8 | `"FAIR"` |
| Voltage deviation ≥ 5% OR active fault | `"POOR"` |

---

## 11. Fault Probability Estimate

```cpp
// Simple state-based estimate — not ML
uint8_t fault_prob = 0;

if      (ctx.state == FSM_LOCKOUT || ctx.state == FSM_FAULT)       fault_prob = 95;
else if (ctx.state == FSM_WARNING && ctx.trip_count >= 2)          fault_prob = 75;
else if (ctx.state == FSM_WARNING)                                 fault_prob = 45;
else if (ctx.warn_flags & WARN_CURR_RISING)                        fault_prob = 25;
else if (ctx.warn_flags != WARN_NONE)                              fault_prob = 15;
else                                                               fault_prob = 5;
```

---

## 12. Relay Control Logic

### 12.1 Active-LOW Relay Convention

```
GPIO HIGH = relay coil de-energised = contacts OPEN  = load DISCONNECTED = SAFE
GPIO LOW  = relay coil energised    = contacts CLOSED = load CONNECTED
```

The GPIO is pre-set HIGH before `pinMode(OUTPUT)` to prevent the brief LOW glitch during ESP32 boot that would close the relay momentarily.

### 12.2 Load Shedding by State

| FSM State | Load 1 (Main) | Load 2 (Auxiliary) |
|---|---|---|
| NORMAL | CLOSED | CLOSED |
| WARNING | CLOSED | **OPEN** — shed aux first |
| RECOVERY | CLOSED | CLOSED |
| FAULT | OPEN | OPEN |
| LOCKOUT | OPEN | OPEN |
| BOOT | OPEN | OPEN |

### 12.3 API Override Safety Contract

```cpp
// setAPIOverride() from POST /api/relay
// Safety: FSM FAULT/LOCKOUT/BOOT always clears the override
// Operator cannot override a protection trip

if (api_override_active &&
    (state == FSM_NORMAL || state == FSM_WARNING)) {
    // apply override only in safe states
    want_r1 = api_override_state;
}
// FAULT/LOCKOUT/BOOT: api_override_active = false; — always cleared
```

---

## 13. Sensor Anomaly Detection

### EC-06: ADC Saturation

```cpp
#define SENSOR_SAT_WINDOW_MS  50   // 50ms continuous saturation = fault

// If ADC reads ≤5 or ≥4090 for 50ms → sensor hardware fault → LOCKOUT
// Causes: open wire (rail pull-up), op-amp rail short
```

### EC-07: Frozen Sensor

```cpp
#define SENSOR_FROZEN_N  20   // 20 consecutive identical samples

// If variance of last 20 samples == 0.0 exactly → frozen → LOCKOUT
// Causes: ADC multiplexer hang, SPI lockup, floating input
// Real AC mains always has ≥1–2 LSB thermal jitter
```

### EC-08: Physics Impossibility Cross-Check

```cpp
#define SENSOR_PHYSICS_I_MIN  2.0f   // if current > 2A
#define SENSOR_PHYSICS_V_MAX  5.0f   // and voltage < 5V simultaneously → impossible

// Current cannot flow without voltage on AC mains
// This combination means at least one sensor has failed
```

---

## 14. Debounce Configuration

```cpp
#define FAULT_DEBOUNCE_N        3   // 3 × 10ms = 30ms — normal load
#define FAULT_DEBOUNCE_HEAVY    5   // 5 × 10ms = 50ms — heavy load >12A
#define FAULT_DEBOUNCE_INSTANT  2   // 2 × 10ms = 20ms — OV>270V, UV<150V, SC>27A
#define WARN_DEBOUNCE_N         2   // warnings need less confirmation
#define WARN_DEBOUNCE_HEAVY     4
```

Why different debounce for heavy loads: at >12A (75% rated), the current sensor noise floor is proportionally higher. A spurious sample is more likely to cross the 21A fault threshold. 5 samples instead of 3 prevents nuisance trips during legitimate heavy load operation.

---

## 15. Telemetry Schema (schema_v: "1.3-local")

The firmware produces a verbose nested JSON structure. The dashboard's `telemetryParser.js` normalises all three input variants (verbose v1.3, canonical flat, short-key minified) into a single canonical object.

**Key paths consumed by dashboard:**

```
sensors.voltage.filtered_value        → canonical: v
sensors.current.filtered_value        → canonical: i
sensors.temperature.filtered_value    → canonical: t
power.real_power_w                    → canonical: p
power.apparent_power_va               → canonical: va
power.energy_estimate_wh              → canonical: e
power.power_factor                    → canonical: pf
power.frequency_hz                    → canonical: freq
alerts.fsm_state                      → canonical: state
loads.relay1.state                    → canonical: relay
diagnostics.system_health.overall_health_score → canonical: health
system.uptime_s                       → canonical: uptime
```

Full schema reference: see `dashboard.md` Section 11.

---

## 16. WebSocket Push Server (ws_server.cpp)

### Push Rate

```cpp
#define WS_PUSH_INTERVAL_MS  100   // 10Hz — matches protection task loop rate
```

### Thread Safety

`tick()` and `AsyncWebSocket` events both run on Core-1. No mutex needed for the WebSocket object itself. The `SensorReading` and `FSMContext` passed to `tick()` are already mutex-protected copies made by `task_comms`.

### Client Management

```cpp
// cleanupClients() removes stale connections
// Called every tick — prevents memory leak on long uptime
g_ws->cleanupClients();

// textAll() broadcasts to all open clients in one pass
// No per-client loop needed
g_ws->textAll(payload);
```

---

## 17. FreeRTOS Task Configuration

| Task | Core | Priority | Stack | Loop rate |
|---|---|---|---|---|
| task_protection | 0 | 5 (highest) | 4096 words | 10ms (100Hz) |
| task_comms | 1 | 3 | 6144 words | 50ms (20Hz) |
| task_health | 1 | 1 (lowest) | 2048 words | 10000ms (0.1Hz) |
| ESPAsyncWebServer | 1 | async events | — | event-driven |

Protection task runs at highest priority on Core 0 — no competition from network tasks. This guarantees <10ms fault detection latency regardless of WiFi/MQTT load.

### Watchdog

```cpp
#define WDT_TIMEOUT_S  10   // both tasks must pet watchdog within 10s
// If a task hangs, ESP32 reboots automatically
// Reboot reason logged to NVS for post-mortem diagnosis
```

---

## 18. NVS Event Log

50-entry ring buffer stored in ESP32 NVS flash. Survives reboots. Exposed via `GET /api/log`.

```cpp
#define EVENT_LOG_CAPACITY  50

struct EventEntry {
    uint32_t ts_ms;
    FSMState state;
    FaultType fault_type;
    float value;
    char note[16];
};
```

Events logged: BOOT (with reset reason), every FSM state transition, every fault trip, WiFi changes, API reboot requests.

---

## 19. Memory Budget

| Region | Size | Notes |
|---|---|---|
| ESP32 total SRAM | 320 KB | — |
| FreeRTOS + system | ~60 KB | OS overhead |
| task_protection stack | 16 KB | 4096 × 4 bytes |
| task_comms stack | 24 KB | 6144 × 4 bytes |
| task_health stack | 8 KB | 2048 × 4 bytes |
| Telemetry JSON buffer | 4 KB | `TELEMETRY_BUF_SIZE` static |
| ArduinoJson document | ~4 KB | heap, freed after serialize |
| WiFiClientSecure TLS | ~40 KB | heap during MQTT handshake |
| MQTT PubSubClient buffer | 4 KB | `mqtt.setBufferSize(4096)` |
| Free heap (nominal) | ~110 KB | heap_warn threshold: 20 KB |

`HEAP_WARN_BYTES = 20000` — health monitor logs a warning if free heap drops below 20 KB.
