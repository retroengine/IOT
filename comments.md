# Original Comments Archive — Smart Grid Sentinel

All verbose comments preserved before shortening. Organized by file.

---

## adc_sampler.cpp

### File Header (lines 1-29)
```
adc_sampler.cpp — v4.0
Potentiometer → 4× oversample → IIR → 10-window moving avg
Voltage:  GPIO34 ADC1_CH6  →  0–300 V
Current:  GPIO35 ADC1_CH7  →  0–30 A  (+ deadband)

CHANGES IN v4.0 (Tier 2 — Findings #6, #9, #20):

Finding #6 / #20 — Two independent signal paths:
  Protection path:  4× oversample + calibrate only → raw_v_phys / raw_i_phys
                    Exposed via getRawVoltagePhys() / getRawCurrentPhys()
                    FaultEngine receives this and owns its complete
                    signal chain (asymmetric IIR) from that point.
                    No cascade attenuation of fault spikes.
  Telemetry path:   raw_phys → IIR → 10-sample MA → v_filtered / i_filtered
                    Unchanged. Used for display and diagnostics only.

Finding #9 — Bessel's correction in bufferVariance():
  Changed denominator from count (population variance) to (count-1)
  (sample variance). For a 10-sample window this corrects a 10%
  systematic underestimate of signal noise. Guard added for count < 2.

CHANGES IN v3.0 (Tier 1 — Finding #1):
  Migrated from deprecated IDF v4 ADC API to IDF v5 Oneshot driver.

ALL OTHER SIGNAL PROCESSING UNCHANGED FROM v2.0:
  Noise floor tracking, min/max, saturation, sample rate,
  dual-EMA drift, IIR, rolling average, calibration.
```

### Atomic SIL Command Queue (line 43-44)
```
Definitions moved to phantom_grid.cpp; accessed via extern in phantom_grid.h
```

### Core filter state (line 51)
```
Core filter state (unchanged from v1.0)
```

### Protection signal path outputs (lines 67-72)
```
Protection signal path outputs (Finding #6 / #20)
4× oversampled + calibrated physical values, BEFORE any IIR or
moving average. FaultEngine consumes these as its input — its own
asymmetric IIR is then the single and only filter stage on the
protection signal path, eliminating the 4-stage cascade that was
attenuating 50ms short-circuit spikes to near noise.
```

### IDF v4 ADC calibration (lines 76-81)
```
IDF v4 ADC calibration
espressif32 @ 6.13.0 ships IDF v4. The v5 oneshot + cali_scheme API
does not exist. IDF v4 uses esp_adc_cal_characterize() (line fitting
against eFuse Vref or default 1100mV). One characteristics struct is
valid for the whole unit+attenuation combination — both channels share
ADC1 + ADC_ATTEN_DB_11, so a single struct covers both.
```

### Noise floor tracking (lines 88-90)
```
Noise floor tracking (exp. moving RMS of residuals)
Alpha controls how fast the noise estimate responds.
0.05 = responds in ~20 samples (~200ms at 100Hz) — appropriate.
```

### IDF v4 calibration setup (lines 135-138)
```
IDF v4 calibration setup
esp_adc_cal_characterize() probes eFuse for a two-point (TP) correction
first, then eFuse Vref, then falls back to the default 1100mV reference.
Returns calibration_quality: 2=eFuse TP, 1=eFuse Vref, 0=default Vref.
```

### IDF v4 oversampling (lines 158-160)
```
IDF v4 oversampling
Reads ADC_OVERSAMPLE raw samples via adc1_get_raw(), averages them,
then converts the mean to millivolts via esp_adc_cal_raw_to_voltage().
```

### BUG-08 FIX oversample (line 171)
```
BUG-08 FIX: divide by actual successful read count, not ADC_OVERSAMPLE.
```

### Polynomial and LUT Framework (lines 180-183)
```
Polynomial and LUT Framework (Finding #30: Industry ADC Accuracy)
To achieve sub-1% accuracy required for exact Indian grid limit tracking,
the system moves beyond ESP-IDF's simplistic 2-point line fit, which fails
at the SAR ADC non-linear rail zones.
```

### Signal processing helpers (line 251)
```
All signal processing helpers unchanged from v2.0
```

### bufferVariance (lines 266-270)
```
Compute sample variance from a rolling buffer.
Finding #9 fix: uses (count-1) denominator (Bessel's correction)
instead of count (population variance). For a 10-sample window this
corrects a 10% systematic underestimate (N/(N-1) = 10/9 = 1.11×).
Guard: returns 0 for count < 2 (insufficient samples for sample variance).
```

### updateNoiseFloor BUG-20 (lines 288-292)
```
BUG-20 FIX: parameters were named raw_v_phys / raw_i_phys, shadowing
the module-level variables of the same name. The function was correct
(it used the parameters, not the module vars) but -Wshadow would warn
and a future maintainer could confuse the two. Renamed to v_phys_in /
i_phys_in to make the data flow unambiguous.
```

### checkSaturation (lines 314-341)
```
Voltage channel: flag both low-rail (V=0 on live mains = sensor failure)
and high-rail (>300V clamped at ADC ceiling).

Current channel: raw=0 is normal no-load / CURR_DEADBAND condition.
Flagging low-rail as saturation causes false EC-06 triggers every time
the load is off (produces spurious [ADC] CURRENT SATURATION: raw=0 logs
and penalises SensorDiagnostics ADCHealth score for a healthy sensor).
True saturation for current is ONLY at the HIGH rail — ADC clipped
because instantaneous current exceeded CURRENT_FULL_SCALE.

Clear saturation flag once reading moves comfortably away from rail.
Increased hysteresis to 1000 to prevent floating pin 50Hz hum log spam.
```

### updateVariance BUG-4 (lines 411-416)
```
FIX Bug-4: use buf_idx (not buf_idx+1) for the warmup branch.
rollingAvg() writes to buf[buf_idx] then tick() increments buf_idx
BEFORE this function runs. During warmup buf_idx is already one past
the last-written slot, so (buf_idx+1) overestimates valid element
count by 1, pulling a zero-initialised element into the variance sum
and systematically underestimating variance for the first ~100ms.
```

### ADCSampler::init() step comments (lines 430-448)
```
1. Configure ADC1 width and both channels
   IDF v4: set bit-width once for the whole unit, then attenuation
   per channel. 11dB → 0–3.3V nominal input range.

2. Characterise for calibrated mV conversion

3. Init min/max to impossible values so first sample resets them

4. Initialize SIL Physics Engine (10kHz model)
```

### tick() SIL command processing (lines 508-510)
```
BUG-02/17 FIX: use clearAnomalies() instead of triggerSag(0,0).
triggerSag() clamps depth to [0.1, 0.9] via clampf(), so
triggerSag(0.0, 0.0) was creating a phantom 10% sag event.
```

### Boot phase override (lines 556-571)
```
Override for initial 1-minute 230V/5A boot phase

Boot phase is over. Remove base load but KEEP the software
simulator active so we don't fall back to floating physical pins!
(Use the Phantom Dashboard to send DISABLE_SIMULATION if you
 actually want to use real hardware ADCs/Potentiometers).
```

### 10kHz Virtual DSP (lines 583-605)
```
10kHz Virtual DSP True RMS Processor
Executes 100 physics iterations per RTOS tick!
dt = 100µs. 100 steps * 100µs = 10ms (exact half-cycle).

Mean-Square Root over exactly 1 half-cycle eliminates 2*omega AC ripple
flawlessly.

If voltage drops significantly, physical resistive loads drop current linearly.
Scale current down if V < SENSOR_PHYSICS_V_MAX so we don't falsely trip checkPhysicsImpossibility()
```

### Realistic Gaussian noise (lines 612-614)
```
Realistic Gaussian-like thermal noise (variance ~ 2.0 LSB^2)
Always applied, even during faults, because real ADCs always have thermal noise.
Summing 3 uniforms [-1, 0, 1] gives a bell curve distribution
```

### ADC rail clamping (lines 620-623)
```
Fast decay prevents rail saturation false-trips
checkSaturation() trips at <= 5 and >= 4090.
Clamping to [6, 4089] guarantees the simulation looks like a real
extremely high/low signal rather than a broken hardware op-amp.
```

### Filter teleport (lines 637-639)
```
FILTER TELEPORT
If we crossed a SIL_ACTIVE boundary in either direction, teleport the
internal state shock memory
```

### Finding #6/#20 store (lines 654-657)
```
Finding #6 / #20: store pre-IIR physical values
These are the protection signal path outputs. FaultEngine reads
getRawVoltagePhys() / getRawCurrentPhys() and applies its own
asymmetric IIR as the single filter. No cascade attenuation.
```

### Protection signal path getters (lines 730-733)
```
Protection signal path (Finding #6 / #20)
Physical values after 4× oversampling + calibration ONLY.
No IIR. No moving average. FaultEngine uses these as its input
so its asymmetric IIR is the single filter on the protection path.
```

---

## fault_engine.cpp

### File Header (lines 1-81)
```
fault_engine.cpp — Production Protection Engine
REVISION: 3.0 — Full Indian Grid / IS 12360 Compliance

ARCHITECTURE:

evaluate() is called every SENSOR_LOOP_MS (10ms) from the
Core-0 protection task. It processes voltage, current, and
temperature through a multi-stage pipeline:

Stage 1 — Signal pre-processing
  - 3-sample median on current (EMI / commutation spike rejection)
  - Asymmetric IIR: fast rise (α=0.90), slow fall (α=0.10)
    α_rise raised from 0.50 to 0.90 per Document 6 (IEC 60255-151):
    step-response proof shows 5A→30A fault gives 27.5A on first sample
    → SC trips at 20ms (2×10ms debounce) ≤ 30ms mandate.
  - Slope buffer update (5-sample linear regression for trend)

  Tier 2 fix — Finding #6 / #20 (signal path refactor):
  raw_i now receives ADCSampler::getRawCurrentPhys() — the value
  after 4× oversampling + IDF v5 calibration ONLY, with NO IIR
  and NO moving average applied by ADCSampler. The asymmetric IIR
  inside evaluate() (Stage 1 above) is therefore the SINGLE and
  ONLY filter stage on the protection signal path. This eliminates
  the 4-stage cascade (ADCSampler IIR → ADCSampler MA →
  FaultEngine asymIIR) that was attenuating 50ms SC spikes to
  near noise before the SC comparator could evaluate them.
  The shadow iir_i variable in both modules no longer exists —
  FaultEngine owns the complete signal chain from raw ADC to trip.

Stage 2 — Sensor hardware validation (HIGHEST PRIORITY)
  - ADC saturation detection (EC-06)
  - ADC frozen/stuck detection (EC-07)
  - Physics cross-channel sanity check (EC-08)
  → Any failure: FAULT_BIT_SENSOR set → triggers LOCKOUT

Stage 3 — Instantaneous fault detection (NO debounce / blanking)
  - Short circuit: I ≥ CURR_SC_INSTANT_A (EC-11)
    Inside inrush blank: only trips if slope is RISING (adaptive)
  - Severe overvoltage: V ≥ VOLT_OV_INSTANT_V (MOV protection)
  → FAULT_BIT_SC or FAULT_BIT_OV_INSTANT set

Stage 4 — Debounced sustained fault detection
  - Sustained OV: V ≥ VOLT_OV_FAULT_V for N consecutive samples
  - IDMT overcurrent: accumulator ≥ 1.0 (IEC 60255 Standard Inverse)
    Inside inrush blank: accumulator frozen at 0 (not incremented)
  - Thermal: T ≥ TEMP_FAULT_C for N consecutive samples
  - Sustained UV: V ≤ VOLT_UV_FAULT_V for N consecutive samples
    Inside inrush blank: UV fault suppressed (EC-09 motor-induced sag)
    UV_INSTANT (<150V) bypasses suppression always

Stage 5 — Warning detection
  - OV warn, UV warn, OC warn, thermal warn, current-rising slope
  - OC warn and UV warn suppressed during inrush blank window

Stage 6 — Hysteresis clear logic
  - Active faults are NOT cleared just because threshold is no
    longer exceeded. They clear only when the signal drops below
    the corresponding hysteresis dropout threshold.
  - This prevents relay chattering at threshold boundaries.

FAULT PRIORITY BITMASK (uint16_t):
  Multiple faults can be simultaneously active.
  getHighestPriorityFault() returns the FaultType of the
  highest-priority active bit for FSM state machine display.
  getActiveFaultBits() returns the full bitmask for logging.

EDGE CASES HANDLED:
  EC-06  ADC saturation → FAULT_BIT_SENSOR → LOCKOUT
  EC-07  Frozen ADC reading → FAULT_BIT_SENSOR → LOCKOUT
  EC-08  Physics impossibility → FAULT_BIT_SENSOR → LOCKOUT
  EC-09  Motor UV sag during inrush → suppressed
  EC-10  OV >270V → zero-debounce FAULT_BIT_OV_INSTANT
  EC-11  SC >27A → bypasses inrush blank (slope check)
  EC-12  Thermal → FAULT_BIT_THERMAL (FSM routes to LOCKOUT)
  EC-13  SC → FAULT_BIT_SC (FSM routes to LOCKOUT, no reclose)
  EC-14  All threshold hysteresis bands (prevents chattering)
  EC-15  IDMT accumulator decays slowly below pickup (thermal memory)
  EC-01  Motor inrush: 3500ms blank window protects against nuisance
  EC-02  SMPS inrush: SC slope detection catches genuine SC in <30ms
  EC-03  Resistive cold inrush: covered by 3500ms blank window
```

### BUG-01 FIX cnt_ov_instant (lines 94-101)
```
BUG-01 FIX: Previously shared cnt_ov between Stage 3 (OV_INSTANT) and Stage 4
(sustained OV). When voltage is in [VOLT_OV_FAULT_V, VOLT_OV_INSTANT_V),
Stage 3's debounce() resets cnt_ov to 0 each tick (condition false), then
Stage 4 increments it to 1. The counter bounces between 0 and 1 indefinitely
— Stage 4 can never accumulate enough counts to reach fault_thresh. This is
the identical bug that was already fixed for UV (cnt_uv_instant). Mirroring
that fix here restores sustained OV protection (IS 12360 +10% = 253V zone),
which was completely non-functional.
```

### BUG FIX cnt_uv_instant (lines 104-110)
```
BUG FIX: Previously shared cnt_uv between Stage 3 (UV_INSTANT) and Stage 4
(sustained UV). Because both debounce() calls increment the same counter in
a single evaluate() call, Stage 4 can reach its threshold (fault_thresh)
before Stage 3 reaches FAULT_DEBOUNCE_INSTANT, causing Stage 4's log message
to print for what is actually a UV_INSTANT condition and preventing the
instant path from correctly attributing ANSI 27 vs near-collapse. Separate
counters fix this.
```

### Frozen sensor tracking EC-07 (lines 173-193)
```
Frozen sensor tracking (EC-07)
Track last N RAW ADC integer values (not IIR-smoothed physical values).
Raw ADC always has ≥1 LSB quantisation noise on a live signal (variance
typically 2–15 LSB²). A genuinely stuck ADC returns a constant integer
→ variance exactly 0. IIR-smoothed values are unsuitable here because
the slow-fall IIR (α=0.10) collapses variance to near-zero even on a
healthy sensor, causing 100% false-positive rate. Fixed: EC-07 rev1.

EC-07 rev2: current channel gets a consecutive-window debounce.
A no-load CT legitimately reads 0A (raw_i constant, var_i=0) until the
relay closes and load current flows. A hard-seized ADC stays frozen
across ALL windows permanently. Requiring FROZEN_I_CONSEC consecutive
full windows of zero-variance (~2 s) eliminates false positives at
idle/boot while still catching a locked ADC multiplexer.
```

### med_idx bug fix (lines 152-156)
```
FIX Bug-1: was uint8_t — wraps 255→0 making med_ready=(0≥3)=false
every 256 calls (~2.56s at 100Hz), bypassing the 3-sample EMI
median and exposing the asymmetric IIR to a raw spike.
uint32_t: overflows only after ~497 days at 100Hz — safe.
```

### currentSlope Finding #7 (lines 231-251)
```
Finding #7 fix: divide by total time window in seconds, not by
sample count. Previous code divided by SLOPE_N (a dimensionless
count), producing a result in Amps, not A/s. This caused the
WARN_CURR_RISING threshold (0.05f) to fire 20× too aggressively
because 0.05A over 5 samples was compared against what should
have been 0.05 A/s.

Correct formula: (newest - oldest) / (SLOPE_N * SENSOR_LOOP_MS / 1000.0f)
At SLOPE_N=5, SENSOR_LOOP_MS=10ms: window = 50ms = 0.05s
A change of 1A over 5 samples → slope = 1.0 / 0.05 = 20 A/s

BUG-01 FIX: After the write+advance in evaluate(), slope_idx points to
the NEXT slot to write — i.e. the OLDEST sample in the circular buffer.
The NEWEST sample is at (slope_idx + SLOPE_N - 1) % SLOPE_N.
The previous code computed (oldest - second_oldest) which was near-zero
or inverted, making genuinely rising currents evaluate to a negative
slope and breaking SC slope detection during inrush blanking.
```

### IDMT accumulator (lines 404-418)
```
STAGE 3: IDMT ACCUMULATOR (IEC 60255 Standard Inverse)

Formula: t(I) = TMS × k / ((I/Is)^α - 1)
Accumulator increments by SENSOR_LOOP_MS / t(I) each tick.
Trips when accumulator >= 1.0.

Thermal memory (EC-15): accumulator decays at IDMT_ACCUMULATOR_DECAY
per tick below pickup. This means a sustained overload that cleared
before tripping still has a "memory" — next overload trips faster.
This correctly models wire insulation thermal stress accumulation.

Reset: accumulator resets to 0 when relay opens (clearLatched()).
This models thermal cooling when the load is removed.
```

### tickIDMT BUG-06 (lines 422-429)
```
BUG-06 FIX: previously this zeroed idmt_accumulator, destroying any
thermal memory built up before relay reclose. If a load had accumulated
0.8 on a previous overload, the 3500ms blank window on relay close was
wiping that history. The accumulator is only legitimately reset when the
relay opens (notifyRelayClosed / clearLatched), modelling thermal cooling
when the load is removed. During a blank window the load is energised and
the wire is still warm — thermal state must be preserved.
```

### Hysteresis helpers (lines 469-478)
```
HYSTERESIS HELPERS

Each fault has a PICKUP threshold (where it sets) and a DROPOUT
threshold (where it clears). The fault remains active between
pickup and dropout to prevent relay chattering at the boundary.

Example OV: sets at 253V, clears at 245V.
If voltage hovers at 252V, fault stays active until 244V is reached.
```

### Load State Machine BUG-13 (lines 703-708)
```
BUG-13 FIX: Set startup_active on the transition tick itself.
Previously startup_active was only set inside the LOAD_STATE_STARTING
case on the NEXT tick. The first massive inrush sample therefore ran
through tickIDMT() with blank_active=false, slamming the IDMT
accumulator with the full LRA current and potentially causing a
nuisance IDMT trip before the blank window could protect it.
```

### UV_INSTANT mute window (lines 789-799)
```
UV_INSTANT <150V — near supply collapse, LOCKOUT condition (EC-09 exception)
ARCHITECTURAL FIX: Mute UV checking during the first 1000ms of boot.
The ADC's internal IIR filter starts at 0.0V and takes ~1 second to
mathematically converge up to the real 230V mains reading. Evaluating UV
during this natural 0V->230V mathematical ramp was causing a false "supply
collapse" lockout every boot.
```

### BUG-FIX hysteresisOC bypass (lines 858-862)
```
BUG-FIX: Gate hysteresisOC on the fault already being set by IDMT.
hysteresisOC() sets hyst_oc_active=true on the FIRST tick I >= CURR_OC_FAULT_A.
The old code `if (accum >= 1.0 || oc_latched)` fired OC_IDMT immediately on
first threshold crossing — bypassing the entire IEC 60255 time-inverse curve.
Fix: hysteresis only SUSTAINS a fault that IDMT already tripped.
```

### WARN_CURR_RISING Finding #7 (lines 963-967)
```
Finding #7 fix: threshold retuned from 0.05f (old broken units where
slope was Amps, not A/s — fired 20× too aggressively) to 2.0 A/s.
2.0 A/s is a genuine load-increase trajectory: a step from 16A to
21A (OC threshold) at this rate takes ~2.5s — meaningful warning
without triggering on normal load fluctuation.
```

### isLockoutClass (lines 1000-1004)
```
True if a LOCKOUT-class fault is active (sensor, thermal, SC, UV_INSTANT)
FSM uses this to route directly to LOCKOUT bypassing auto-reclose.
FAULT_BIT_SENSOR is P1 lockout: a blind protection system is worse than none.
FAULT_BIT_UV_INSTANT added (NEW-02 fix): supply collapse (<150V) is motor-
winding-destruction territory — no auto-reclose into a collapsed supply.
```

### clearLatched BUG-FIX (lines 1034-1042)
```
BUG-FIX: Reset hysteresis latch state for cleared faults.
Without this, hyst_oc/ov/uv_active remains true after reclose.
On the NEXT fault the hysteresis immediately re-fires the fault bit
on first threshold crossing — completely bypassing IDMT/debounce again.

Note: hyst_temp_active intentionally NOT cleared here —
thermal faults go to LOCKOUT and are cleared by clearAll() only.
```

### clearAll frozen buffer reset (lines 1066-1068)
```
Reset the frozen-ADC ring buffers so stale zero-variance data from the
previous test (e.g. a no-load scenario) can't immediately trigger a
frozen-sensor lockout on the very first sample of the next test.
```

---

## api_server.cpp

### File Header (lines 1-46)
```
api_server.cpp — ESPAsyncWebServer JSON REST API v2.1

TIER 1 FIXES (v2.1):

Finding #17 — HTTP Handler Reads g_reading Without Mutex
  All handlers that read g_reading / g_ctx now use two paths:
    /api/telemetry  → TelemetryBuilder::getSnapshot() — zero
                      serialisation in the async context, no
                      static buffer race, no mutex needed.
    /api/state      → seqlock retry loop on g_seqlock reads
                      g_reading / g_ctx atomically without
                      blocking the lwIP task.
  The key insight: pdMS_TO_TICKS(5) evaluates to 0 at 100Hz
  tick rate (5*100/1000 = 0, integer truncation). Any mutex
  attempt in this context is a non-blocking poll, not a wait.
  The seqlock is the correct primitive (Option C, research doc).

Finding #4 — SensorDiagnostics::compute() Mutates Shared State
  /api/diagnostics was calling compute() directly from the lwIP
  async context, racing with the call inside buildJSON() in
  task_comms. Both paths advanced the same static sliding window
  buffers — double-counting fault events and corrupting the
  power quality window.
  Fix: /api/diagnostics now calls lastSnapshot() only.
  compute() is called exclusively from buildJSON() in task_comms.

Finding #12 — Full API Key Printed to Serial on Every Boot
  Serial.printf now prints only first 4 chars + asterisks.
  The full key is never written to any serial or log output.
  Field recovery via /api/key-hint is the only legitimate channel.

Finding #16 — delay() Inside ESPAsyncWebServer Callback
  CONFIRMED ALREADY FIXED in original code.

UNCHANGED FROM v2.0: All route handlers not touching g_reading/g_ctx
```

### Seqlock snapshot helper (lines 71-75)
```
Seqlock snapshot helper (Finding #17)
Reads g_reading and g_ctx into caller-supplied structs using the
seqlock retry loop. Safe to call from the lwIP async context.
Returns true if a consistent snapshot was obtained.
Returns false if g_seqlock is not yet initialised (early boot).
```

### BUG-08 rateLimitOK (lines 102-107)
```
BUG-08 FIX: rateLimitOK() previously used non-atomic read-modify-write
sequences on the token counter. Two concurrent lwIP callbacks could both
read tokens=1, both pass the >0 check, both decrement — underflowing the
counter. On ESP32, ESPAsyncWebServer callbacks run on the lwIP task which
is single-threaded, but WiFi event callbacks can preempt it. A portMUX
spinlock is the correct ESP32 primitive for ISR-safe critical sections.
```

### Static telemetry buffer (lines 170-176)
```
Static buffer for /api/telemetry snapshot reads.
Bug 9 fix: this is ONE shared buffer, not per-handler as the old comment
incorrectly stated. Safe today only because ESPAsyncWebServer's lwIP event
loop is single-threaded — two invocations of this handler cannot interleave.
If handlers are ever refactored to a thread pool, move this buffer into
the lambda as a local (stack) variable to prevent data races.
```

### BUG-05 API key (lines 205-208)
```
BUG-05 FIX: Previously printed the full API key to serial on every
boot. An attacker with physical or remote serial access (USB CDC,
MQTT log forwarding) could harvest the key. Print only the first
4 characters followed by asterisks.
```

### BUG-03 relay auth (lines 443-446)
```
BUG-03 FIX: endpoint was completely unauthenticated — any LAN client
could toggle physical relays without an API key. Auth now checked in
both the no-body lambda and the body lambda, matching every other
write endpoint (POST /api/wifi, /api/factory-reset, etc).
```

### BUG-16 wifi/scan (lines 574-576)
```
BUG-16 FIX: /api/wifi/scan was unauthenticated — any LAN client
could enumerate nearby SSIDs without an API key, leaking location
information and enabling targeted evil-twin attacks.
```

### BUG-03 inject null check (lines 727-732)
```
BUG-03 FIX: The original IF-chain called strstr(cmd_loc, ...)
without null-checking cmd_loc after the CUSTOM_LOAD branch.
A payload like {"voltage":230,"current":5} with cmd_loc=nullptr
would fall through to the else-if chain and dereference nullptr,
crashing the lwIP task and killing all HTTP/WS connectivity.
Every branch now guards cmd_loc != nullptr before dereferencing.
```

---

## fsm.cpp

### File Header (lines 1-49)
```
fsm.cpp — Self-Healing Protection FSM
REVISION: 3.0 — Indian Grid / IS 12360 Compliance

STATE DIAGRAM:
BOOT –(1s warm-up)–► NORMAL
NORMAL –(any warn)–► WARNING
NORMAL –(any fault)–► FAULT or LOCKOUT
WARNING –(faults clear)–► NORMAL
WARNING –(fault escalates)–► FAULT or LOCKOUT
FAULT –(lockout-class fault)–► LOCKOUT
FAULT –(auto-reclose timer expires, V stable)–► RECOVERY
FAULT –(API reset, temp guard OK)–► RECOVERY
RECOVERY –(voltage stable 500ms, no fault)–► NORMAL
RECOVERY –(fault re-asserts)–► FAULT → (escalate)
LOCKOUT –(API reset, temp guard OK, sensor OK)–► RECOVERY

AUTO-RECLOSE DEAD TIMES (escalating — Section 7):
  Trip 1 → RECLOSE_DELAY_1_MS (5s)
  Trip 2 → RECLOSE_DELAY_2_MS (15s)
  Trip 3 → RECLOSE_DELAY_3_MS (30s) then LOCKOUT

LOCKOUT BYPASS (direct to LOCKOUT, no auto-reclose):
  FAULT_BIT_THERMAL, FAULT_BIT_SC, FAULT_BIT_SENSOR, DS18B20 disconnect

RECOVERY VALIDATION:
  Voltage must hold within VOLT_RECOVERY_LO..HI (±5% of 230V)
  for VOLT_RECOVERY_CONFIRM_N consecutive samples (500ms).

EDGE CASES:
  EC-04  DS18B20 +85°C boot sentinel
  EC-05  DS18B20 -127°C disconnect → LOCKOUT from ANY state
  EC-12  Thermal fault → LOCKOUT, skips auto-reclose
  EC-13  SC fault → LOCKOUT, skips auto-reclose
  EC-14  Recovery voltage hysteresis
```

### FSM::earlyInit (lines 122-132)
```
NEW-13 fix: the FSM mutex must exist before the HTTP server starts
accepting connections, because API handlers call requestReset() and
getContext() which both take the mutex. FSM::init() is called later
from task_protection on Core 0, potentially hundreds of milliseconds
after g_server.begin() — leaving a window where xSemaphoreTake(nullptr)
causes UB in release builds.

earlyInit() is called from setup() before g_server.begin().
init() checks whether the mutex was already created and skips
re-creation to stay idempotent.
```

### EC-05 DS18B20 disconnect (lines 186-203)
```
EC-05: DS18B20 disconnect — LOCKOUT from ANY state.
FIX NEW-01: The previous attempt (BUG-05) checked temp_c against
DS18B20_SENTINEL_DISC (-127°C), but DS18B20::getTemp() never returns
-127°C — it returns last_valid_temp, which is only written in the
STATE_VALID branch and is explicitly preserved on disconnect.
DS18B20::isDisconnected() is the correct signal: it is maintained by
the driver's debounce logic (3 consecutive -127°C reads = 2.4s).
```

### FIX Bug-2 reconnect flag (lines 206-216)
```
FIX Bug-2: consume DS18B20 reconnect flag.
ds18b20.cpp sets sensor_reconnected=true on recovery and requires the
caller to invoke clearReconnectedFlag() after logging. This was never
done, so after the first disconnect-reconnect wasReconnected() returned
true permanently and the reconnection event was never written to NVS.
```

### Severity-based adaptive delay (lines 260-303)
```
Compute Severity & Adaptive Delay
BUG-FIX: getCurrent() returns the IIR+MA smoothed display value.
At the moment of NORMAL→FAULT transition the relay has just
been determined to trip — the IIR may still be at its previous
steady-state value. getRawCurrentPhys() is the pre-IIR protection
path value — the same signal FaultEngine tripped on.
```

---

## main.cpp

### Seqlock (lines 44-55)
```
Seqlock for async readers (Findings #2, #17)
Protects g_reading and g_ctx against torn reads from lwIP async callbacks
(WS_EVT_CONNECT, HTTP handlers) without blocking the lwIP thread.

Seqlock contract:
  Writer (task_protection): odd seq → write → even seq
  Reader (lwIP callbacks):  loop { read seq0; copy; fence; read seq1 }
                            retry while seq0 is odd or seq0 != seq1

task_comms continues to use g_state_mutex — it is a real RTOS task that
can legitimately block for a tick, not an async callback.
```

### Finding #5 FIX task ordering (lines 322-336)
```
FINDING #5 FIX: Launch protection tasks BEFORE any WiFi work

Original code called WiFiManager::init() here, which could block
setup() for 30+ seconds in a captive portal loop — task_protection
was never created, the relay was never armed.

Correct sequence (per IEC 60255-1 and SGS Roadmap Tier 1):
  1. Create the mutex and shared state
  2. Register API routes (non-blocking)
  3. Start the HTTP server (non-blocking)
  4. Launch task_protection (Core 0) — UNCONDITIONAL
  5. Launch task_comms (Core 1) — UNCONDITIONAL
  6. Launch task_health (Core 1)
  7. Launch task_wifi_provision (Core 1) — BACKGROUND
```

### BUG-11/12 task creation (lines 366-370)
```
BUG-11/12 FIX: xTaskCreatePinnedToCore returns pdFAIL on heap
exhaustion, leaving h_prot/h_comms as nullptr. The health monitor
would then call uxTaskGetStackHighWaterMark(nullptr) — UB on ESP32.
configASSERT halts with a backtrace instead of silently continuing.
```

---

## relay_control.cpp

### File Header (lines 1-17)
```
relay_control.cpp
Active-LOW relay modules (LOW = CLOSED = load connected,
                           HIGH = OPEN  = safe/disconnected).

GPIO HIGH = relay coil de-energized = contacts open = SAFE.
GPIO HIGH is NOT the ESP32 power-on default — GPIOs float low
until explicitly driven. For active-LOW relays this means a
brief closure glitch is possible between reset and firmware
driving the pin. CRITICAL FIX: pre-set HIGH before pinMode so
the output driver powers up into the safe (OPEN) state:
  digitalWrite(pin, HIGH);  ← pre-set BEFORE OUTPUT mode
  pinMode(pin, OUTPUT);

User convention: pin HIGH = "off" = disconnected = safe state.
                 pin LOW  = "on"  = connected = normal state.
```

### NEW-17 atomic override (lines 29-45)
```
NEW-17 fix: two separate volatile bools are not atomically visible to
another core. Core 1 writes api_override_active=true THEN writes
api_override_state — Core 0 can observe active=true with the old state
value between the two stores, commanding the relay in the wrong direction.

Fix: encode both fields in a single std::atomic<uint32_t>:
  Bit 0 (0x1): override active flag
  Bit 1 (0x2): desired state (1 = close, 0 = open)

A single atomic store/load is always coherent on Xtensa dual-core.
memory_order_release on write / memory_order_acquire on read ensures
the payload (desired state) is visible together with the active flag.
```

---

## ds18b20.cpp

### File Header (lines 1-47)
```
ds18b20.cpp — DS18B20 1-Wire Temperature Sensor
REVISION: 2.0 — Full Sentinel Handling

1. BOOT SENTINEL FILTER (EC-04): DS18B20 scratchpad initialises to +85.0°C
   on power-up (~750ms). Firmware reading before conversion completes gets
   85°C and falsely triggers thermal fault. FIX: discard 85°C during boot window.

2. DISCONNECT SENTINEL (EC-05): DallasTemperature returns -127.0°C when bus
   is shorted/unplugged/pullup missing. Not a temperature — fire hazard without
   thermal protection. FIX: sets sensor_disconnected, FSM goes to LOCKOUT.

3. RECONNECTION DETECTION: After disconnect, valid reading → reconnected flag.
   LOCKOUT NOT auto-cleared — manual API reset required (safety by design).

4. READING VALIDITY TRACKING: Tracks consecutive valid reads.
   isReady() = true only after first valid AND not disconnected.
```

### EC-05 rev1 disconnect debounce (lines 75-82)
```
EC-05 rev1: Disconnect debounce counter.
Require DISC_DEBOUNCE_N consecutive -127°C readings before declaring
the sensor disconnected. A single marginal/glitch reading is ignored.
A genuinely unplugged wire produces sustained -127°C → trips after
DISC_DEBOUNCE_N × 800ms (3 × 800ms = 2.4 seconds).
Counter resets immediately on any valid reading.
```

### ReadState classification (lines 88-104)
```
Classify a raw DS18B20 reading into one of four states:
STATE_BOOT_SENTINEL  : 85.0°C AND boot window → discard
STATE_DISCONNECTED   : -127.0°C → LOCKOUT signal
STATE_INVALID_RANGE  : below -40°C or above 125°C (DS18B20 rated range)
STATE_VALID          : real temperature
```

---

## sensor_diagnostics.cpp

### File Header (lines 1-38)
```
sensor_diagnostics.cpp — Sensor Intelligence & Health Engine

Tier 1 fix — Finding #4: SensorDiagnostics::compute() Mutates
Shared Static State From Multiple Concurrent Contexts

ARCHITECTURE CHANGE (Lock-Free Double-Buffer, Approach A):

Before: compute() advanced all sliding windows AND serialised
the snapshot AND wrote to s_last. Called concurrently from
task_comms and the lwIP HTTP handler — double-advancing and torn reads.

After: Three responsibilities separated:
  update(v, i, t)  — Exclusive mutator (task_comms only)
  lastSnapshot()   — Pure observer (any context, lock-free)
  compute(v, i, t) — Backward-compatible shim
```

### Double-buffer design (lines 79-96)
```
Double-buffer for lock-free snapshot delivery (Finding #4)
Two complete DiagnosticsSnapshot buffers (~520 bytes total).

Writer (update, task_comms only):
  1. inactive_idx = active_idx ^ 1
  2. Build snapshot into s_buffers[inactive_idx]
  3. s_active_idx.store(inactive_idx, memory_order_release)

Reader (lastSnapshot, any context):
  1. idx = s_active_idx.load(memory_order_acquire)
  2. return copy of s_buffers[idx]

No locks. No blocking. No torn reads.
```

---

## telemetry_builder.cpp

### File Header (lines 1-36)
```
telemetry_builder.cpp — Centralized Telemetry JSON Assembler
SCHEMA VERSION: 1.3-local, BUILD VARIANT: LOCAL

CHANGES FROM v1.2:
  1. New "diagnostics" top-level object
  2. Schema version: "1.3-local"

Tier 1 (Finding #3 — static buffer race fix):
  buildSnapshot() + getSnapshot() provide seqlock-protected snapshot cache.
  buildJSON() called exclusively from task_comms.
  All lwIP async paths call getSnapshot().
```

### Finding #8 power computation (lines 104-110)
```
Power computation (Finding #8 fix)
real_power_w removed. power_factor hardcoded at 0.85 was producing
false telemetry: ±15-40% error depending on load type.
apparent_power_va is the only honestly-measured value available
without zero-crossing detection hardware.
```

### Bug 6 fault snapshot (lines 125-130)
```
Bug 6 fix: the old implementation compared ctx.fault_type (single-enum
highest-priority fault) against specific types. In multi-fault scenarios
only the highest-priority fault appeared — others silently absent.
Now uses r.fault_bits bitmask for all fields.
```

### Snapshot seqlock (lines 56-69)
```
Snapshot cache for async readers (Finding #3)
s_snapshot written only from task_comms via buildSnapshot().
Protected by seqlock so readers never see a torn string.

Seqlock protocol:
  Writer (task_comms): increment s_snap_seq to odd → copy → increment to even
  Reader (async): loop { read seq0; copy; fence; read seq1 }
                  until seq0 == seq1 && seq0 % 2 == 0
```

---

## ws_server.cpp

### File Header (lines 1-31)
```
ws_server.cpp — ESP32 WebSocket Telemetry Push Server
Mounts at: ws://<esp32_ip>/ws/telemetry

Thread safety (Tier 1 fix — Findings #2 and #3):
  WS_EVT_CONNECT fires from lwIP/AsyncTCP task context.
  Must not block, take mutex, or call buildJSON().
  Fix #2: seqlock retry loop for state reads.
  Fix #3: getSnapshot() instead of buildJSON().
```

### NEW-11 connect buffer (lines 49-53)
```
s_connect_buf was removed (NEW-11 fix).
Two simultaneous WS_EVT_CONNECT callbacks share the same task context
on the lwIP event loop; a single static buffer causes the second
callback to overwrite the first client's payload before client->text()
has queued it. Each connect now allocates its own heap buffer.
```

### NEW-12 ping exact match (lines 112-117)
```
NEW-12 fix: strncmp(s1, s2, len) stops at the null terminator
of the literal when len > strlen(literal), so any message that
merely *starts with* the ping prefix would incorrectly trigger a pong.
An exact-length pre-check ensures only precise ping frames match.
```

---

## mqtt_client.cpp

### File Header (lines 1-21)
```
mqtt_client.cpp — MQTT Client v2.0 — HiveMQ Cloud / TLS

CHANGES FROM v1.0:
  WiFiClient → WiFiClientSecure (TLS 1.2+)
  CA certificate from hivemq_cert.h (ISRG Root X1)
  Username/password auth, Port 8883
  Command subscription: sgs/device/<id>/cmd
  TLS handshake diagnostics
```

### BUG-07 pumpLoop (lines 266-270)
```
BUG-07 FIX: call mqtt.loop() before any blocking I/O in task_comms.
OLED I2C can block 15–30ms, starving the keepalive pump and causing
HiveMQ to drop the connection during TLS reconnects (up to 30s).
```

---

## wifi_manager.cpp

### BUG-06 NVS credentials (lines 174-178)
```
BUG-06 FIX: Previously hardcoded to "Lunch"/"saikiran" instead of
reading saved NVS preferences. If the user configured WiFi via the
captive portal or REST API, those saved credentials were completely
ignored on every boot.
```

### BUG-07 AP mode (lines 89-92)
```
BUG-07 FIX: WiFi.disconnect(true, true) erases the NVS WiFi
configuration layer. Entering AP mode for a retry should NOT
destroy saved credentials.
```

---

## nvs_log.cpp

### BUG-10/22 mutex timeout (lines 43-46)
```
BUG-10/22 FIX: Extended mutex timeout from 20ms to 200ms.
NVS page flushes can take 50-150ms on fragmented partitions.
A 20ms timeout caused silent drops of fault events.
```

### BUG-22 prefs.begin check (lines 49-51)
```
BUG-22 FIX: Check prefs.begin() return value. If NVS partition
is corrupted or locked, begin() returns false and all subsequent
put/get calls silently fail.
```

---

## GridVoltageSimulator.cpp

### tick() performance docs (lines 152-161)
```
tick() — O(1) deterministic real-time kernel
Execution path:
  1. Advance 5 oscillators:  5 × (2 FPU muls + 1 add)
  2. Conditional renormalise every 1024 ticks
  3. Amplitude modifier: flicker + sag/swell
  4. Waveform sum: 4 muls + 3 adds
  5. AWGN: cached z₁ every other tick
```

### Box-Muller AWGN (lines 97-107)
```
Box-Muller AWGN with z₁ caching
Transform: U₁, U₂ ~ Uniform(0,1] →
  z₀ = √(−2 ln U₁) · cos(2π U₂) ~ N(0,1)
  z₁ = √(−2 ln U₁) · sin(2π U₂) ~ N(0,1)
z₁ stored and returned on NEXT call without recomputing.
Average cost: 1 sqrtf + 1 logf + 1 cosf + 1 sinf per TWO ticks.
```

---

## GridCurrentSimulator.cpp

### Slip-dependent rotor model (lines 106-119)
```
Slip-dependent rotor parameter model (linear skin-effect interpolation)
From Dommel/EMTP literature and IEEE Std 112:
  R'₂(s) = R₂N + (R₂_standstill − R₂N) · s
  X'₂(s) = X₂a + (X₂N − X₂a) · (1 − s)
```

### AC peak current (lines 128-136)
```
AC peak current from T-equivalent circuit (IEEE 112 Annex B)
  Z_total = (R₁ + R'₂(s)/s) + j·(X₁ + X'₂(s))
  I_AC_peak = V_phase / |Z_total|
s clamped to s_rated to prevent singularity as s → 0.
```

### CT Saturation model (lines 148-176)
```
CT Saturation: Arctangent fractional model + volt-time area hard cutoff

Step 1 – Volt-time flux accumulation (leaky integrator):
  φ(t) = φ(t−dt) · flux_leak + V_x · dt
  Hard clamp: |φ| ≥ φ_sat → CT core fully saturated → i_sec = 0.

Step 2 – Arctangent smooth compression (knee-region model):
  i_sec_sat = I_sat · arctan(a · i) / arctan(a · I_knee)
  3-parameter fractional form from ResearchGate literature.
  ESP32 FPU evaluates atanf() natively.
```

### DC offset boundary condition (lines 83-92)
```
DC offset boundary condition: At breaker closure, flux linkages
in stator inductance cannot change instantaneously. The resulting
DC offset is maximised when voltage crosses zero (φ_close = 0).
  I_DC0 = −I_LR_peak · sin(φ_close)
```

---

## buzzer.cpp / led_alert.cpp / oled_display.cpp
These files have minimal comments (file headers only, pattern descriptions). No verbose comments to preserve.

---

*End of original comments archive. All comments shortened in source files to 1-2 lines while preserving meaning.*
