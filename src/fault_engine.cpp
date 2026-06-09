// ============================================================
//  fault_engine.cpp — Production Protection Engine v3.0
//  IS 12360 / IEC 60255 compliant. 6-stage pipeline: pre-process →
//  sensor validation → instant fault → debounced fault → warnings →
//  hysteresis clear. Single-stage asymmetric IIR on protection path
//  (Finding #6/#20). See comments.md for full architecture docs.
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
int cnt_ov_instant = 0; // Stage 3: OV_INSTANT (>270V) — BUG-01: separate
                        // counter to prevent Stage 3/4 interference
int cnt_uv = 0;         // Stage 4: sustained UV fault debounce
int cnt_uv_instant = 0; // Stage 3: UV_INSTANT (<150V) — separate counter to
                        // prevent Stage 3/4 cross-contamination
int cnt_sc = 0; // SC debounce counter (ANSI 50 — short circuit instant trip)
int cnt_temp_fault = 0;
int cnt_ov_w = 0;
int cnt_uv_w = 0;
int cnt_oc_w = 0;
int cnt_temp_w = 0;

// ── Global System Time (HIL Time Dilation Fix) ─────────────────────────
uint32_t system_now_ms = 0;

// ── Multi-fault bitmask ────────────────────────────────────────────────
uint16_t fault_bits = FAULT_BIT_NONE; // active fault bitmask
uint8_t warn_bits = WARN_NONE;        // active warning bitmask

// ── Hysteresis latch state — fault stays active until dropout threshold
// cleared
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
uint32_t med_idx = 0; // Bug-1 fix: was uint8_t — wrapped every 256 calls,
                      // bypassing median filter

// ── Slope buffer (5 samples) ───────────────────────────────────────────
static constexpr int SLOPE_N = 5;
float slope_buf[SLOPE_N] = {};
int slope_idx = 0;
bool slope_full = false;

#if !HARDWARE_BENCH_TESTING
// ── Saturation tracking (EC-06) ────────────────────────────────────────
// Saturation = ADC reading stuck at 0 or 4095.
// We track how long the saturation condition persists.
uint32_t v_sat_start_ms = 0;
uint32_t i_sat_start_ms = 0;
bool v_was_sat = false;
bool i_was_sat = false;

// ── Frozen sensor tracking (EC-07) — uses raw ADC variance (not IIR-smoothed).
// EC-07 rev2: current channel requires FROZEN_I_CONSEC consecutive
// zero-variance windows (~2s) to avoid no-load false positives.
static constexpr int FROZEN_N = 20;
static constexpr int FROZEN_I_CONSEC = 200; // 200 ticks × 10ms = 2.0s
int frozen_v_buf[FROZEN_N] = {};
int frozen_i_buf[FROZEN_N] = {};
int frozen_idx = 0;
bool frozen_full = false;
int frozen_i_consec_cnt = 0;
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
  // Finding #7 + BUG-01: divide by time window (seconds), not sample count; use
  // correct oldest/newest indices.
  static constexpr float SLOPE_WINDOW_S = (SLOPE_N * SENSOR_LOOP_MS) / 1000.0f;
  int newest = (slope_idx + SLOPE_N - 1) % SLOPE_N;
  int oldest = slope_idx; // next-to-write = oldest in circular buffer
  return (slope_buf[newest] - slope_buf[oldest]) / SLOPE_WINDOW_S;
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

#if !HARDWARE_BENCH_TESTING
// Buffer variance for frozen sensor detection. Bug 7b: sample variance (÷ N-1,
// Bessel's correction).
float bufferVariance(const float *buf, int n) {
  if (n < 2)
    return 1.0f;
  float sum = 0.0f, sq = 0.0f;
  for (int k = 0; k < n; k++) {
    sum += buf[k];
    sq += buf[k] * buf[k];
  }
  float mean = sum / n;
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
  uint32_t now = (system_now_ms > 0) ? system_now_ms : millis();

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

  // Voltage frozen: flag immediately when variance is truly zero (hard-stuck
  // ADC). A stable 230V grid with real ADC noise never reaches exactly 0.
  if (var_v < 0.01f) {
    LOG_FAULT("SENSOR: frozen ADC (voltage) — raw_v_var=%.4f", var_v);
    return true;
  }

  // Current frozen: debounced across FROZEN_I_CONSEC consecutive ticks.
  // A no-load CT legitimately reads 0A (var≈0) until load is connected.
  // Only check for frozen current if the relay is actively LOADED.
  if (current_load_state != LOAD_STATE_IDLE && var_v >= 1.0f && var_i < 0.01f) {
    frozen_i_consec_cnt++;
    if (frozen_i_consec_cnt >= FROZEN_I_CONSEC) {
      LOG_FAULT("SENSOR: frozen ADC (current) — sustained %d ticks "
                "raw_v_var=%.2f raw_i_var=%.4f",
                frozen_i_consec_cnt, var_v, var_i);
      return true;
    }
  } else {
    frozen_i_consec_cnt = 0; // reset on any healthy reading or when idle
  }

  return false;
}

// EC-08: Physics impossibility cross-check
// Significant current flow while voltage reads near zero is impossible
// on AC mains — indicates at least one sensor has catastrophically failed.
bool checkPhysicsImpossibility(float v, float i) {
  if (i >= CURR_SC_RUNNING_INSTANT_A) {
    return false; // True dead short circuit, not a sensor failure
  }

  if (i >= SENSOR_PHYSICS_I_MIN && v < SENSOR_PHYSICS_V_MAX) {
    LOG_FAULT("SENSOR: physics impossibility — "
              "V=%.1fV I=%.2fA (impossible on AC mains)",
              v, i);
    return true;
  }
  return false;
}
#endif // !HARDWARE_BENCH_TESTING

// ── STAGE 3: IDMT ACCUMULATOR (IEC 60255 Standard Inverse) ────────────
// t(I) = TMS × k / ((I/Is)^α - 1). Trips at accumulator ≥ 1.0.
// EC-15: thermal memory decay below pickup. Reset on relay open.

void tickIDMT(float i_filtered, bool blank_active) {
  if (blank_active) {
    // BUG-06: preserve thermal memory during inrush blank (wire is still warm)
    return;
  }

  if (i_filtered < IDMT_IS) {
    // Below pickup: thermal memory decay (EC-15)
    idmt_accumulator *= IDMT_ACCUMULATOR_DECAY;
    if (idmt_accumulator < 0.0f)
      idmt_accumulator = 0.0f;
    return;
  }

  // Above or equal to pickup: increment accumulator
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

// ── HYSTERESIS HELPERS ── pickup/dropout prevents relay chattering at
// thresholds

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

  // Reset hysteresis state on init (survive warm reboot via ESP.restart())
  hyst_ov_active = false;
  hyst_uv_active = false;
  hyst_oc_active = false;
  hyst_temp_active = false;

  // Reset buffers
  memset(slope_buf, 0, sizeof(slope_buf));
  memset(med_buf, 0, sizeof(med_buf));
#if !HARDWARE_BENCH_TESTING
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
  uint32_t now = (system_now_ms > 0) ? system_now_ms : millis();
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
  uint32_t now = (system_now_ms > 0) ? system_now_ms : millis();
  lockout_dob_timer_ms = now + duration_ms;
  LOG_FAULT_ENG("DOB Lockout initiated for %ums", duration_ms);
}

bool isInLockoutDOB() {
  uint32_t now = (system_now_ms > 0) ? system_now_ms : millis();
  return (lockout_dob_timer_ms > 0 && now < lockout_dob_timer_ms);
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
void evaluate(float v, float raw_i_phys, float t, int raw_v_int, int raw_i_int,
              uint32_t spoofed_now_ms, bool force_resistive) {

  system_now_ms = (spoofed_now_ms > 0) ? spoofed_now_ms : millis();
  uint32_t now = system_now_ms;

  // ── Stage 1: Signal pre-processing ───────────────────────────────

  // 3-sample median on raw current (reject single-sample EMI spikes)
  med_buf[med_idx % 3] = raw_i_phys;
  med_idx++;
  bool med_ready = (med_idx >= 3);
  float i_med =
      med_ready ? median3(med_buf[0], med_buf[1], med_buf[2]) : raw_i_phys;

  // Asymmetric IIR: α_rise=0.90 (catches 30A fault in 1 sample per IEC
  // 60255-151), α_fall=0.10 (rejects transients)
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
#if !HARDWARE_BENCH_TESTING
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

  // Universal safety override: If ANY fault is latched, force the load state to
  // FAULT. This ensures short circuit debouncing has adequate time to trigger
  // before the state machine raises limits to protect opening relays.
  if (fault_bits != FAULT_NONE && current_load_state != LOAD_STATE_FAULT) {
    current_load_state = LOAD_STATE_FAULT;
    initiateLockout(T_LOCKOUT_DOB_MS);
  }

  switch (current_load_state) {
  case LOAD_STATE_IDLE:
    if (i > CURR_IDLE_LIMIT_A) {
      if (force_resistive) {
        current_load_state = LOAD_STATE_RUNNING;
        LOG_FAULT_ENG("LOAD_STATE_IDLE -> RUNNING (Resistive overload forced)");
      } else {
        current_load_state = LOAD_STATE_STARTING;
        load_state_timer_ms = now;
        // BUG-13: Set startup_active on transition tick to protect first inrush
        // sample
        startup_active = true;
        LOG_FAULT_ENG("LOAD_STATE_IDLE -> STARTING (Motor Inrush active)");
      }
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
      // to prevent false escalation to SC INSTANT due to relay delay (90A >
      // 27A).
      instant_trip_threshold = CURR_SC_STARTUP_INSTANT_A;
    } else {
      instant_trip_threshold = CURR_SC_STARTUP_INSTANT_A;
    }
    break;

  case LOAD_STATE_RUNNING:
    // Only drop to IDLE if motor stopped. We no longer eagerly
    // jump to FAULT here based purely on `i` because it preempts SC debouncing.
    if (i < CURR_IDLE_LIMIT_A) {
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

  // UV_INSTANT <150V — supply collapse → LOCKOUT. Muted during first 1000ms
  // (IIR boot convergence from 0V→230V).
#if HARDWARE_BENCH_TESTING
  // Bench mode: 100ms mute — skip IIR boot convergence only
  const uint32_t uv_mute_ms = 100;
#else
  const uint32_t uv_mute_ms = 1000;
#endif
  if (now >= uv_mute_ms && debounce(v <= VOLT_UV_INSTANT_V, cnt_uv_instant,
                                    FAULT_DEBOUNCE_INSTANT)) {
    if (!(fault_bits & FAULT_BIT_UV_INSTANT)) {
      fault_bits |= FAULT_BIT_UV_INSTANT;
      LOG_FAULT("UV_INSTANT: V=%.1fV ≤ %.0fV — supply collapse → LOCKOUT", v,
                VOLT_UV_INSTANT_V);
    }
  }

  // P2: Short circuit ANSI 50 (EC-11)
  // Hard limit check (120A catastrophic always active)
  if (i >= CURR_SC_HARD_A) {
    if (!(fault_bits & FAULT_BIT_SC)) {
      fault_bits |= FAULT_BIT_SC;
      LOG_FAULT("SC HARD: I=%.1fA ≥ %.0fA → LOCKOUT", i, CURR_SC_HARD_A);
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
  bool ov_already_set = (bool)(fault_bits & FAULT_BIT_OV);
  bool ov_latched = ov_already_set && hysteresisOV(v);
  if (ov_pickup || ov_latched) {
    if (!(fault_bits & FAULT_BIT_OV)) {
      fault_bits |= FAULT_BIT_OV;
      LOG_FAULT("OV: V=%.1fV ≥ %.0fV (IS 12360 +10%%)", v, VOLT_OV_FAULT_V);
    }
  } else {
    fault_bits &= ~FAULT_BIT_OV;
  }

  // P6: IDMT overcurrent ANSI 51
  // Accumulator ticks when I > IDMT_IS (= CURR_OC_FAULT_A)
  // Suppressed during motor STARTING phase
  tickIDMT(i, startup_active);

  // BUG-FIX: hysteresis only SUSTAINS faults already tripped by IDMT (prevents
  // bypassing time-inverse curve)
  bool oc_idmt_fired = (idmt_accumulator >= 1.0f);
  bool oc_already_set = (bool)(fault_bits & FAULT_BIT_OC_IDMT);
  bool oc_latched = oc_already_set && hysteresisOC(i); // sustain only
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
      hyst_oc_active = false; // reset sustain latch when fault fully clears
    }
    fault_bits &= ~FAULT_BIT_OC_IDMT;
  }

  // P4: Thermal limit (EC-12)
  // Hysteresis: fault holds until temp drops below TEMP_FAULT_HYST_C
  bool temp_pickup = debounce(t >= TEMP_FAULT_C, cnt_temp_fault, fault_thresh);
  bool temp_already_set = (bool)(fault_bits & FAULT_BIT_THERMAL);
  bool temp_latched = temp_already_set && hysteresisTemp(t);
  if (temp_pickup || temp_latched) {
    if (!(fault_bits & FAULT_BIT_THERMAL)) {
      fault_bits |= FAULT_BIT_THERMAL;
      LOG_FAULT("THERMAL: T=%.1f°C ≥ %.0f°C → LOCKOUT", t, TEMP_FAULT_C);
    }
  } else {
    fault_bits &= ~FAULT_BIT_THERMAL;
  }

  // P7: Sustained undervoltage — IS 12360 -10%
  // Conditional Blanking (Two-Tier Masking) Fix
  bool voltage_recovery_active =
      (!startup_active && (now - startup_exit_ms < 500));
  bool uv_condition;
  if (startup_active || voltage_recovery_active) {
    // During motor startup + 500ms math bleed-off: Expand tolerance to 170V.
    uv_condition = (v <= VOLT_UV_STARTUP_V);
  } else {
    // Normal state: 207V threshold
    uv_condition = (v <= VOLT_UV_FAULT_V);
  }
  bool uv_pickup = debounce(uv_condition, cnt_uv, fault_thresh);
  bool uv_already_set = (bool)(fault_bits & FAULT_BIT_UV);
  bool uv_latched = uv_already_set && hysteresisUV(v) &&
                    !(startup_active || voltage_recovery_active);

  if (now >= uv_mute_ms && (uv_pickup || uv_latched)) {
    if (!(fault_bits & FAULT_BIT_UV)) {
      fault_bits |= FAULT_BIT_UV;
      LOG_FAULT("UV: V=%.1fV ≤ %.0fV (IS 12360 -10%%)", v, VOLT_UV_FAULT_V);
    }
  } else {
    fault_bits &= ~FAULT_BIT_UV;
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
  // Finding #7: threshold retuned to 2.0 A/s (was 0.05 in broken Amps units)
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

// True if a LOCKOUT-class fault is active (sensor/thermal/SC/UV_INSTANT — no
// auto-reclose)
bool isLockoutClass() {
  return (fault_bits & FAULT_BIT_SENSOR) || (fault_bits & FAULT_BIT_THERMAL) ||
         (fault_bits & FAULT_BIT_SC) || (fault_bits & FAULT_BIT_UV_INSTANT);
}

// False helper for isInrushBlankActive to avoid breaking other files relying on
// old API
bool isInrushBlankActive() { return current_load_state == LOAD_STATE_STARTING; }

bool isVoltageRecoveryActive() {
  uint32_t now = (system_now_ms > 0) ? system_now_ms : millis();
  return (current_load_state == LOAD_STATE_RUNNING) &&
         (now - startup_exit_ms < 500);
}

void forceFilterState(float new_i) {
  // Direct overwrite, ignoring filter memory
  iir_i = new_i;
}

// Called by FSM when relay opens (fault cleared, relay opened)
// Resets IDMT accumulator (thermal cooling when load removed)
void clearLatched() {
  fault_bits &= ~(FAULT_BIT_OV | FAULT_BIT_UV | FAULT_BIT_OC_IDMT |
                  FAULT_BIT_SC | FAULT_BIT_OV_INSTANT | FAULT_BIT_UV_INSTANT);
  // Sensor fault and thermal fault NOT cleared here —
  // they require physical inspection (done by FSM LOCKOUT reset path)
  idmt_accumulator = 0.0f;
  cnt_ov = cnt_ov_instant = cnt_uv = cnt_uv_instant = cnt_sc = cnt_temp_fault =
      0;
  cnt_ov_w = cnt_uv_w = cnt_oc_w = cnt_temp_w = 0;
  // Reset hysteresis latch state so next fault goes through proper
  // IDMT/debounce
  hyst_ov_active = false;
  hyst_uv_active = false;
  hyst_oc_active = false;
  // hyst_temp_active NOT cleared — thermal faults go to LOCKOUT, cleared by
  // clearAll() only
  LOG_FAULT_ENG("latched faults cleared — IDMT accumulator reset");
}

// Full clear including sensor and thermal — called only from LOCKOUT reset
void clearAll() {
  fault_bits = FAULT_BIT_NONE;
  warn_bits = WARN_NONE;
  idmt_accumulator = 0.0f;
  cnt_ov_w = cnt_uv_w = cnt_oc_w = cnt_temp_w = 0;
  cnt_uv_instant = cnt_temp_fault = cnt_ov_instant = cnt_uv = cnt_ov = cnt_sc =
      0;

  hyst_ov_active = false;
  hyst_uv_active = false;
  hyst_oc_active = false;
  hyst_temp_active = false;

  lockout_dob_timer_ms = 0;
  current_load_state = LOAD_STATE_IDLE;

  iir_i = 0.0f;
  med_idx = 0;

#if !HARDWARE_BENCH_TESTING
  // Reset frozen-ADC ring buffers to prevent stale zero-variance data from
  // triggering false lockout
  frozen_idx = 0;
  frozen_full = false;
  frozen_i_consec_cnt = 0;
  for (int k = 0; k < FROZEN_N; k++) {
    frozen_v_buf[k] = 2048; // mid-scale — represents a live, non-frozen signal
    frozen_i_buf[k] = 2048;
  }
  // Also reset saturation timers
  v_was_sat = false;
  i_was_sat = false;
  v_sat_start_ms = 0;
  i_sat_start_ms = 0;
#endif

  LOG_FAULT_ENG("ALL faults cleared (LOCKOUT reset path)");
}

} // namespace FaultEngine
