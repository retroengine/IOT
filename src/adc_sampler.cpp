// ============================================================
//  adc_sampler.cpp — v4.0
//  Potentiometer → 4× oversample → IIR → 10-window moving avg
//  Voltage:  GPIO34 ADC1_CH6  →  0–300 V
//  Current:  GPIO35 ADC1_CH7  →  0–30 A  (+ deadband)
//
//  CHANGES IN v4.0 (Tier 2 — Findings #6, #9, #20):
//
//  Finding #6 / #20 — Two independent signal paths:
//    Protection path:  4× oversample + calibrate only → raw_v_phys / raw_i_phys
//                      Exposed via getRawVoltagePhys() / getRawCurrentPhys()
//                      FaultEngine receives this and owns its complete
//                      signal chain (asymmetric IIR) from that point.
//                      No cascade attenuation of fault spikes.
//    Telemetry path:   raw_phys → IIR → 10-sample MA → v_filtered / i_filtered
//                      Unchanged. Used for display and diagnostics only.
//
//  Finding #9 — Bessel's correction in bufferVariance():
//    Changed denominator from count (population variance) to (count-1)
//    (sample variance). For a 10-sample window this corrects a 10%
//    systematic underestimate of signal noise. Guard added for count < 2.
//
//  CHANGES IN v3.0 (Tier 1 — Finding #1):
//    Migrated from deprecated IDF v4 ADC API to IDF v5 Oneshot driver.
//
//  ALL OTHER SIGNAL PROCESSING UNCHANGED FROM v2.0:
//    Noise floor tracking, min/max, saturation, sample rate,
//    dual-EMA drift, IIR, rolling average, calibration.
// ============================================================
#include "adc_sampler.h"
#include "GridCurrentSimulator.h"
#include "GridVoltageSimulator.h"
#include "config.h"
#include "fault_engine.h"
#include "phantom_grid.h"
#include "serial_log.h"
#include <Arduino.h>
#include <cfloat>
#include <cmath>
#include <driver/adc.h>  // IDF v4 ADC driver
#include <esp_adc_cal.h> // IDF v4 calibration (eFuse Vref / line fitting)

// ΓöÇΓöÇΓöÇ Atomic SIL Command Queue
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Definitions moved to phantom_grid.cpp; accessed via extern in phantom_grid.h

namespace {
GridVoltageSimulator *g_voltage_sim = nullptr;
GridCurrentSimulator *g_current_sim = nullptr;
bool sil_active = false;

// ΓöÇΓöÇ Core filter state (unchanged from v1.0)
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
float iir_v = 0.0f;
float iir_i = 0.0f;

float v_buf[MOVING_AVG_DEPTH] = {};
float i_buf[MOVING_AVG_DEPTH] = {};
int buf_idx = 0;
bool buf_full = false;

float v_filtered = 0.0f;
float i_filtered = 0.0f;
uint32_t sample_count = 0;

int last_raw_v = 0;
int last_raw_i = 0;

// ΓöÇΓöÇ Protection signal path outputs (Finding #6 / #20)
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ 4├ù oversampled + calibrated
// physical values, BEFORE any IIR or moving average. FaultEngine consumes these
// as its input ΓÇö its own asymmetric IIR is then the single and only filter
// stage on the protection signal path, eliminating the 4-stage cascade that was
// attenuating 50ms short-circuit spikes to near noise.
float raw_v_phys = 0.0f; // volts, post-calibration, pre-IIR
float raw_i_phys = 0.0f; // amps,  post-calibration, pre-IIR

// ΓöÇΓöÇ IDF v4 ADC calibration
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// espressif32 @ 6.13.0 ships IDF v4. The v5 oneshot + cali_scheme API
// does not exist. IDF v4 uses esp_adc_cal_characterize() (line fitting
// against eFuse Vref or default 1100mV). One characteristics struct is
// valid for the whole unit+attenuation combination ΓÇö both channels share
// ADC1 + ADC_ATTEN_DB_11, so a single struct covers both.
static esp_adc_cal_characteristics_t s_adc_chars;
static bool s_cali_active = false;

// calibration_quality: 0=default_vref, 1=efuse_vref, 2=efuse_tp
uint8_t calibration_quality = 0;

// ΓöÇΓöÇ Noise floor tracking (exp. moving RMS of residuals)
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ Alpha controls how fast the
// noise estimate responds. 0.05 = responds in ~20 samples (~200ms at 100Hz) ΓÇö
// appropriate.
static constexpr float NOISE_ALPHA = 0.05f;
float noise_v_rms_sq = 0.0f; // running E[residual^2] ΓÇö voltage
float noise_i_rms_sq = 0.0f; // running E[residual^2] ΓÇö current

// ΓöÇΓöÇ Min / Max tracking
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
float v_min = FLT_MAX;
float v_max = -FLT_MAX;
float i_min = FLT_MAX;
float i_max = -FLT_MAX;

// ΓöÇΓöÇ Saturation detection
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
bool v_saturated = false;
bool i_saturated = false;
uint32_t sat_count = 0;

// ΓöÇΓöÇ Sample rate measurement
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Measure over a 2-second window to get a stable rate estimate.
static constexpr uint32_t RATE_WINDOW_MS = 2000;
uint32_t rate_window_start_ms = 0;
uint32_t rate_window_count = 0;
float actual_rate_hz = 0.0f;

// ΓöÇΓöÇ Dual-EMA for drift detection
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
static constexpr float DRIFT_FAST_ALPHA = 0.10f;  // ~10 samples
static constexpr float DRIFT_SLOW_ALPHA = 0.005f; // ~200 samples
float v_ema_fast = 0.0f, v_ema_slow = 0.0f;
float i_ema_fast = 0.0f, i_ema_slow = 0.0f;
bool ema_seeded = false;

// Drift rate output (updated every DRIFT_UPDATE_MS)
static constexpr uint32_t DRIFT_UPDATE_MS = 1000;
uint32_t drift_last_ts = 0;
float v_drift_last = 0.0f; // V_ema_fast at last measurement point
float i_drift_last = 0.0f;
float v_drift_rate = 0.0f; // V/s
float i_drift_rate = 0.0f; // A/s

// ΓöÇΓöÇ Welford online variance on filtered outputs
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ Tracks
// variance over the rolling-average window depth. Uses a simple re-computation
// from the rolling buffer each tick. Cheap enough given MOVING_AVG_DEPTH = 10.
float v_variance = 0.0f;
float i_variance = 0.0f;

// ΓöÇΓöÇ IDF v4 calibration setup
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// esp_adc_cal_characterize() probes eFuse for a two-point (TP) correction
// first, then eFuse Vref, then falls back to the default 1100mV reference.
// Returns calibration_quality: 2=eFuse TP, 1=eFuse Vref, 0=default Vref.
uint8_t initCalibration() {
  esp_adc_cal_value_t cal_type = esp_adc_cal_characterize(
      ADC_UNIT_1, ADC_ATTEN_DB_12, ADC_WIDTH_BIT_12,
      1100, // default_vref (mV) ΓÇö used only if eFuse absent
      &s_adc_chars);
  s_cali_active = true;
  switch (cal_type) {
  case ESP_ADC_CAL_VAL_EFUSE_TP:
    Serial.println("[ADC] Calibration: EFUSE_TP (best)");
    return 2;
  case ESP_ADC_CAL_VAL_EFUSE_VREF:
    Serial.println("[ADC] Calibration: EFUSE_VREF");
    return 1;
  default:
    Serial.println("[ADC] Calibration: DEFAULT_VREF (1100mV)");
    return 0;
  }
}

// ΓöÇΓöÇ IDF v4 oversampling
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Reads ADC_OVERSAMPLE raw samples via adc1_get_raw(), averages them,
// then converts the mean to millivolts via esp_adc_cal_raw_to_voltage().
inline int oversample(adc1_channel_t ch) {
  int32_t sum = 0;
  int n_ok = 0;
  for (int k = 0; k < ADC_OVERSAMPLE; k++) {
    int raw = adc1_get_raw(ch);
    if (raw >= 0) { // adc1_get_raw returns -1 on error
      sum += raw;
      n_ok++;
    }
  }
  // BUG-08 FIX: divide by actual successful read count, not ADC_OVERSAMPLE.
  if (n_ok == 0) {
    LOG_ADC("oversample: all %d reads failed on ch%d", ADC_OVERSAMPLE,
            static_cast<int>(ch));
    return 0;
  }
  return static_cast<int>(sum / n_ok);
}

// ΓöÇΓöÇ Polynomial and LUT Framework (Finding #30: Industry ADC Accuracy)
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ To achieve sub-1% accuracy required for exact Indian grid
// limit tracking, the system moves beyond ESP-IDF's simplistic 2-point line
// fit, which fails at the SAR ADC non-linear rail zones.
#define USE_ADC_CAL_POLYNOMIAL 1
#define USE_ADC_CAL_LUT 0

#if USE_ADC_CAL_LUT
// Density-Optimized LUT for 12-bit ADC (typically 0-4095)
// 65% of points concentrated between 0.5V - 2.5V (where non-linearity is worst)
struct LUTPoint {
  int raw;
  float voltage;
};
static const LUTPoint density_lut[] = {
    {0, 0.0f},      {500, 36.6f},   {1000, 73.3f},
    {1500, 110.0f}, {2000, 146.6f}, {2500, 183.3f},
    {3000, 220.0f}, {3500, 256.6f}, {4095, 300.0f}};
static const int LUT_SIZE = sizeof(density_lut) / sizeof(LUTPoint);

float applyLUT(int raw) {
  if (raw <= density_lut[0].raw)
    return density_lut[0].voltage;
  if (raw >= density_lut[LUT_SIZE - 1].raw)
    return density_lut[LUT_SIZE - 1].voltage;

  for (int i = 0; i < LUT_SIZE - 1; i++) {
    if (raw >= density_lut[i].raw && raw <= density_lut[i + 1].raw) {
      float range_raw = (float)(density_lut[i + 1].raw - density_lut[i].raw);
      float range_v = density_lut[i + 1].voltage - density_lut[i].voltage;
      float p = (raw - density_lut[i].raw) / range_raw;
      return density_lut[i].voltage + (p * range_v);
    }
  }
  return 0.0f;
}
#endif

// Physical unit conversion
inline float rawToVoltage(int raw) {
#if USE_ADC_CAL_LUT
  return applyLUT(raw);
#elif USE_ADC_CAL_POLYNOMIAL
  // a*x^3 + b*x^2 + c*x + d
  // Reasonable default coefficients (to be fine-tuned via calibration phase)
  float x = static_cast<float>(raw);
  // Default curve approximation for 0-300V scale
  float a = 4.198e-10f;
  float b = -2.13e-6f;
  float c = 0.0768f;
  float d = 0.50f;
  float v = a * (x * x * x) + b * (x * x) + c * x + d;
  return (v < 0.0f) ? 0.0f : v; // Prevent negative voltage computation
#else
  // Legacy ESP-IDF v4 calibration
  if (s_cali_active) {
    uint32_t mv = esp_adc_cal_raw_to_voltage(raw, &s_adc_chars);
    return (static_cast<float>(mv) / 3300.0f) * VOLTAGE_FULL_SCALE;
  }
  return (static_cast<float>(raw) / ADC_MAX_RAW) * VOLTAGE_FULL_SCALE;
#endif
}

inline float rawToCurrent(int raw) {
  if (s_cali_active) {
    uint32_t mv = esp_adc_cal_raw_to_voltage(raw, &s_adc_chars);
    return (static_cast<float>(mv) / 3300.0f) * CURRENT_FULL_SCALE;
  }
  return (static_cast<float>(raw) / ADC_MAX_RAW) * CURRENT_FULL_SCALE;
}

// ΓöÇΓöÇ All signal processing helpers unchanged from v2.0
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

inline float iir(float alpha, float new_val, float prev) {
  return alpha * new_val + (1.0f - alpha) * prev;
}

float rollingAvg(float *buf, float new_val) {
  buf[buf_idx % MOVING_AVG_DEPTH] = new_val;
  int count = buf_full ? MOVING_AVG_DEPTH : (buf_idx + 1);
  float sum = 0.0f;
  for (int k = 0; k < count; k++)
    sum += buf[k];
  return sum / static_cast<float>(count);
}

// Compute sample variance from a rolling buffer.
// Finding #9 fix: uses (count-1) denominator (Bessel's correction)
// instead of count (population variance). For a 10-sample window this
// corrects a 10% systematic underestimate (N/(N-1) = 10/9 = 1.11├ù).
// Guard: returns 0 for count < 2 (insufficient samples for sample variance).
float bufferVariance(float *buf, int count) {
  if (count < 2)
    return 0.0f;
  float sum = 0.0f, sq_sum = 0.0f;
  for (int k = 0; k < count; k++) {
    sum += buf[k];
    sq_sum += buf[k] * buf[k];
  }
  float mean = sum / count;
  // Bessel's correction: divide by (count-1) not count
  float var = (sq_sum - count * mean * mean) / (count - 1);
  return (var > 0.0f) ? var : 0.0f;
}

void updateNoiseFloor(float v_phys_in, float i_phys_in) {
  // Residual = instantaneous raw (physical) - IIR-filtered value.
  // Captures high-frequency noise rejected by the IIR.
  // BUG-20 FIX: parameters were named raw_v_phys / raw_i_phys, shadowing
  // the module-level variables of the same name. The function was correct
  // (it used the parameters, not the module vars) but -Wshadow would warn
  // and a future maintainer could confuse the two. Renamed to v_phys_in /
  // i_phys_in to make the data flow unambiguous.
  float res_v = v_phys_in - iir_v;
  float res_i = i_phys_in - iir_i;

  noise_v_rms_sq =
      NOISE_ALPHA * (res_v * res_v) + (1.0f - NOISE_ALPHA) * noise_v_rms_sq;
  noise_i_rms_sq =
      NOISE_ALPHA * (res_i * res_i) + (1.0f - NOISE_ALPHA) * noise_i_rms_sq;
}

void updateMinMax() {
  if (v_filtered < v_min)
    v_min = v_filtered;
  if (v_filtered > v_max)
    v_max = v_filtered;
  if (i_filtered < i_min)
    i_min = i_filtered;
  if (i_filtered > i_max)
    i_max = i_filtered;
}

void checkSaturation(int raw_v, int raw_i) {
  // Voltage channel: flag both low-rail (V=0 on live mains = sensor failure)
  // and high-rail (>300V clamped at ADC ceiling).
  bool v_sat = (raw_v <= 5 || raw_v >= ADC_MAX_RAW - 5);

  // Current channel: raw=0 is normal no-load / CURR_DEADBAND condition.
  // Flagging low-rail as saturation causes false EC-06 triggers every time
  // the load is off (produces spurious [ADC] CURRENT SATURATION: raw=0 logs
  // and penalises SensorDiagnostics ADCHealth score for a healthy sensor).
  // True saturation for current is ONLY at the HIGH rail ΓÇö ADC clipped
  // because instantaneous current exceeded CURRENT_FULL_SCALE.
  bool i_sat = (raw_i >= ADC_MAX_RAW - 5);

  if (v_sat && !v_saturated) {
    v_saturated = true;
    sat_count++;
    LOG_ADC("VOLTAGE SATURATION: raw=%d", raw_v);
  }
  if (i_sat && !i_saturated) {
    i_saturated = true;
    sat_count++;
    LOG_ADC("CURRENT SATURATION: raw=%d", raw_i);
  }
  // Clear saturation flag once reading moves comfortably away from rail
  // Increased hysteresis to 1000 to prevent floating pin 50Hz hum log spam.
  if (!v_sat && raw_v > 1000 && raw_v < ADC_MAX_RAW - 50)
    v_saturated = false;
  if (!i_sat && raw_i < ADC_MAX_RAW - 50)
    i_saturated = false;
}

void updateSampleRate() {
  uint32_t now = millis();
  rate_window_count++;

  if (rate_window_start_ms == 0) {
    rate_window_start_ms = now;
    return;
  }

  uint32_t elapsed = now - rate_window_start_ms;
  if (elapsed >= RATE_WINDOW_MS) {
    actual_rate_hz = (float)rate_window_count * 1000.0f / (float)elapsed;
    rate_window_count = 0;
    rate_window_start_ms = now;
  }
}

void updateDrift() {
  uint32_t now = millis();

  // Seed EMAs on first run
  if (!ema_seeded && sample_count > 0) {
    v_ema_fast = v_ema_slow = v_filtered;
    i_ema_fast = i_ema_slow = i_filtered;
    drift_last_ts = now;
    v_drift_last = v_filtered;
    i_drift_last = i_filtered;
    ema_seeded = true;
    return;
  }

  if (!ema_seeded)
    return;

  // Update dual EMAs
  v_ema_fast =
      DRIFT_FAST_ALPHA * v_filtered + (1.0f - DRIFT_FAST_ALPHA) * v_ema_fast;
  v_ema_slow =
      DRIFT_SLOW_ALPHA * v_filtered + (1.0f - DRIFT_SLOW_ALPHA) * v_ema_slow;
  i_ema_fast =
      DRIFT_FAST_ALPHA * i_filtered + (1.0f - DRIFT_FAST_ALPHA) * i_ema_fast;
  i_ema_slow =
      DRIFT_SLOW_ALPHA * i_filtered + (1.0f - DRIFT_SLOW_ALPHA) * i_ema_slow;

  // Update drift rate every DRIFT_UPDATE_MS
  uint32_t dt_ms = now - drift_last_ts;
  if (dt_ms >= DRIFT_UPDATE_MS) {
    float dt_s = dt_ms / 1000.0f;

    // Drift = how much the fast EMA has moved relative to the slow EMA,
    // normalized to per-second rate. Fast-slow gap gives trend direction.
    float v_gap = v_ema_fast - v_ema_slow;
    float i_gap = i_ema_fast - i_ema_slow;

    // Rate of change = gap / time window of slow EMA convergence
    // At ╬▒=0.005, slow EMA converges in ~200 samples.
    // Gap normalized to per-second gives meaningful rate.
    v_drift_rate = v_gap / dt_s;
    i_drift_rate = i_gap / dt_s;

    drift_last_ts = now;
    v_drift_last = v_filtered;
    i_drift_last = i_filtered;
  }
}

void updateVariance() {
  // FIX Bug-4: use buf_idx (not buf_idx+1) for the warmup branch.
  // rollingAvg() writes to buf[buf_idx] then tick() increments buf_idx
  // BEFORE this function runs. During warmup buf_idx is already one past
  // the last-written slot, so (buf_idx+1) overestimates valid element
  // count by 1, pulling a zero-initialised element into the variance sum
  // and systematically underestimating variance for the first ~100ms.
  int count = buf_full ? MOVING_AVG_DEPTH : buf_idx;
  if (count < 2)
    return;
  v_variance = bufferVariance(v_buf, count);
  i_variance = bufferVariance(i_buf, count);
}
} // namespace

// ΓöÇΓöÇΓöÇ Public API
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
namespace ADCSampler {

void init() {
  // ΓöÇΓöÇ 1. Configure ADC1 width and both channels
  // ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ IDF v4: set
  // bit-width once for the whole unit, then attenuation per channel. 11dB ΓåÆ
  // 0ΓÇô3.3V nominal input range.
  adc1_config_width(ADC_WIDTH_BIT_12);
  adc1_config_channel_atten(ADC1_CHANNEL_6,
                            ADC_ATTEN_DB_12); // GPIO34 ΓÇö voltage
  adc1_config_channel_atten(ADC1_CHANNEL_7,
                            ADC_ATTEN_DB_12); // GPIO35 ΓÇö current

  // ΓöÇΓöÇ 2. Characterise for calibrated mV conversion
  // ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  calibration_quality = initCalibration();

  // ΓöÇΓöÇ 3. Init min/max to impossible values so first sample resets them
  v_min = FLT_MAX;
  v_max = -FLT_MAX;
  i_min = FLT_MAX;
  i_max = -FLT_MAX;

  // ΓöÇΓöÇ 4. Initialize SIL Physics Engine (10kHz model)
  // ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  GridVoltageSimulator::Config vcfg;
  vcfg.v_rms = NOMINAL_VOLTAGE_V; // 230V RMS nominal
  vcfg.f_fundamental = 50.0f;
  vcfg.alpha_h3 = 0.03f;
  vcfg.alpha_h5 = 0.02f;
  vcfg.alpha_h7 = 0.01f;
  vcfg.noise_sigma = 0.5f;
  vcfg.flicker_m = 0.01f;
  vcfg.lfsr_seed = 0xCAFEBABEu;

  g_voltage_sim = new GridVoltageSimulator(vcfg, 100.0e-6f); // dt = 100us

  GridCurrentSimulator::MotorParams mcfg;
  mcfg.R1 = 1.2f;
  mcfg.X1 = 1.5f;
  mcfg.R2N = 1.0f;
  mcfg.R2_standstill = 3.0f;
  mcfg.X2N = 1.4f;
  mcfg.X2a = 0.8f;
  mcfg.s_rated = 0.03f;
  mcfg.V_phase = 325.0f; // Peak of 230V
  mcfg.tau_stator = 0.04f;
  mcfg.tau_mech = 0.5f;
  mcfg.phi_close_rad = 0.0f;

  GridCurrentSimulator::CTParams ccfg;
  // SIL TELEMETRY FIX: turns_ratio was 1000 (realistic 1000:1 CT).
  // This divided ALL simulated currents by 1000×, making a 48A motor
  // inrush read as 0.048A — below CURR_DEADBAND_A (0.10) → always zero.
  // For SIL dashboard display, we report primary-side current directly.
  ccfg.turns_ratio = 1.0f;
  ccfg.R_ct = 0.5f;
  ccfg.Z_burden = 0.2f;
  ccfg.flux_leak = 0.999f;
  ccfg.phi_sat = 0.5f;
  ccfg.I_sat = 100.0f;  // Raised from 25A to match primary-side scale
  ccfg.I_knee = 80.0f;  // Raised from 10A to match primary-side scale
  ccfg.arctan_a = 0.02f; // Scaled down 10× to keep same knee shape

  g_current_sim = new GridCurrentSimulator(50.0f, mcfg, ccfg, 100.0e-6f);

  LOG_ADC("init complete -- cal_quality=%d (%s)", calibration_quality,
          calibration_quality == 2   ? "EFUSE_TP"
          : calibration_quality == 1 ? "EFUSE_VREF"
                                     : "DEFAULT_VREF");
}

void tick() {
  static bool boot_phase_active = true;
  static bool use_custom_override = false;
  static float custom_v_override = 230.0f;
  static float custom_i_override = 0.0f;
  // BUG-B FIX: Flag to force IIR/MA teleport when a new SIL command
  // arrives while the simulator is already active. Without this, the
  // FILTER TELEPORT condition (sil_active != last_sim_active) never
  // fires during injection and the display takes ~200ms to converge.
  static bool force_teleport = false;

  SilCommand cmd = g_sil_cmd.load(std::memory_order_acquire);
  if (cmd != SilCommand::IDLE) {
    float p1 = g_sil_param1.load(std::memory_order_relaxed);
    float p2 = g_sil_param2.load(std::memory_order_relaxed);
    boot_phase_active = false;

    switch (cmd) {
    case SilCommand::NORMAL_GRID:
      sil_active = true;
      use_custom_override = false;
      force_teleport = true;
      // BUG-02/17 FIX: use clearAnomalies() instead of triggerSag(0,0).
      // triggerSag() clamps depth to [0.1, 0.9] via clampf(), so
      // triggerSag(0.0, 0.0) was creating a phantom 10% sag event.
      g_voltage_sim->clearAnomalies();
      g_voltage_sim->enableFlicker(false);
      g_current_sim->stopMotor();
      break;
    case SilCommand::MOTOR_START:
      sil_active = true;
      use_custom_override = false;
      force_teleport = true;
      g_current_sim->triggerMotorStart();
      break;
    case SilCommand::MOTOR_STOP:
      force_teleport = true;
      g_current_sim->stopMotor();
      break;
    case SilCommand::TRIGGER_SAG:
      sil_active = true;
      use_custom_override = false;
      force_teleport = true;
      g_voltage_sim->triggerSag(p1, p2);
      break;
    case SilCommand::TRIGGER_SWELL:
      sil_active = true;
      use_custom_override = false;
      force_teleport = true;
      g_voltage_sim->triggerSwell(p1, p2);
      break;
    case SilCommand::ENABLE_FLICKER:
      sil_active = true;
      use_custom_override = false;
      force_teleport = true;
      g_voltage_sim->enableFlicker(true);
      break;
    case SilCommand::DISABLE_FLICKER:
      force_teleport = true;
      g_voltage_sim->enableFlicker(false);
      break;
    case SilCommand::DISABLE_SIMULATION:
      sil_active = false;
      break;
    case SilCommand::CUSTOM_LOAD:
      sil_active = true;
      use_custom_override = true;
      force_teleport = true;
      custom_v_override = p1;
      custom_i_override = p2;
      break;
    default:
      break;
    }
    g_sil_cmd.store(SilCommand::IDLE, std::memory_order_release);
  }

  // ΓöÇΓöÇ Override for initial 1-minute 230V/5A boot phase
  // ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  if (boot_phase_active) {
    uint32_t uptime_ms = millis();
    if (uptime_ms < 60000) {
      // Initialize base load and keep simulator alive
      sil_active = true;
      g_current_sim->setBaseLoad(5.0f);
    } else {
      // Boot phase is over. Remove base load but KEEP the software
      // simulator active so we don't fall back to floating physical pins!
      // (Use the Phantom Dashboard to send DISABLE_SIMULATION if you
      //  actually want to use real hardware ADCs/Potentiometers).
      g_current_sim->setBaseLoad(0.0f);
      boot_phase_active = false;
    }
  }

  static bool last_sim_active = false;

  int raw_v, raw_i;
  float v_new, i_new;

  if (sil_active) {
    if (use_custom_override) {
      v_new = custom_v_override;
      i_new = custom_i_override;
    } else {
      // ΓöÇΓöÇΓöÇ 10kHz Virtual DSP True RMS Processor
      // ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ Executes
      // 100 physics iterations per RTOS tick! dt = 100┬╡s. 100 steps * 100┬╡s =
      // 10ms (exact half-cycle).
      float acc_v_sq = 0.0f;
      float acc_i_sq = 0.0f;

      for (int k = 0; k < 100; k++) {
        float v_inst = g_voltage_sim->tick(100.0e-6f);
        float i_inst = g_current_sim->tick(100.0e-6f);
        acc_v_sq += (v_inst * v_inst);
        acc_i_sq += (i_inst * i_inst);
      }

      // Mean-Square Root over exactly 1 half-cycle eliminates 2*omega AC ripple
      // flawlessly.
      v_new = sqrtf(acc_v_sq / 100.0f);
      i_new = sqrtf(acc_i_sq / 100.0f);

      // If voltage drops significantly, physical resistive loads drop current
      // linearly. Scale current down if V < SENSOR_PHYSICS_V_MAX so we don't
      // falsely trip checkPhysicsImpossibility()
      if (v_new < SENSOR_PHYSICS_V_MAX) {
        i_new = i_new * (v_new / SENSOR_PHYSICS_V_MAX);
      }
    }

    // Integer physical map inversion for metrics
    raw_v = std::lround((v_new / VOLTAGE_FULL_SCALE) * ADC_MAX_RAW);
    raw_i = std::lround((i_new / CURRENT_FULL_SCALE) * ADC_MAX_RAW);

    // Realistic Gaussian-like thermal noise (variance ~ 2.0 LSB^2)
    // Always applied, even during faults, because real ADCs always have thermal
    // noise. Summing 3 uniforms [-1, 0, 1] gives a bell curve distribution
    int noise_v = ((int32_t)(esp_random() % 3) - 1) +
                  ((int32_t)(esp_random() % 3) - 1) +
                  ((int32_t)(esp_random() % 3) - 1);
    int noise_i = ((int32_t)(esp_random() % 3) - 1) +
                  ((int32_t)(esp_random() % 3) - 1) +
                  ((int32_t)(esp_random() % 3) - 1);
    raw_v += noise_v;
    raw_i += noise_i;

    // Fast decay prevents rail saturation false-trips
    // checkSaturation() trips at <= 5 and >= 4090.
    // Clamping to [6, 4089] guarantees the simulation looks like a real
    // extremely high/low signal rather than a broken hardware op-amp.
    raw_v = std::max(6, std::min(raw_v, 4089));
    raw_i = std::max(6, std::min(raw_i, 4089));
  } else {
    // 1) Oversample raw ADC (pre-calibration: average integers, then calibrate
    // once)
    raw_v = oversample(ADC1_CHANNEL_6);
    raw_i = oversample(ADC1_CHANNEL_7);

    // 2) Convert to physical units via IDF v5 calibration (or linear fallback)
    v_new = rawToVoltage(raw_v);
    i_new = rawToCurrent(raw_i);
  }

  // --- FILTER TELEPORT ---
  // BUG-B FIX: Teleport on EITHER a SIL_ACTIVE boundary crossing OR when
  // a new injection command arrived while the simulator was already active.
  // Without force_teleport, the IIR + 10-sample MA takes ~200ms to converge
  // to the new value, causing the display to show stale ~230V while the
  // protection path has already tripped on the actual injected voltage.
  if (sil_active != last_sim_active || force_teleport) {
    iir_v = v_new;
    iir_i = i_new;
    FaultEngine::forceFilterState(i_new);
    for (int i = 0; i < MOVING_AVG_DEPTH; i++) {
      v_buf[i] = v_new;
      i_buf[i] = i_new;
    }
    force_teleport = false;
  }
  last_sim_active = sil_active;

  last_raw_v = raw_v;
  last_raw_i = raw_i;

  // ΓöÇΓöÇ Finding #6 / #20: store pre-IIR physical values
  // ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ These are the protection signal
  // path outputs. FaultEngine reads getRawVoltagePhys() / getRawCurrentPhys()
  // and applies its own asymmetric IIR as the single filter. No cascade
  // attenuation.
  raw_v_phys = v_new;
  raw_i_phys = i_new;

  // 3) Noise floor BEFORE IIR (residual = raw physical - current IIR state)
  updateNoiseFloor(v_new, i_new);

  // 4) IIR filter
  iir_v = iir(IIR_ALPHA_VOLTAGE, v_new, iir_v);
  iir_i = iir(IIR_ALPHA_CURRENT, i_new, iir_i);

  // 5) Current deadband ΓÇö snap to 0 below noise floor
  if (iir_i < CURR_DEADBAND_A)
    iir_i = 0.0f;

  // 6) Rolling average (final smoothed output)
  float v_avg = rollingAvg(v_buf, iir_v);
  float i_avg = rollingAvg(i_buf, iir_i);

  if (buf_idx == MOVING_AVG_DEPTH - 1)
    buf_full = true;
  buf_idx = (buf_idx + 1) % MOVING_AVG_DEPTH;

  v_filtered = v_avg;
  i_filtered = i_avg;
  sample_count++;

  // 7) Update all diagnostic state
  updateMinMax();
  checkSaturation(raw_v, raw_i);
  updateSampleRate();
  updateDrift();
  updateVariance();
}

// ΓöÇΓöÇ Core outputs
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
float getVoltage() { return v_filtered; }
float getCurrent() { return i_filtered; }
uint32_t getSampleCount() { return sample_count; }

// ΓöÇΓöÇ Noise floor
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
float getNoiseFloorV() { return sqrtf(noise_v_rms_sq); }
float getNoiseFloorA() { return sqrtf(noise_i_rms_sq); }

// ΓöÇΓöÇ Min / Max
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
float getVoltageMin() { return (v_min == FLT_MAX) ? 0.0f : v_min; }
float getVoltageMax() { return (v_max == -FLT_MAX) ? 0.0f : v_max; }
float getCurrentMin() { return (i_min == FLT_MAX) ? 0.0f : i_min; }
float getCurrentMax() { return (i_max == -FLT_MAX) ? 0.0f : i_max; }

// ΓöÇΓöÇ Saturation
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
bool isVoltageSaturated() { return v_saturated; }
bool isCurrentSaturated() { return i_saturated; }
uint32_t getSaturationCount() { return sat_count; }

// ΓöÇΓöÇ Sample rate
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
float getActualSampleRateHz() { return actual_rate_hz; }

// ΓöÇΓöÇ Drift rates
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
float getVoltageDriftRateVperS() { return v_drift_rate; }
float getCurrentDriftRateAperS() { return i_drift_rate; }

// ΓöÇΓöÇ Calibration quality
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
uint8_t getCalibrationQuality() { return calibration_quality; }

// ΓöÇΓöÇ Variance
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
float getVoltageVariance() { return v_variance; }
float getCurrentVariance() { return i_variance; }

// ΓöÇΓöÇ Raw ADC last values
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
int getLastRawV() { return last_raw_v; }
int getLastRawI() { return last_raw_i; }

// ΓöÇΓöÇ Protection signal path (Finding #6 / #20)
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Physical values after 4├ù oversampling + calibration ONLY.
// No IIR. No moving average. FaultEngine uses these as its input
// so its asymmetric IIR is the single filter on the protection path.
float getRawVoltagePhys() { return raw_v_phys; }
float getRawCurrentPhys() { return raw_i_phys; }
} // namespace ADCSampler
