// ============================================================
//  fsm.cpp — Self-Healing Protection FSM
//  REVISION: 3.0 — Indian Grid / IS 12360 Compliance
//
//  STATE DIAGRAM:
//
//  BOOT ──(1s warm-up)──► NORMAL
//
//  NORMAL ──(any warn)──► WARNING
//  NORMAL ──(any fault)──► FAULT or LOCKOUT
//
//  WARNING ──(faults clear)──► NORMAL
//  WARNING ──(fault escalates)──► FAULT or LOCKOUT
//
//  FAULT ──(lockout-class fault)──────────────────────► LOCKOUT
//  FAULT ──(auto-reclose timer expires, V stable)──► RECOVERY
//  FAULT ──(API reset, temp guard OK)──────────────► RECOVERY
//
//  RECOVERY ──(voltage stable 500ms, no fault)──► NORMAL
//  RECOVERY ──(fault re-asserts)──────────────► FAULT → (escalate)
//
//  LOCKOUT ──(API reset, temp guard OK, sensor OK)──► RECOVERY
//
//  AUTO-RECLOSE DEAD TIMES (escalating — Section 7):
//    Trip 1 → RECLOSE_DELAY_1_MS (5s)
//    Trip 2 → RECLOSE_DELAY_2_MS (15s)
//    Trip 3 → RECLOSE_DELAY_3_MS (30s) then LOCKOUT
//
//  LOCKOUT BYPASS (direct to LOCKOUT, no auto-reclose):
//    FAULT_BIT_THERMAL  → fire risk, physical inspection required
//    FAULT_BIT_SC       → possible wiring damage, inspect before re-energise
//    FAULT_BIT_SENSOR   → cannot protect without sensors
//    DS18B20 disconnect → thermal blind, cannot operate safely (EC-05)
//
//  RECOVERY VALIDATION:
//    Before relay re-closes, voltage must hold within
//    VOLT_RECOVERY_LO..HI (±5% of 230V = 218.5–241.5V)
//    for VOLT_RECOVERY_CONFIRM_N consecutive samples (500ms).
//    If voltage drifts out during confirmation, timer restarts.
//
//  EDGE CASES:
//    EC-04  DS18B20 +85°C boot sentinel: FSM waits DS18B20_BOOT_IGNORE_MS
//           before trusting temperature readings
//    EC-05  DS18B20 -127°C disconnect: triggers LOCKOUT from ANY state,
//           even NORMAL or RECOVERY — restored by BUG-05 fix
//    EC-12  Thermal fault: routes to LOCKOUT, skips auto-reclose
//    EC-13  SC fault: routes to LOCKOUT, skips auto-reclose
//    EC-14  Recovery voltage hysteresis: prevents reclose into unstable grid
// ============================================================
#include "fsm.h"
#include "adc_sampler.h" // getRawCurrentPhys() for severity computation
#include "config.h"
#include "ds18b20.h"
#include "fault_engine.h"
#include "nvs_log.h"
#include "serial_log.h"
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

namespace {
FSMContext ctx;
SemaphoreHandle_t mtx = nullptr;

// ── Recovery voltage confirmation state ───────────────────────────────
// Tracks consecutive samples where voltage is in the stable recovery band
int recovery_v_confirm_count = 0;

// ── Adaptive severity state tracking ──────────────────────────────────
// Computed dynamically during NORMAL -> FAULT transition based on grid severity
// Replaces static RECLOSE_DELAYS_MS array.

// ── Safe context copy under mutex ─────────────────────────────────────
FSMContext snapshot() {
  FSMContext c = {};
  if (xSemaphoreTake(mtx, pdMS_TO_TICKS(5)) == pdTRUE) {
    c = ctx;
    xSemaphoreGive(mtx);
  }
  return c;
}

// ── State transition ──────────────────────────────────────────────────
void transition(FSMState to, FaultType ft = FAULT_NONE) {
  FSMState from = ctx.state;
  ctx.state = to;
  ctx.fault_type = ft;

  LOG_FSM("%s → %s  fault=%s  trips=%d", fsmStateName(from), fsmStateName(to),
          faultTypeName(ft), ctx.trip_count);

  // Log every transition to NVS ring buffer
  NVSLog::append({millis(), to, ft, 0.0f, fsmStateName(to)});

  // Reset recovery confirmation counter on any transition
  recovery_v_confirm_count = 0;
}

// ── Check if current voltage is in recovery-safe band ─────────────────
// Returns true when voltage has been in the ±5% band long enough
bool voltageStableForRecovery(float v) {
  bool in_band = (v >= VOLT_RECOVERY_LO_V && v <= VOLT_RECOVERY_HI_V);
  if (in_band) {
    if (++recovery_v_confirm_count >= VOLT_RECOVERY_CONFIRM_N) {
      return true; // stable enough to re-close
    }
  } else {
    // Voltage drifted out — restart confirmation window
    if (recovery_v_confirm_count > 0) {
      LOG_FSM("Recovery V confirmation reset: "
              "V=%.1fV out of band [%.1f-%.1f]",
              v, VOLT_RECOVERY_LO_V, VOLT_RECOVERY_HI_V);
    }
    recovery_v_confirm_count = 0;
  }
  return false;
}

} // namespace

namespace FSM {

// ── earlyInit ─────────────────────────────────────────────────────────────
// NEW-13 fix: the FSM mutex must exist before the HTTP server starts
// accepting connections, because API handlers call requestReset() and
// getContext() which both take the mutex.  FSM::init() is called later
// from task_protection on Core 0, potentially hundreds of milliseconds
// after g_server.begin() — leaving a window where xSemaphoreTake(nullptr)
// causes UB in release builds.
//
// earlyInit() is called from setup() before g_server.begin().
// init() checks whether the mutex was already created and skips
// re-creation to stay idempotent.
void earlyInit() {
  if (mtx == nullptr) {
    mtx = xSemaphoreCreateMutex();
  }
  if (mtx == nullptr) {
    LOG_FSM("FATAL: earlyInit mutex alloc failed — rebooting");
    ESP.restart();
  }
  LOG_FSM("earlyInit — mutex ready");
}

void init() {
  // Mutex may already have been created by earlyInit() — only allocate once.
  if (mtx == nullptr) {
    mtx = xSemaphoreCreateMutex();
  }
  // BUG-16 / NEW-13 FIX: crash loudly on heap exhaustion so the root cause
  // is obvious rather than silently passing nullptr to xSemaphoreTake().
  if (mtx == nullptr) {
    LOG_FSM("FATAL: xSemaphoreCreateMutex failed — heap exhausted");
    ESP.restart();
  }
  ctx = {FSM_BOOT, FAULT_NONE, WARN_NONE, 0, 0, 0, 0, false};
  recovery_v_confirm_count = 0;
  LOG_FSM("v3.0 init — IS 12360 / IEC 60255 escalating reclose");
}

// ── Main tick — called every SENSOR_LOOP_MS from Core-0 task ──────────
//
//  Parameters:
//    temp_c   : current temperature (from DS18B20::getTemp())
//    voltage_v: current voltage (from ADCSampler::getVoltage())
//               used for recovery band confirmation
void tick(float temp_c, float voltage_v, uint32_t now_ms) {

  // NEW-13 safety guard: earlyInit() should have created the mutex before
  // the HTTP server started, but guard here too — belt-and-suspenders.
  if (mtx == nullptr)
    return;

  if (xSemaphoreTake(mtx, pdMS_TO_TICKS(10)) != pdTRUE)
    return;

  // BUG-18 FIX: When now_ms is non-zero (HIL accelerator loop), use the
  // provided simulated time. When 0 (normal real-time path), use millis().
  uint32_t now = (now_ms > 0) ? now_ms : millis();
  FaultType ft = FaultEngine::getActiveFault();
  uint8_t warns = FaultEngine::getWarnFlags();
  bool any_fault = FaultEngine::hasFault();
  bool any_warn = (warns != WARN_NONE);

  ctx.warn_flags = warns;

  // EC-05: DS18B20 disconnect — LOCKOUT from ANY state.
  // FIX NEW-01: The previous attempt (BUG-05) checked temp_c against
  // DS18B20_SENTINEL_DISC (-127°C), but DS18B20::getTemp() never returns
  // -127°C — it returns last_valid_temp, which is only written in the
  // STATE_VALID branch and is explicitly preserved on disconnect (see
  // ds18b20.cpp: "last_valid_temp unchanged — preserve last known reading").
  // The sentinel is fully filtered by the driver before reaching this point.
  // DS18B20::isDisconnected() is the correct signal: it is maintained by
  // the driver's debounce logic (3 consecutive -127°C reads = 2.4s).
  // FIX START
  if (DS18B20::isDisconnected()) {
    if (ctx.state != FSM_LOCKOUT) {
      LOG_FSM("EC-05: DS18B20 disconnected → LOCKOUT");
      transition(FSM_LOCKOUT, FAULT_SENSOR);
    }
    xSemaphoreGive(mtx);
    return;
  }
  // FIX END

  // FIX Bug-2: consume DS18B20 reconnect flag.
  // ds18b20.cpp sets sensor_reconnected=true on recovery and requires the
  // caller to invoke clearReconnectedFlag() after logging.  This was never
  // done, so after the first disconnect-reconnect wasReconnected() returned
  // true permanently and the reconnection event was never written to NVS.
  if (DS18B20::wasReconnected()) {
    LOG_FSM("EC-05: DS18B20 reconnected — logging event");
    NVSLog::append(
        {millis(), ctx.state, FAULT_NONE, 0.0f, "DS18B20_RECONNECTED"});
    DS18B20::clearReconnectedFlag();
  }

  // ══════════════════════════════════════════════════════════════════
  //  STATE MACHINE
  // ══════════════════════════════════════════════════════════════════
  switch (ctx.state) {

  // ── BOOT ─────────────────────────────────────────────────────
  // Waits for sensors to stabilise. DS18B20 boot ignore window
  // (EC-04) is enforced in ds18b20.cpp — we simply wait until
  // DS18B20::isReady() returns true before trusting temperature.
  // Minimum 1s always enforced (ADC IIR convergence).
  case FSM_BOOT: {
    bool adc_ready = (now >= 1000);
    bool temp_ready =
        DS18B20::isReady() || (now >= DS18B20_BOOT_IGNORE_MS + 500);
    if (adc_ready && temp_ready) {
      LOG_FSM("BOOT complete — T=%.1f°C  V=%.1fV", temp_c, voltage_v);
      // Flush any fault bits accumulated during the ADC IIR settling
      // and DS18B20 boot-sentinel window. Without this, a UV_INSTANT
      // at raw=0 (before IIR converges) survives into NORMAL and causes
      // an immediate nuisance trip before the inrush blank can arm on
      // the first relay close. clearLatched() (not clearAll()) is used
      // so hysteresis state is preserved for signals genuinely out-of-range.
      FaultEngine::clearLatched();
      transition(FSM_NORMAL);
    }
    break;
  }

  // ── NORMAL ───────────────────────────────────────────────────
  case FSM_NORMAL: {
    if (any_fault) {
      ctx.trip_count++;
      ctx.fault_ts_ms = now;

      // Lockout-class faults (thermal, SC, sensor) bypass reclose
      if (FaultEngine::isLockoutClass() || ctx.trip_count > MAX_TRIP_COUNT) {
        LOG_FSM("NORMAL → LOCKOUT (fault=%s, trips=%d, "
                "lockout_class=%s)",
                faultTypeName(ft), ctx.trip_count,
                FaultEngine::isLockoutClass() ? "YES" : "NO");
        transition(FSM_LOCKOUT, ft);
      } else {
        // ── Compute Severity & Adaptive Delay ──
        // BUG-FIX: getCurrent() returns the IIR+MA smoothed display value.
        // At the moment of NORMAL→FAULT transition the relay has just
        // been determined to trip — the IIR may still be at its previous
        // steady-state value (especially with Phantom Grid where the
        // injected value is applied one tick before this path runs).
        // getRawCurrentPhys() is the pre-IIR protection path value —
        // the same signal FaultEngine tripped on — so it reflects
        // the actual fault magnitude.
        float i = ADCSampler::getRawCurrentPhys();
        float severity_I = (i > RATED_CURRENT_A)
                               ? (i - RATED_CURRENT_A) / RATED_CURRENT_A
                               : 0.0f;

        float severity_V = 0.0f;
        if (voltage_v > VOLT_OV_FAULT_V) {
          severity_V =
              (voltage_v - VOLT_OV_FAULT_V) / (NOMINAL_VOLTAGE_V * 0.10f);
        } else if (voltage_v < VOLT_UV_FAULT_V) {
          severity_V =
              (VOLT_UV_FAULT_V - voltage_v) / (NOMINAL_VOLTAGE_V * 0.10f);
        }

        float severity = fmaxf(severity_I, severity_V);
        uint32_t base_delay = DELAY_MILD_MS;
        if (severity >= 2.5f)
          base_delay = DELAY_SEVERE_MS;
        else if (severity >= 1.5f)
          base_delay = DELAY_MODERATE_MS;

        // Exponential backoff: base_delay * 2^(trip_count - 1)
        int backoff_shift = ctx.trip_count - 1;
        if (backoff_shift < 0)
          backoff_shift = 0;
        if (backoff_shift > 3)
          backoff_shift = 3;

        ctx.active_delay_ms = base_delay * (1 << backoff_shift);
        ctx.target_reclose_ms = now + ctx.active_delay_ms;

        LOG_FSM("ADAPTIVE DELAY: severity=%.2f (I=%.2f, V=%.2f) -> base=%ums, "
                "final=%ums",
                severity, severity_I, severity_V, (unsigned)base_delay,
                (unsigned)ctx.active_delay_ms);

        transition(FSM_FAULT, ft);
      }
    } else if (any_warn) {
      transition(FSM_WARNING);
    }
    break;
  }

  // ── WARNING ──────────────────────────────────────────────────
  case FSM_WARNING: {
    if (any_fault) {
      ctx.trip_count++;
      ctx.fault_ts_ms = now;

      if (FaultEngine::isLockoutClass() || ctx.trip_count > MAX_TRIP_COUNT) {
        transition(FSM_LOCKOUT, ft);
      } else {
        // WARNING→FAULT: apply the same severity-based delay as NORMAL→FAULT.
        // Previously this always used DELAY_MILD_MS regardless of fault
        // magnitude — an OV_INSTANT escalating from WARNING got the same
        // short delay as a minor transient. Now uses shared severity logic.
        float i = ADCSampler::getRawCurrentPhys();
        float severity_I = (i > RATED_CURRENT_A)
                               ? (i - RATED_CURRENT_A) / RATED_CURRENT_A
                               : 0.0f;
        float severity_V = 0.0f;
        if (voltage_v > VOLT_OV_FAULT_V)
          severity_V =
              (voltage_v - VOLT_OV_FAULT_V) / (NOMINAL_VOLTAGE_V * 0.10f);
        else if (voltage_v < VOLT_UV_FAULT_V)
          severity_V =
              (VOLT_UV_FAULT_V - voltage_v) / (NOMINAL_VOLTAGE_V * 0.10f);
        float severity = fmaxf(severity_I, severity_V);
        uint32_t base_delay = DELAY_MILD_MS;
        if (severity >= 2.5f)
          base_delay = DELAY_SEVERE_MS;
        else if (severity >= 1.5f)
          base_delay = DELAY_MODERATE_MS;

        int backoff_shift = ctx.trip_count - 1;
        if (backoff_shift < 0)
          backoff_shift = 0;
        if (backoff_shift > 3)
          backoff_shift = 3;
        ctx.active_delay_ms = base_delay * (1 << backoff_shift);
        ctx.target_reclose_ms = now + ctx.active_delay_ms;

        LOG_FSM("ADAPTIVE DELAY (from WARNING): severity=%.2f -> base=%ums, "
                "final=%ums",
                severity, (unsigned)base_delay, (unsigned)ctx.active_delay_ms);
        transition(FSM_FAULT, ft);
      }
    } else if (!any_warn) {
      transition(FSM_NORMAL);
      FaultEngine::clearLatched();
    }
    break;
  }

  // ── FAULT ────────────────────────────────────────────────────
  // Two paths out:
  //   A) Manual reset via API (immediate, if temp guard OK)
  //   B) Auto-reclose after escalating dead time
  //
  // Before entering RECOVERY, voltage must be in stable band.
  // The dead-time wait is the minimum — voltage confirmation
  // may extend the wait if grid is still disturbed.
  case FSM_FAULT: {

    // Check if fault escalated to lockout class AFTER entering FAULT
    // (e.g. temperature rose above TEMP_FAULT_C while in FAULT state)
    if (FaultEngine::isLockoutClass()) {
      LOG_FSM("FAULT → LOCKOUT: lockout-class fault escalated");
      transition(FSM_LOCKOUT, ft);
      break;
    }

    // Path A: Manual reset via API
    if (ctx.reset_requested) {
      ctx.reset_requested = false;
      if (temp_c >= TEMP_RESET_BLOCK_C) {
        LOG_FSM("RESET BLOCKED: T=%.1f°C ≥ %.0f°C\n", temp_c,
                TEMP_RESET_BLOCK_C);
      } else if (FaultEngine::isInLockoutDOB()) {
        LOG_FSM("RESET BLOCKED: Delay On Break (DOB) active. Compressor "
                "equalize required.");
        // Keep the reset request pending or just discard it? Better discard so
        // user has to try again.
      } else {
        LOG_FSM("Manual reset → RECOVERY");
        ctx.target_reclose_ms = now;
        recovery_v_confirm_count = 0;
        transition(FSM_RECOVERY, ft);
        FaultEngine::clearLatched();
      }
      break;
    }

    // Path B: Auto-reclose after escalating dead time
    uint32_t delay = ctx.active_delay_ms;

    if (now >= ctx.target_reclose_ms) {
      if (temp_c >= TEMP_RESET_BLOCK_C) {
        // Temperature too high — delay reclose until cooled
        LOG_FSM("Auto-reclose blocked: T=%.1f°C ≥ %.0f°C", temp_c,
                TEMP_RESET_BLOCK_C);
      } else if (FaultEngine::isInLockoutDOB()) {
        // DOB is active — delay reclose
        LOG_FSM("Auto-reclose blocked: DOB Lockout active");
      } else {
        LOG_FSM("Auto-reclose entering observation window (trip %d)",
                ctx.trip_count);
        ctx.target_reclose_ms = now;
        recovery_v_confirm_count = 0;
        transition(FSM_RECOVERY, ft);
        FaultEngine::clearLatched();
      }
    } else {
      // Log countdown every 5 seconds
      static uint32_t last_fault_log_ms = 0;
      if (now - last_fault_log_ms >= 5000) {
        LOG_FSM("FAULT: reclose in %ums "
                "(trip %d/%d, delay=%ums)",
                (unsigned)(ctx.target_reclose_ms - now), ctx.trip_count, MAX_TRIP_COUNT,
                (unsigned)delay);
        last_fault_log_ms = now;
      }
    }
    break;
  }

  // ── RECOVERY ─────────────────────────────────────────────────
  // Relay has been re-closed (or will be closed by RelayControl).
  // Wait for:
  //   1. Minimum 500ms for sensors to settle after re-energisation
  //   2. Voltage to stabilise in ±5% band for VOLT_RECOVERY_CONFIRM_N
  //      consecutive samples (EC-14: recovery validation)
  //
  // If a fault re-asserts → re-trip (increment trip counter)
  // If trip counter exhausted → LOCKOUT
  case FSM_RECOVERY: {
    uint32_t settle_elapsed = now - ctx.target_reclose_ms;

    if (settle_elapsed < 500) {
      // Sensor settle time — do not evaluate faults yet
      break;
    }

    if (any_fault) {
      // Fault still present / re-tripped → increment counter
      ctx.trip_count++;
      ctx.fault_ts_ms = now;

      LOG_FSM("RECOVERY re-trip: fault=%s  trip=%d/%d", faultTypeName(ft),
              ctx.trip_count, MAX_TRIP_COUNT);

      if (FaultEngine::isLockoutClass() || ctx.trip_count > MAX_TRIP_COUNT) {
        transition(FSM_LOCKOUT, ft);
      } else {
        // BUG-A1 FIX: Recalculate adaptive delay on re-trip.
        // Previously only fault_ts_ms was updated — active_delay_ms and
        // target_reclose_ms were stale from trip 1. The FSM immediately
        // saw now >= target_reclose_ms and re-entered RECOVERY, causing
        // rapid oscillation instead of the expected escalating dead time.
        float i = ADCSampler::getRawCurrentPhys();
        float severity_I = (i > RATED_CURRENT_A)
                               ? (i - RATED_CURRENT_A) / RATED_CURRENT_A
                               : 0.0f;
        float severity_V = 0.0f;
        if (voltage_v > VOLT_OV_FAULT_V)
          severity_V =
              (voltage_v - VOLT_OV_FAULT_V) / (NOMINAL_VOLTAGE_V * 0.10f);
        else if (voltage_v < VOLT_UV_FAULT_V)
          severity_V =
              (VOLT_UV_FAULT_V - voltage_v) / (NOMINAL_VOLTAGE_V * 0.10f);
        float severity = fmaxf(severity_I, severity_V);
        uint32_t base_delay = DELAY_MILD_MS;
        if (severity >= 2.5f)
          base_delay = DELAY_SEVERE_MS;
        else if (severity >= 1.5f)
          base_delay = DELAY_MODERATE_MS;

        int backoff_shift = ctx.trip_count - 1;
        if (backoff_shift < 0) backoff_shift = 0;
        if (backoff_shift > 3) backoff_shift = 3;
        ctx.active_delay_ms   = base_delay * (1 << backoff_shift);
        ctx.target_reclose_ms = now + ctx.active_delay_ms;

        LOG_FSM("RECOVERY re-trip ADAPTIVE DELAY: severity=%.2f -> "
                "base=%ums, final=%ums",
                severity, (unsigned)base_delay,
                (unsigned)ctx.active_delay_ms);

        transition(FSM_FAULT, ft);
      }
      break;
    }

    // No fault active — confirm voltage stability before declaring NORMAL
    // EC-14: prevents re-closing into still-disturbed grid
    if (voltageStableForRecovery(voltage_v)) {
      LOG_FSM("RECOVERY complete: V=%.1fV stable "
              "for %d samples — returning to NORMAL",
              voltage_v, VOLT_RECOVERY_CONFIRM_N);
      ctx.trip_count = 0;
      transition(FSM_NORMAL);
      FaultEngine::clearLatched();
    } else {
      // Still confirming — log progress every 2s
      static uint32_t last_rec_log_ms = 0;
      if (now - last_rec_log_ms >= 2000) {
        LOG_FSM("RECOVERY: V=%.1fV confirm=%d/%d "
                "band=[%.1f-%.1f]",
                voltage_v, recovery_v_confirm_count,
                VOLT_RECOVERY_CONFIRM_N,
                VOLT_RECOVERY_LO_V, VOLT_RECOVERY_HI_V);
        last_rec_log_ms = now;
      }
    }
    break;
  }

  // ── LOCKOUT ───────────────────────────────────────────────────
  // Terminal state. Only exits via:
  //   1. Manual API reset
  //   2. Temperature below TEMP_RESET_BLOCK_C
  //
  // Physical inspection SHOULD be performed before resetting.
  case FSM_LOCKOUT: {
    if (!ctx.reset_requested)
      break;

    ctx.reset_requested = false;

    // Block reset if temperature is still high
    if (temp_c >= TEMP_RESET_BLOCK_C) {
      LOG_FSM("LOCKOUT RESET BLOCKED: T=%.1f°C ≥ %.0f°C", temp_c,
              TEMP_RESET_BLOCK_C);
      break;
    }

    // Block reset if DOB still active
    if (FaultEngine::isInLockoutDOB()) {
      LOG_FSM("LOCKOUT RESET BLOCKED: Delay On Break (DOB) active");
      break;
    }

    // All guards passed — allow reset
    LOG_FSM("LOCKOUT reset approved — entering RECOVERY");
    FaultEngine::clearAll();
    ctx.trip_count = 0;
    ctx.active_delay_ms = 0;
    ctx.target_reclose_ms = now;
    recovery_v_confirm_count = 0;
    transition(FSM_RECOVERY);
    break;
  }

  } // switch

  xSemaphoreGive(mtx);
}

FSMContext getContext() { return snapshot(); }

void requestReset() {
  // NEW-13: guard against early HTTP request arriving before init()
  if (mtx == nullptr)
    return;
  if (xSemaphoreTake(mtx, pdMS_TO_TICKS(10)) == pdTRUE) {
    ctx.reset_requested = true;
    xSemaphoreGive(mtx);
    LOG_FSM("reset requested via API");
  }
}
} // namespace FSM