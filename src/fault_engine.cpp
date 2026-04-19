// ============================================================
//  fault_engine.cpp — Production Protection Engine
//  REVISION: 3.0 — Full Indian Grid / IS 12360 Compliance
//
//  ARCHITECTURE:
//
//  evaluate() is called every SENSOR_LOOP_MS (10ms) from the
//  Core-0 protection task. It processes voltage, current, and
//  temperature through a multi-stage pipeline:
//
//  Stage 1 — Signal pre-processing
//    - 3-sample median on current (EMI / commutation spike rejection)
//    - Asymmetric IIR: fast rise (α=0.90), slow fall (α=0.10)
//      α_rise raised from 0.50 to 0.90 per Document 6 (IEC 60255-151):
//      step-response proof shows 5A→30A fault gives 27.5A on first sample
//      → SC trips at 20ms (2×10ms debounce) ≤ 30ms mandate.
//    - Slope buffer update (5-sample linear regression for trend)
//
//    Tier 2 fix — Finding #6 / #20 (signal path refactor):
//    raw_i now receives ADCSampler::getRawCurrentPhys() — the value
//    after 4× oversampling + IDF v5 calibration ONLY, with NO IIR
//    and NO moving average applied by ADCSampler. The asymmetric IIR
//    inside evaluate() (Stage 1 above) is therefore the SINGLE and
//    ONLY filter stage on the protection signal path. This eliminates
//    the 4-stage cascade (ADCSampler IIR → ADCSampler MA →
//    FaultEngine asymIIR) that was attenuating 50ms SC spikes to
//    near noise before the SC comparator could evaluate them.
//    The shadow iir_i variable in both modules no longer exists —
//    FaultEngine owns the complete signal chain from raw ADC to trip.
//
//  Stage 2 — Sensor hardware validation (HIGHEST PRIORITY)
//    - ADC saturation detection (EC-06)
//    - ADC frozen/stuck detection (EC-07)
//    - Physics cross-channel sanity check (EC-08)
//    → Any failure: FAULT_BIT_SENSOR set → triggers LOCKOUT
//  Stage 3 — Instantaneous fault detection (NO debounce / blanking)
//    - Short circuit: I ≥ CURR_SC_INSTANT_A (EC-11)
//      Inside inrush blank: only trips if slope is RISING (adaptive)
//    - Severe overvoltage: V ≥ VOLT_OV_INSTANT_V (MOV protection)
//    → FAULT_BIT_SC or FAULT_BIT_OV_INSTANT set
//
//  Stage 4 — Debounced sustained fault detection
//    - Sustained OV: V ≥ VOLT_OV_FAULT_V for N consecutive samples
//    - IDMT overcurrent: accumulator ≥ 1.0 (IEC 60255 Standard Inverse)
//      Inside inrush blank: accumulator frozen at 0 (not incremented)
//    - Thermal: T ≥ TEMP_FAULT_C for N consecutive samples
//    - Sustained UV: V ≤ VOLT_UV_FAULT_V for N consecutive samples
//      Inside inrush blank: UV fault suppressed (EC-09 motor-induced sag)
//      UV_INSTANT (<150V) bypasses suppression always
//
//  Stage 5 — Warning detection
//    - OV warn, UV warn, OC warn, thermal warn, current-rising slope
//    - OC warn and UV warn suppressed during inrush blank window
//
//  Stage 6 — Hysteresis clear logic
//    - Active faults are NOT cleared just because threshold is no
//      longer exceeded. They clear only when the signal drops below
//      the corresponding hysteresis dropout threshold.
//    - This prevents relay chattering at threshold boundaries.
//
//  FAULT PRIORITY BITMASK (uint16_t):
//    Multiple faults can be simultaneously active.
//    getHighestPriorityFault() returns the FaultType of the
//    highest-priority active bit for FSM state machine display.
//    getActiveFaultBits() returns the full bitmask for logging.
//
//  EDGE CASES HANDLED:
//    EC-06  ADC saturation → FAULT_BIT_SENSOR → LOCKOUT
//    EC-07  Frozen ADC reading → FAULT_BIT_SENSOR → LOCKOUT
//    EC-08  Physics impossibility → FAULT_BIT_SENSOR → LOCKOUT
//    EC-09  Motor UV sag during inrush → suppressed
//    EC-10  OV >270V → zero-debounce FAULT_BIT_OV_INSTANT
//    EC-11  SC >27A → bypasses inrush blank (slope check)
//    EC-12  Thermal → FAULT_BIT_THERMAL (FSM routes to LOCKOUT)
//    EC-13  SC → FAULT_BIT_SC (FSM routes to LOCKOUT, no reclose)
//    EC-14  All threshold hysteresis bands (prevents chattering)
//    EC-15  IDMT accumulator decays slowly below pickup (thermal memory)
//    EC-01  Motor inrush: 3500ms blank window protects against nuisance
//    EC-02  SMPS inrush: SC slope detection catches genuine SC in <30ms
//    EC-03  Resistive cold inrush: covered by 3500ms blank window
// ============================================================
#include "fault_engine.h"
#include "config.h"
#include "serial_log.h"
#include <Arduino.h>
#include <cmath>
#include <cstring>

namespace {

// ── Debounce counters ──────────────────────────────────────────────────
int cnt_ov = 0;         // Stage 4: sustained OV fault debounce (IS 12360 +10%)
int cnt_ov_instant = 0; // Stage 3: OV_INSTANT (>270V) — separate from cnt_ov.
// BUG-01 FIX: Previously shared cnt_ov between Stage 3 (OV_INSTANT) and Stage 4
// (sustained OV). When voltage is in [VOLT_OV_FAULT_V, VOLT_OV_INSTANT_V),
// Stage 3's debounce() resets cnt_ov to 0 each tick (condition false), then
// Stage 4 increments it to 1. The counter bounces between 0 and 1 indefinitely
// — Stage 4 can never accumulate enough counts to reach fault_thresh. This is
// the identical bug that was already fixed for UV (cnt_uv_instant). Mirroring
// that fix here restores sustained OV protection (IS 12360 +10% = 253V zone),
// which was completely non-functional.
int cnt_uv = 0;         // Stage 4: sustained UV fault debounce
int cnt_uv_instant = 0; // Stage 3: UV_INSTANT (<150V) — separate from cnt_uv.
// BUG FIX: Previously shared cnt_uv between Stage 3 (UV_INSTANT) and Stage 4
// (sustained UV). Because both debounce() calls increment the same counter in
// a single evaluate() call, Stage 4 can reach its threshold (fault_thresh)
// before Stage 3 reaches FAULT_DEBOUNCE_INSTANT, causing Stage 4's log message
// to print for what is actually a UV_INSTANT condition and preventing the
// instant path from correctly attributing ANSI 27 vs near-collapse. Separate
// counters fix this.
int cnt_sc = 0; // SC debounce counter (ANSI 50 — short circuit instant trip)
int cnt_temp_fault = 0;
int cnt_ov_w = 0;
int cnt_uv_w = 0;
int cnt_oc_w = 0;
int cnt_temp_w = 0;

// ── Multi-fault bitmask ────────────────────────────────────────────────
uint16_t fault_bits = FAULT_BIT_NONE; // active fault bitmask
uint8_t warn_bits = WARN_NONE;        // active warning bitmask

// ── Hysteresis state ───────────────────────────────────────────────────
// Tracks whether each fault is currently "latched" and waiting for
// the signal to clear its hysteresis dropout threshold before resetting.
bool hyst_ov_active = false;
bool hyst_uv_active = false;
bool hyst_oc_active = false;
bool hyst_temp_active = false;

// ── Load State Machine ─────────────────────────────────────────────────
LoadState current_load_state = LOAD_STATE_IDLE;
uint32_t load_state_timer_ms = 0;
uint32_t startup_exit_ms = 0;

// ── Delay on Break (DOB) Lockout ───────────────────────────────────────
uint32_t lockout_dob_timer_ms = 0;

// ── Warning blanking ───────────────────────────────────────────────────
uint32_t inrush_blank_warn_until_ms = 0; // OC warn + UV warn suppressed

// ── IDMT accumulator (IEC 60255 Standard Inverse) ─────────────────────
float idmt_accumulator = 0.0f;

// ── Asymmetric IIR state ───────────────────────────────────────────────
float iir_i = 0.0f;

// ── 3-sample median buffer ─────────────────────────────────────────────
float med_buf[3] = {};
uint32_t med_idx =
    0; // FIX Bug-1: was uint8_t — wraps 255→0 making med_ready=(0≥3)=false
       // every 256 calls (~2.56s at 100Hz), bypassing the 3-sample EMI
       // median and exposing the asymmetric IIR to a raw spike.
       // uint32_t: overflows only after ~497 days at 100Hz — safe.
bool med_full __attribute__((unused)) = false;

// ── Slope buffer (5 samples) ───────────────────────────────────────────
static constexpr int SLOPE_N = 5;
float slope_buf[SLOPE_N] = {};
int slope_idx = 0;
bool slope_full = false;

#ifndef HARDWARE_BENCH_TESTING
// ── Saturation tracking (EC-06) ────────────────────────────────────────
// Saturation = ADC reading stuck at 0 or 4095.
// We track how long the saturation condition persists.
uint32_t v_sat_start_ms = 0;
uint32_t i_sat_start_ms = 0;
bool v_was_sat = false;
bool i_was_sat = false;

// ── Frozen sensor tracking (EC-07) ─────────────────────────────────────
// Track last N RAW ADC integer values (not IIR-smoothed physical values).
// Raw ADC always has ≥1 LSB quantisation noise on a live signal (variance
// typically 2–15 LSB²). A genuinely stuck ADC returns a constant integer
// → variance exactly 0. IIR-smoothed values are unsuitable here because
// the slow-fall IIR (α=0.10) collapses variance to near-zero even on a
// healthy sensor, causing 100% false-positive rate. Fixed: EC-07 rev1.
static constexpr int FROZEN_N = 20;
int frozen_v_buf[FROZEN_N] = {};
int frozen_i_buf[FROZEN_N] = {};
int frozen_idx = 0;
bool frozen_full = false;
#endif // !HARDWARE_BENCH_TESTING

// ── Last raw ADC values (passed from adc_sampler for sensor checks) ────
int last_raw_v = 2048;
int last_raw_i = 0;

// ─────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────

float median3(float a, float b, float c) {
  if (a > b) {
    float t = a;
    a = b;
    b = t;
  }
  if (b > c) {
    float t = b;
    b = c;
    c = t;
  }
  if (a > b) {
    float t = a;
    a = b;
    b = t;
  }
  return b;
}

float asymIIR(float new_val, float prev, float alpha_rise, float alpha_fall) {
  float alpha = (new_val >= prev) ? alpha_rise : alpha_fall;
  return alpha * new_val + (1.0f - alpha) * prev;
}

float currentSlope() {
  if (!slope_full)
    return 0.0f;
  // Finding #7 fix: divide by total time window in seconds, not by
  // sample count. Previous code divided by SLOPE_N (a dimensionless
  // count), producing a result in Amps, not A/s. This caused the
  // WARN_CURR_RISING threshold (0.05f) to fire 20× too aggressively
  // because 0.05A over 5 samples was compared against what should
  // have been 0.05 A/s.
  //
  // Correct formula: (last - first) / (SLOPE_N * SENSOR_LOOP_MS / 1000.0f)
  // At SLOPE_N=5, SENSOR_LOOP_MS=10ms: window = 50ms = 0.05s
  // A change of 1A over 5 samples → slope = 1.0 / 0.05 = 20 A/s
  static constexpr float SLOPE_WINDOW_S = (SLOPE_N * SENSOR_LOOP_MS) / 1000.0f;
  int tail = (slope_idx + 1) % SLOPE_N;
  return (slope_buf[slope_idx] - slope_buf[tail]) / SLOPE_WINDOW_S;
}

// Debounce: returns true when condition has been true for N consecutive ticks
bool debounce(bool condition, int &counter, int threshold) {
  if (condition) {
    if (++counter >= threshold) {
      counter = threshold;
      return true;
    }
  } else {
    counter = 0;
  }
  return false;
}

#ifndef HARDWARE_BENCH_TESTING
// Buffer variance computation (for frozen sensor detection)
float bufferVariance(const float *buf, int n) {
  if (n < 2)
    return 1.0f; // insufficient data — assume non-frozen
  float sum = 0.0f, sq = 0.0f;
  for (int k = 0; k < n; k++) {
    sum += buf[k];
    sq += buf[k] * buf[k];
  }
  float mean = sum / n;
  // Bug 7b fix: sample variance (÷ N-1) for consistency with adc_sampler.cpp.
  // Low severity here (threshold comparison only, not displayed), but
  // corrected for uniformity across all variance sites in the codebase.
  float var = (sq - n * mean * mean) / (n - 1);
  return (var > 0.0f) ? var : 0.0f;
}

// ─────────────────────────────────────────────────────────────────────
//  STAGE 2: SENSOR HARDWARE VALIDATION
// ─────────────────────────────────────────────────────────────────────

// EC-06: ADC saturation (open wire / op-amp short to rail)
// Input: raw ADC integer (0–4095)
// Returns true if fault should be raised (saturation persists >50ms)
bool checkSaturation(int raw_v_int, int raw_i_int) {
  uint32_t now = millis();

  // Voltage channel saturation
  bool v_sat = (raw_v_int <= 5 || raw_v_int >= 4090);
  if (v_sat) {
    if (!v_was_sat) {
      v_sat_start_ms = now;
      v_was_sat = true;
    }
    if ((now - v_sat_start_ms) >= SENSOR_SAT_WINDOW_MS) {
      LOG_FAULT("SENSOR: voltage ADC saturation %dms raw=%d",
                now - v_sat_start_ms, raw_v_int);
      return true;
    }
  } else {
    v_was_sat = false;
    v_sat_start_ms = 0;
  }

  // Current channel saturation
  bool i_sat = (raw_i_int <= 5 || raw_i_int >= 4090);
  if (i_sat) {
    if (!i_was_sat) {
      i_sat_start_ms = now;
      i_was_sat = true;
    }
    if ((now - i_sat_start_ms) >= SENSOR_SAT_WINDOW_MS) {
      LOG_FAULT("SENSOR: current ADC saturation %dms raw=%d",
                now - i_sat_start_ms, raw_i_int);
      return true;
    }
  } else {
    i_was_sat = false;
    i_sat_start_ms = 0;
  }

  return false;
}

// EC-07: Frozen/stuck sensor (ADC multiplexer hang)
// Receives RAW ADC integers (0–4095), NOT IIR-smoothed physical values.
// Threshold: 1.0 LSB² — live sensor variance is 2–15×, stuck ADC is 0.
bool checkFrozen(int raw_v_int, int raw_i_int) {
  frozen_v_buf[frozen_idx] = raw_v_int;
  frozen_i_buf[frozen_idx] = raw_i_int;
  if (frozen_idx == FROZEN_N - 1)
    frozen_full = true;
  frozen_idx = (frozen_idx + 1) % FROZEN_N;

  if (!frozen_full)
    return false;

  auto intBufVariance = [](const int *buf, int n) -> float {
    float sum = 0.0f, sq = 0.0f;
    for (int k = 0; k < n; k++) {
      float v = static_cast<float>(buf[k]);
      sum += v;
      sq += v * v;
    }
    float mean = sum / n;
    float var = (sq - n * mean * mean) /
                (n - 1); // NEW-06: Bessel-corrected sample variance
    return (var > 0.0f) ? var : 0.0f;
  };

  float var_v = intBufVariance(frozen_v_buf, FROZEN_N);
  float var_i = intBufVariance(frozen_i_buf, FROZEN_N);

  if (var_v < 1.0f && var_i < 1.0f) {
    LOG_FAULT("SENSOR: frozen ADC — raw_v_var=%.2f raw_i_var=%.2f", var_v,
              var_i);
    return true;
  }
  return false;
}

// EC-08: Physics impossibility cross-check
// Significant current flow while voltage reads near zero is impossible
// on AC mains — indicates at least one sensor has catastrophically failed.
bool checkPhysicsImpossibility(float v, float i) {
  if (i >= SENSOR_PHYSICS_I_MIN && v < SENSOR_PHYSICS_V_MAX) {
    LOG_FAULT("SENSOR: physics impossibility — "
              "V=%.1fV I=%.2fA (impossible on AC mains)",
              v, i);
    return true;
  }
  return false;
}
#endif // !HARDWARE_BENCH_TESTING

// ─────────────────────────────────────────────────────────────────────
//  STAGE 3: IDMT ACCUMULATOR (IEC 60255 Standard Inverse)
// ─────────────────────────────────────────────────────────────────────
//
//  Formula: t(I) = TMS × k / ((I/Is)^α - 1)
//  Accumulator increments by SENSOR_LOOP_MS / t(I) each tick.
//  Trips when accumulator >= 1.0.
//
//  Thermal memory (EC-15): accumulator decays at IDMT_ACCUMULATOR_DECAY
//  per tick below pickup. This means a sustained overload that cleared
//  before tripping still has a "memory" — next overload trips faster.
//  This correctly models wire insulation thermal stress accumulation.
//
//  Reset: accumulator resets to 0 when relay opens (clearLatched()).
//  This models thermal cooling when the load is removed.

void tickIDMT(float i_filtered, bool blank_active) {
  if (blank_active) {
    // During inrush blank: freeze accumulator — do NOT increment or reset.
    // BUG-06 FIX: previously this zeroed idmt_accumulator, destroying any
    // thermal memory built up before relay reclose. If a load had accumulated
    // 0.8 on a previous overload, the 3500ms blank window on relay close was
    // wiping that history. The accumulator is only legitimately reset when the
    // relay opens (notifyRelayClosed / clearLatched), modelling thermal cooling
    // when the load is removed. During a blank window the load is energised and
    // the wire is still warm — thermal state must be preserved.
    return;
  }

  if (i_filtered <= IDMT_IS) {
    // Below pickup: thermal memory decay (EC-15)
    idmt_accumulator *= IDMT_ACCUMULATOR_DECAY;
    if (idmt_accumulator < 0.0f)
      idmt_accumulator = 0.0f;
    return;
  }

  // Above pickup: increment accumulator
  float ratio = i_filtered / IDMT_IS;
  // (ratio)^α using natural log: ratio^α = e^(α × ln(ratio))
  float denom = expf(IDMT_ALPHA * logf(ratio)) - 1.0f;

  if (denom <= 1e-6f) {
    // Ratio is too close to 1.0 — avoid division by near-zero
    // This happens when I is only fractionally above Is
    // Apply maximum trip time effectively
    idmt_accumulator += (float)SENSOR_LOOP_MS / (float)IDMT_MAX_TRIP_MS;
    return;
  }

  float t_trip_ms = IDMT_TMS * IDMT_K / denom * 1000.0f;

  // Clamp to physically meaningful range
  if (t_trip_ms < IDMT_MIN_TRIP_MS)
    t_trip_ms = IDMT_MIN_TRIP_MS;
  if (t_trip_ms > IDMT_MAX_TRIP_MS)
    t_trip_ms = IDMT_MAX_TRIP_MS;

  idmt_accumulator += (float)SENSOR_LOOP_MS / t_trip_ms;

  // Cap at 2.0 to prevent infinite wind-up during sustained faults
  if (idmt_accumulator > 2.0f)
    idmt_accumulator = 2.0f;
}

// ─────────────────────────────────────────────────────────────────────
//  HYSTERESIS HELPERS
// ─────────────────────────────────────────────────────────────────────
//
//  Each fault has a PICKUP threshold (where it sets) and a DROPOUT
//  threshold (where it clears). The fault remains active between
//  pickup and dropout to prevent relay chattering at the boundary.
//
//  Example OV: sets at 253V, clears at 245V.
//  If voltage hovers at 252V, fault stays active until 244V is reached.

// OV: pickup ≥ VOLT_OV_FAULT_V, dropout < VOLT_OV_FAULT_HYST_V
bool hysteresisOV(float v) {
  if (!hyst_ov_active && v >= VOLT_OV_FAULT_V)
    hyst_ov_active = true;
  if (hyst_ov_active && v < VOLT_OV_FAULT_HYST_V)
    hyst_ov_active = false;
  return hyst_ov_active;
}

// UV: pickup ≤ VOLT_UV_FAULT_V, dropout > VOLT_UV_FAULT_HYST_V
bool hysteresisUV(float v) {
  if (!hyst_uv_active && v <= VOLT_UV_FAULT_V)
    hyst_uv_active = true;
  if (hyst_uv_active && v > VOLT_UV_FAULT_HYST_V)
    hyst_uv_active = false;
  return hyst_uv_active;
}

// OC: pickup ≥ CURR_OC_FAULT_A, dropout < CURR_OC_FAULT_HYST_A
bool hysteresisOC(float i) {
  if (!hyst_oc_active && i >= CURR_OC_FAULT_A)
    hyst_oc_active = true;
  if (hyst_oc_active && i < CURR_OC_FAULT_HYST_A)
    hyst_oc_active = false;
  return hyst_oc_active;
}

// Thermal: pickup ≥ TEMP_FAULT_C, dropout < TEMP_FAULT_HYST_C
bool hysteresisTemp(float t) {
  if (!hyst_temp_active && t >= TEMP_FAULT_C)
    hyst_temp_active = true;
  if (hyst_temp_active && t < TEMP_FAULT_HYST_C)
    hyst_temp_active = false;
  return hyst_temp_active;
}

// ─────────────────────────────────────────────────────────────────────
//  FAULT BIT HELPERS
// ─────────────────────────────────────────────────────────────────────
// Returns the highest-priority active fault as a FaultType enum.
// Priority order matches Section 8 of reference document.
FaultType highestPriorityFault() {
  if (fault_bits & FAULT_BIT_SENSOR)
    return FAULT_SENSOR;
  if (fault_bits & FAULT_BIT_SC)
    return FAULT_SHORT_CIRCUIT;
  if (fault_bits & FAULT_BIT_OV_INSTANT)
    return FAULT_OVERVOLTAGE;
  if (fault_bits & FAULT_BIT_UV_INSTANT)
    return FAULT_UNDERVOLT; // P3b — supply collapse → LOCKOUT
  if (fault_bits & FAULT_BIT_THERMAL)
    return FAULT_THERMAL;
  if (fault_bits & FAULT_BIT_OV)
    return FAULT_OVERVOLTAGE;
  if (fault_bits & FAULT_BIT_OC_IDMT)
    return FAULT_OVERCURRENT;
  if (fault_bits & FAULT_BIT_UV)
    return FAULT_UNDERVOLT;
  return FAULT_NONE;
}

} // namespace

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────
namespace FaultEngine {

void init() {
  fault_bits = FAULT_BIT_NONE;
  warn_bits = WARN_NONE;
  idmt_accumulator = 0.0f;
  iir_i = 0.0f;

  // Reset all counters
  cnt_ov = cnt_ov_instant = cnt_uv = cnt_uv_instant = cnt_sc = cnt_temp_fault =
      0;
  cnt_ov_w = cnt_uv_w = cnt_oc_w = cnt_temp_w = 0;

  // BUG-FIX: Reset hysteresis state on init.
  // These were never reset here — on warm reboot (ESP.restart()), the
  // hysteresis bools survive as stale true from the previous session,
  // causing the first fault of the new boot to fire before IDMT accumulates.
  hyst_ov_active   = false;
  hyst_uv_active   = false;
  hyst_oc_active   = false;
  hyst_temp_active = false;

  // Reset buffers
  memset(slope_buf, 0, sizeof(slope_buf));
  memset(med_buf, 0, sizeof(med_buf));
#ifndef HARDWARE_BENCH_TESTING
  memset(frozen_v_buf, 0, sizeof(frozen_v_buf));
  memset(frozen_i_buf, 0, sizeof(frozen_i_buf));
#endif

  current_load_state = LOAD_STATE_IDLE;
  lockout_dob_timer_ms = 0;
  inrush_blank_warn_until_ms = 0;
  startup_exit_ms = 0;

  LOG_FAULT_ENG("v3.0 init — IS 12360 / IEC 60255 IDMT ready");
}

// Called by RelayControl when relay CLOSES (load energised)
// Arms the motor startup state machine
void notifyRelayClosed() {
  uint32_t now = millis();
  current_load_state = LOAD_STATE_IDLE;
  inrush_blank_warn_until_ms = now + 1000;

  // Reset IDMT accumulator — cooling model: relay was open, load removed
  idmt_accumulator = 0.0f;
  cnt_sc = 0;
  cnt_oc_w = 0;

  LOG_FAULT_ENG("relay closed — motor state machine armed");
}

LoadState getLoadState() { return current_load_state; }

void initiateLockout(uint32_t duration_ms) {
  lockout_dob_timer_ms = millis() + duration_ms;
  LOG_FAULT_ENG("DOB Lockout initiated for %ums", duration_ms);
}

bool isInLockoutDOB() {
  return (lockout_dob_timer_ms > 0 && millis() < lockout_dob_timer_ms);
}

float getIDMTAccumulator() { return idmt_accumulator; }

// ─────────────────────────────────────────────────────────────────────
//  MAIN EVALUATION — called every SENSOR_LOOP_MS (10ms)
//
//  Parameters:
//    v        : filtered voltage in Volts (from ADCSampler)
//    raw_i    : raw current reading in Amps (BEFORE asymmetric IIR)
//    t        : temperature in °C (from DS18B20)
//    raw_v_int: raw ADC integer for voltage channel (for saturation check)
//    raw_i_int: raw ADC integer for current channel (for saturation check)
// ─────────────────────────────────────────────────────────────────────
void evaluate(float v, float raw_i, float t, int raw_v_int, int raw_i_int, uint32_t spoofed_now_ms) {

  uint32_t now = (spoofed_now_ms > 0) ? spoofed_now_ms : millis();

  // ── Stage 1: Signal pre-processing ───────────────────────────────

  // 3-sample median on raw current (reject single-sample EMI spikes)
  med_buf[med_idx % 3] = raw_i;
  med_idx++;
  bool med_ready = (med_idx >= 3);
  float i_med = med_ready ? median3(med_buf[0], med_buf[1], med_buf[2]) : raw_i;

  // Asymmetric IIR: fast rise (α=0.50) catches real load steps quickly
  //                 slow fall (α=0.10) rejects brief 50–200ms transients
  // Asymmetric IIR on the protection signal path.
  // Document 6 proof: with the raw pre-IIR input
  // (ADCSampler::getRawCurrentPhys()), α_rise must be 0.90 to ensure a 30A
  // fault step produces ≥27A on the first sample: 5 + 0.90*(30-5) = 27.5A ≥
  // CURR_SC_INSTANT_A (27A). With FAULT_DEBOUNCE_INSTANT=2, SC trips at 20ms —
  // compliant with IEC 60255-151
  // (<30ms). At the old α_rise=0.50, the fourth sample was needed (40ms) —
  // non-compliant. α_fall=0.10 (slow decay) unchanged — rejects brief
  // transients and EMI spikes.
  float i = asymIIR(i_med, iir_i, 0.90f, 0.10f);
  iir_i = i;

  // Update slope buffer for rising current trend detection
  slope_buf[slope_idx] = i;
  if (slope_idx == SLOPE_N - 1)
    slope_full = true;
  slope_idx = (slope_idx + 1) % SLOPE_N;
  float slope = currentSlope(); // A per tick (positive = rising)

  // Store raw values for sensor checks
  last_raw_v = raw_v_int;
  last_raw_i = raw_i_int;

  // ── Stage 2: Sensor hardware validation (HIGHEST PRIORITY) ───────
  // EC-06: ADC saturation — raw ≤5 or ≥4090 for >SENSOR_SAT_WINDOW_MS
  // EC-07: Frozen/stuck ADC — zero variance across FROZEN_N raw samples
  // EC-08: Physics impossibility — I>2A with V<5V simultaneously
  // Any hit → FAULT_BIT_SENSOR → FSM routes to LOCKOUT (no auto-reclose)
  // BUG-02 FIX: these three calls were removed and the functions left as
  // dead code. A stuck or saturated ADC will now correctly trigger LOCKOUT
  // instead of silently producing invalid measurements.
#ifndef HARDWARE_BENCH_TESTING
  if (checkSaturation(raw_v_int, raw_i_int) ||
      checkFrozen(raw_v_int, raw_i_int) ||
      checkPhysicsImpossibility(v, i_med)) {
    if (!(fault_bits & FAULT_BIT_SENSOR)) {
      fault_bits |= FAULT_BIT_SENSOR;
      LOG_FAULT("SENSOR: hardware validation failed → LOCKOUT");
    }
  }
#endif

  // ── Stage 2.5: Load State Machine (Motor Startup Support) ────────

  float instant_trip_threshold = CURR_SC_RUNNING_INSTANT_A;
  bool startup_active = false;

  switch (current_load_state) {
  case LOAD_STATE_IDLE:
    if (i > CURR_IDLE_LIMIT_A) {
      current_load_state = LOAD_STATE_STARTING;
      load_state_timer_ms = now;
      instant_trip_threshold = CURR_SC_STARTUP_INSTANT_A;
      LOG_FAULT_ENG("LOAD_STATE_IDLE -> STARTING (Motor Inrush active)");
    }
    break;

  case LOAD_STATE_STARTING:
    startup_active = true;
    // Check if current has decayed to near nominal rating
    if (i < (RATED_CURRENT_A * 1.2f)) {
      current_load_state = LOAD_STATE_RUNNING;
      instant_trip_threshold = CURR_SC_RUNNING_INSTANT_A;
      startup_exit_ms = now;
      LOG_FAULT_ENG("LOAD_STATE_STARTING -> RUNNING (Motor Accelerated)");
    }
    // Check if the motor took too long to start (Locked Rotor condition)
    else if (now - load_state_timer_ms > T_START_MAX_MS) {
      if (!(fault_bits & FAULT_BIT_OC_IDMT)) {
        fault_bits |= FAULT_BIT_OC_IDMT; // Route to FSM FAULT
        LOG_FAULT("LOCKED ROTOR: Motor failed to accelerate → LOCKOUT DOB");
      }
      initiateLockout(T_LOCKOUT_DOB_MS);
      current_load_state = LOAD_STATE_FAULT;
      // FIX: Maintain startup SC threshold while the relay mechanically opens
      // to prevent false escalation to SC INSTANT due to relay delay (90A > 27A).
      instant_trip_threshold = CURR_SC_STARTUP_INSTANT_A;
    } else {
      instant_trip_threshold = CURR_SC_STARTUP_INSTANT_A;
    }
    break;

  case LOAD_STATE_RUNNING:
    if (i > CURR_SC_RUNNING_INSTANT_A) {
      current_load_state = LOAD_STATE_FAULT;
      initiateLockout(T_LOCKOUT_DOB_MS);
    } else if (i < CURR_IDLE_LIMIT_A) {
      // Motor stopped -> enforce DOB safety
      current_load_state = LOAD_STATE_IDLE;
      initiateLockout(T_LOCKOUT_DOB_MS);
      LOG_FAULT_ENG("LOAD_STATE_RUNNING -> IDLE (Motor Stopped -> DOB forced)");
    }
    break;

  case LOAD_STATE_FAULT:
    if (i < CURR_IDLE_LIMIT_A) {
      current_load_state = LOAD_STATE_IDLE;
    } else {
      // FIX: While waiting for relay to mechanically open a faulting load,
      // Suppress standard RUNNING SC trips so we don't accidentally trigger
      // SC INSTANT as the threshold falls while current hasn't yet dropped.
      instant_trip_threshold = CURR_SC_STARTUP_INSTANT_A;
    }
    break;
  }

  bool oc_warn_blanked = (now < inrush_blank_warn_until_ms);
  bool uv_warn_blanked = oc_warn_blanked;

  // Adaptive debounce: heavy load mode
  bool heavy_load = (i >= LOAD_HEAVY_A);
  int fault_thresh = heavy_load ? FAULT_DEBOUNCE_HEAVY : FAULT_DEBOUNCE_N;
  int warn_thresh = heavy_load ? WARN_DEBOUNCE_HEAVY : WARN_DEBOUNCE_N;

  // ── Stage 3: Instantaneous faults (no debounce or blanking) ──────

  // P3: Severe overvoltage >270V (EC-10) — zero debounce
  // Protects MOV (MCOV 275V) and semiconductor SOA
  // Uses cnt_ov_instant (separate from cnt_ov) — see BUG-01 fix in
  // declarations.
  if (debounce(v >= VOLT_OV_INSTANT_V, cnt_ov_instant,
               FAULT_DEBOUNCE_INSTANT)) {
    if (!(fault_bits & FAULT_BIT_OV_INSTANT)) {
      fault_bits |= FAULT_BIT_OV_INSTANT;
      LOG_FAULT("OV_INSTANT: V=%.1fV ≥ %.0fV — MOV protection", v,
                VOLT_OV_INSTANT_V);
    }
  } else if (v < VOLT_OV_INSTANT_V - 5.0f) {
    // Clear with 5V hysteresis below instant threshold
    fault_bits &= ~FAULT_BIT_OV_INSTANT;
  }

  // UV_INSTANT <150V — near supply collapse, LOCKOUT condition (EC-09
  // exception) ARCHITECTURAL FIX: Mute UV checking during the first 1000ms of
  // boot. The ADC's internal IIR filter starts at 0.0V and takes ~1 second to
  // mathematically converge up to the real 230V mains reading. Evaluating UV
  // during this natural 0V->230V mathematical ramp was causing a false "supply
  // collapse" lockout every boot.
#ifdef HARDWARE_BENCH_TESTING
  // Bench mode: 30s mute — gives time to adjust pots or connect via Phantom
  // Dashboard
  const uint32_t uv_mute_ms = 30000;
#else
  const uint32_t uv_mute_ms = 1000;
#endif
  if (now >= uv_mute_ms && debounce(v <= VOLT_UV_INSTANT_V, cnt_uv_instant,
                                    FAULT_DEBOUNCE_INSTANT)) {
    if (!(fault_bits & FAULT_BIT_UV_INSTANT)) {
      fault_bits |= FAULT_BIT_UV_INSTANT;
      LOG_FAULT("UV_INSTANT: V=%.1fV ≤ %.0fV — supply collapse → LOCKOUT",
                v, VOLT_UV_INSTANT_V);
    }
  }

  // P2: Short circuit ANSI 50 (EC-11)
  // Hard limit check (120A catastrophic always active)
  if (i >= CURR_SC_HARD_A) {
    if (!(fault_bits & FAULT_BIT_SC)) {
      fault_bits |= FAULT_BIT_SC;
      LOG_FAULT("SC HARD: I=%.1fA ≥ %.0fA → LOCKOUT", i,
                CURR_SC_HARD_A);
    }
  }

  // Dynamic Instant trips (differs between STARTING and RUNNING)
  bool sc_instant_trip = (i >= instant_trip_threshold);
  bool sc_inside_rising =
      startup_active && sc_instant_trip && (slope >= INRUSH_SC_SLOPE_A_PER_S);

  if (debounce(sc_instant_trip && (!startup_active || sc_inside_rising), cnt_sc,
               FAULT_DEBOUNCE_INSTANT)) {
    if (!(fault_bits & FAULT_BIT_SC)) {
      fault_bits |= FAULT_BIT_SC;
      LOG_FAULT("SC INSTANT: I=%.1fA ≥ %.0fA slope=%.3f "
                "startup=%s → LOCKOUT",
                i, instant_trip_threshold, slope,
                startup_active ? "ACTIVE" : "NO");
    }
  }

  // ── Stage 4: Debounced sustained fault detection ──────────────────

  // P5: Sustained overvoltage — IS 12360 +10%
  // Hysteresis: fault holds until V drops below VOLT_OV_FAULT_HYST_V (EC-14)
  bool ov_pickup = debounce(v >= VOLT_OV_FAULT_V, cnt_ov, fault_thresh);
  bool ov_latched = hysteresisOV(v);
  if (ov_pickup || ov_latched) {
    if (!(fault_bits & FAULT_BIT_OV)) {
      fault_bits |= FAULT_BIT_OV;
      LOG_FAULT("OV: V=%.1fV ≥ %.0fV (IS 12360 +10%%)", v,
                VOLT_OV_FAULT_V);
    }
  } else {
    fault_bits &= ~FAULT_BIT_OV;
    cnt_ov = 0;
  }

  // P6: IDMT overcurrent ANSI 51
  // Accumulator ticks when I > IDMT_IS (= CURR_OC_FAULT_A)
  // Suppressed during motor STARTING phase
  tickIDMT(i, startup_active);

  // BUG-FIX: Gate hysteresisOC on the fault already being set by IDMT.
  // hysteresisOC() sets hyst_oc_active=true on the FIRST tick I >= CURR_OC_FAULT_A.
  // The old code `if (accum >= 1.0 || oc_latched)` fired OC_IDMT immediately on
  // first threshold crossing — bypassing the entire IEC 60255 time-inverse curve.
  // Fix: hysteresis only SUSTAINS a fault that IDMT already tripped.
  bool oc_idmt_fired = (idmt_accumulator >= 1.0f);
  bool oc_already_set = (bool)(fault_bits & FAULT_BIT_OC_IDMT);
  bool oc_latched = oc_already_set && hysteresisOC(i);  // sustain only
  if (oc_idmt_fired || oc_latched) {
    if (!oc_already_set) {
      fault_bits |= FAULT_BIT_OC_IDMT;
      LOG_FAULT("OC_IDMT: I=%.1fA  accum=%.3f  "
                "IDMT tripped (IEC 60255)",
                i, idmt_accumulator);
    }
  } else if (!oc_latched && idmt_accumulator < 0.05f) {
    // Clear OC fault bit only when accumulator has decayed AND current
    // is below hysteresis dropout threshold
    if (oc_already_set) {
      hyst_oc_active = false;  // reset sustain latch when fault fully clears
    }
    fault_bits &= ~FAULT_BIT_OC_IDMT;
  }

  // P4: Thermal limit (EC-12)
  // Hysteresis: fault holds until temp drops below TEMP_FAULT_HYST_C
  bool temp_pickup = debounce(t >= TEMP_FAULT_C, cnt_temp_fault, fault_thresh);
  bool temp_latched = hysteresisTemp(t);
  if (temp_pickup || temp_latched) {
    if (!(fault_bits & FAULT_BIT_THERMAL)) {
      fault_bits |= FAULT_BIT_THERMAL;
      LOG_FAULT("THERMAL: T=%.1f°C ≥ %.0f°C → LOCKOUT", t,
                TEMP_FAULT_C);
    }
  } else {
    fault_bits &= ~FAULT_BIT_THERMAL;
    cnt_temp_fault = 0;
  }

  // P7: Sustained undervoltage — IS 12360 -10%
  // Conditional Blanking (Two-Tier Masking) Fix
  bool voltage_recovery_active = (!startup_active && (now - startup_exit_ms < 500));
  bool uv_condition;
  if (startup_active || voltage_recovery_active) {
    // During motor startup + 500ms math bleed-off: Expand tolerance to 170V. 
    uv_condition = (v <= VOLT_UV_STARTUP_V);
  } else {
    // Normal state: 207V threshold
    uv_condition = (v <= VOLT_UV_FAULT_V);
  }
  
  bool uv_pickup = debounce(uv_condition, cnt_uv, fault_thresh);
  bool uv_latched = hysteresisUV(v) && !(startup_active || voltage_recovery_active);

  if (now >= uv_mute_ms && (uv_pickup || uv_latched)) {
    if (!(fault_bits & FAULT_BIT_UV)) {
      fault_bits |= FAULT_BIT_UV;
      LOG_FAULT("UV: V=%.1fV ≤ %.0fV (IS 12360 -10%%)", v,
                VOLT_UV_FAULT_V);
    }
  } else if (!uv_latched && v > VOLT_UV_FAULT_HYST_V) {
    fault_bits &= ~FAULT_BIT_UV;
    cnt_uv = 0;
  }

  // ── Stage 5: Warning detection ────────────────────────────────────

  uint8_t w = WARN_NONE;

  // OV warning (CEA +6%)
  bool ov_warn_cond = (v >= VOLT_OV_WARN_V && v < VOLT_OV_FAULT_V);
  if (debounce(ov_warn_cond, cnt_ov_w, warn_thresh))
    w |= WARN_OV;
  else if (v < VOLT_OV_WARN_HYST_V)
    cnt_ov_w = 0;

  // UV warning (CEA -6%) — suppressed during inrush (EC-09)
  bool uv_warn_cond =
      !uv_warn_blanked && (v <= VOLT_UV_WARN_V && v > VOLT_UV_FAULT_V);
  if (debounce(uv_warn_cond, cnt_uv_w, warn_thresh))
    w |= WARN_UV;
  else if (!uv_warn_blanked && v > VOLT_UV_WARN_HYST_V)
    cnt_uv_w = 0;

  // OC warning — suppressed during inrush blank
  bool oc_warn_cond =
      !oc_warn_blanked && (i >= CURR_OC_WARN_A && i < CURR_OC_FAULT_A);
  if (debounce(oc_warn_cond, cnt_oc_w, warn_thresh))
    w |= WARN_OC;
  else if (oc_warn_blanked || i < CURR_OC_WARN_HYST_A)
    cnt_oc_w = 0;

  // Thermal warning
  bool temp_warn_cond = (t >= TEMP_WARN_C && t < TEMP_FAULT_C);
  if (debounce(temp_warn_cond, cnt_temp_w, warn_thresh))
    w |= WARN_THERMAL;
  else if (t < TEMP_WARN_C - 5.0f)
    cnt_temp_w = 0;

  // Predictive: rising current trend (WARN_CURR_RISING)
  // Only active when:
  //   - Outside startup state (startup always has initially rising current)
  //   - Current is above 0.5A (above noise floor)
  //   - Slope is positive and above a physically meaningful rate
  //   - Current is not already in fault zone
  //
  // Finding #7 fix: threshold retuned from 0.05f (old broken units where
  // slope was Amps, not A/s — fired 20× too aggressively) to 2.0 A/s.
  // 2.0 A/s is a genuine load-increase trajectory: a step from 16A to
  // 21A (OC threshold) at this rate takes ~2.5s — meaningful warning
  // without triggering on normal load fluctuation.
  if (!startup_active && slope >= 2.0f && i > 0.5f && i < CURR_OC_FAULT_A) {
    w |= WARN_CURR_RISING;
  }

  warn_bits = w;

  // ── Periodic diagnostics ──────────────────────────────────────────
  // Log IDMT accumulator progress when approaching trip
  static uint32_t last_idmt_log_ms = 0;
  if (idmt_accumulator > 0.5f && (now - last_idmt_log_ms) > 1000) {
    LOG_FAULT_ENG("IDMT accumulator: %.3f / 1.000  "
                  "I=%.1fA  trip=%s",
                  idmt_accumulator, i,
                  idmt_accumulator >= 1.0f ? "TRIPPED" : "PENDING");
    last_idmt_log_ms = now;
  }
}

// ── Public accessors ──────────────────────────────────────────────────

// Returns the FaultType of the highest-priority active fault
FaultType getActiveFault() { return highestPriorityFault(); }

// Returns raw warning bitmask
uint8_t getWarnFlags() { return warn_bits; }

// Returns full multi-fault bitmask (for logging and dashboard)
uint16_t getActiveFaultBits() { return fault_bits; }

// True if any fault bit is set
bool hasFault() { return fault_bits != FAULT_BIT_NONE; }

// True if a LOCKOUT-class fault is active (sensor, thermal, SC, UV_INSTANT)
// FSM uses this to route directly to LOCKOUT bypassing auto-reclose.
// FAULT_BIT_SENSOR is P1 lockout: a blind protection system is worse than none.
// FAULT_BIT_UV_INSTANT added (NEW-02 fix): supply collapse (<150V) is motor-
// winding-destruction territory — no auto-reclose into a collapsed supply.
bool isLockoutClass() {
  return (fault_bits & FAULT_BIT_SENSOR) || (fault_bits & FAULT_BIT_THERMAL) ||
         (fault_bits & FAULT_BIT_SC) || (fault_bits & FAULT_BIT_UV_INSTANT);
}

// False helper for isInrushBlankActive to avoid breaking other files relying on
// old API
bool isInrushBlankActive() { return current_load_state == LOAD_STATE_STARTING; }

bool isVoltageRecoveryActive() { 
    return (current_load_state == LOAD_STATE_RUNNING) && (millis() - startup_exit_ms < 500);
}

void forceFilterState(float new_i) {
  // Direct overwrite, ignoring filter memory
  iir_i = new_i;
}

// Called by FSM when relay opens (fault cleared, relay opened)
// Resets IDMT accumulator (thermal cooling when load removed)
void clearLatched() {
  fault_bits &= ~(FAULT_BIT_OV | FAULT_BIT_UV | FAULT_BIT_OC_IDMT |
                  FAULT_BIT_SC | FAULT_BIT_OV_INSTANT);
  // Sensor fault and thermal fault NOT cleared here —
  // they require physical inspection (done by FSM LOCKOUT reset path)
  idmt_accumulator = 0.0f;
  cnt_ov = cnt_ov_instant = cnt_uv = cnt_uv_instant = cnt_sc = cnt_temp_fault =
      0;
  // BUG-FIX: Reset hysteresis latch state for cleared faults.
  // Without this, hyst_oc/ov/uv_active remains true after reclose.
  // On the NEXT fault the hysteresis immediately re-fires the fault bit
  // on first threshold crossing — completely bypassing IDMT/debounce again.
  hyst_ov_active = false;
  hyst_uv_active = false;
  hyst_oc_active = false;
  // Note: hyst_temp_active intentionally NOT cleared here —
  // thermal faults go to LOCKOUT and are cleared by clearAll() only.
  LOG_FAULT_ENG("latched faults cleared — IDMT accumulator reset");
}

// Full clear including sensor and thermal — called only from LOCKOUT reset
void clearAll() {
  fault_bits = FAULT_BIT_NONE;
  warn_bits = WARN_NONE;
  idmt_accumulator = 0.0f;
  cnt_ov = cnt_ov_instant = cnt_uv = cnt_uv_instant = cnt_sc = cnt_temp_fault =
      0;
  cnt_ov_w = cnt_uv_w = cnt_oc_w = cnt_temp_w = 0;
   
  LOG_FAULT_ENG("ALL faults cleared (LOCKOUT reset path)");
}

} // namespace FaultEngine
