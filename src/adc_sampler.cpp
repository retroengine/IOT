// ============================================================
//  adc_sampler.cpp — v2.0
//  Potentiometer → 4× oversample → IIR → 10-window moving avg
//  Voltage:  GPIO34 ADC1_CH6  →  0–300 V
//  Current:  GPIO35 ADC1_CH7  →  0–5 A  (+ deadband)
//
//  ADDITIONS IN v2.0:
//    1. Noise floor via exponential moving RMS of residuals
//       residual = raw_value - filtered_value
//       noise_rms^2 = α*residual^2 + (1-α)*noise_rms^2
//
//    2. All-time min/max tracking on filtered outputs
//
//    3. Saturation detection (ADC rail hits — 0 or 4095)
//
//    4. Actual sample rate measurement from wall clock
//
//    5. Drift rate via dual-EMA: fast(α=0.1) vs slow(α=0.005)
//       drift_rate = (fast_ema - slow_ema) / dt_seconds
//
//    6. Welford online variance on filtered outputs
//       Used by sensor_diagnostics to compute SNR
//
//    7. Calibration quality type exposed as uint8_t (0/1/2)
//
//    8. Last raw ADC values exposed for linearity estimation
// ============================================================
#include "adc_sampler.h"
#include "config.h"
#include <driver/adc.h>
#include <esp_adc_cal.h>
#include <cfloat>
#include <cmath>

// ─── Internal state ───────────────────────────────────────────────────────────
namespace {

    // ── Core filter state (unchanged from v1.0) ───────────────────────────
    float iir_v = 0.0f;
    float iir_i = 0.0f;

    float  v_buf[MOVING_AVG_DEPTH] = {};
    float  i_buf[MOVING_AVG_DEPTH] = {};
    int    buf_idx  = 0;
    bool   buf_full = false;

    float    v_filtered  = 0.0f;
    float    i_filtered  = 0.0f;
    uint32_t sample_count = 0;

    int last_raw_v = 0;
    int last_raw_i = 0;

    // ── ADC calibration ───────────────────────────────────────────────────
    esp_adc_cal_characteristics_t adc_chars_v;
    esp_adc_cal_characteristics_t adc_chars_i;
    uint8_t calibration_quality = 0;   // 0=none, 1=vref, 2=two-point

    // ── Noise floor tracking (exp. moving RMS of residuals) ───────────────
    // Alpha controls how fast the noise estimate responds.
    // 0.05 = responds in ~20 samples (~200ms at 100Hz) — appropriate.
    static constexpr float NOISE_ALPHA = 0.05f;
    float noise_v_rms_sq = 0.0f;   // running E[residual^2] — voltage
    float noise_i_rms_sq = 0.0f;   // running E[residual^2] — current

    // ── Min / Max tracking ────────────────────────────────────────────────
    float v_min =  FLT_MAX;
    float v_max = -FLT_MAX;
    float i_min =  FLT_MAX;
    float i_max = -FLT_MAX;

    // ── Saturation detection ──────────────────────────────────────────────
    bool     v_saturated = false;
    bool     i_saturated = false;
    uint32_t sat_count   = 0;

    // ── Sample rate measurement ───────────────────────────────────────────
    // Measure over a 2-second window to get a stable rate estimate.
    static constexpr uint32_t RATE_WINDOW_MS = 2000;
    uint32_t rate_window_start_ms = 0;
    uint32_t rate_window_count    = 0;
    float    actual_rate_hz       = 0.0f;

    // ── Dual-EMA for drift detection ──────────────────────────────────────
    static constexpr float DRIFT_FAST_ALPHA = 0.10f;   // ~10 samples
    static constexpr float DRIFT_SLOW_ALPHA = 0.005f;  // ~200 samples
    float v_ema_fast = 0.0f, v_ema_slow = 0.0f;
    float i_ema_fast = 0.0f, i_ema_slow = 0.0f;
    bool  ema_seeded = false;

    // Drift rate output (updated every DRIFT_UPDATE_MS)
    static constexpr uint32_t DRIFT_UPDATE_MS = 1000;
    uint32_t drift_last_ts  = 0;
    float    v_drift_last   = 0.0f; // V_ema_fast at last measurement point
    float    i_drift_last   = 0.0f;
    float    v_drift_rate   = 0.0f; // V/s
    float    i_drift_rate   = 0.0f; // A/s

    // ── Welford online variance on filtered outputs ───────────────────────
    // Tracks variance over the rolling-average window depth.
    // Uses a simple re-computation from the rolling buffer each tick.
    // Cheap enough given MOVING_AVG_DEPTH = 10.
    float v_variance = 0.0f;
    float i_variance = 0.0f;

    // ── Helpers ───────────────────────────────────────────────────────────
    inline int oversample(adc1_channel_t ch) {
        int32_t sum = 0;
        for (int k = 0; k < ADC_OVERSAMPLE; k++) {
            sum += adc1_get_raw(ch);
        }
        return sum / ADC_OVERSAMPLE;
    }

    inline float rawToVoltage(int raw) {
        return (static_cast<float>(raw) / ADC_MAX_RAW) * VOLTAGE_FULL_SCALE;
    }

    inline float rawToCurrent(int raw) {
        return (static_cast<float>(raw) / ADC_MAX_RAW) * CURRENT_FULL_SCALE;
    }

    inline float iir(float alpha, float new_val, float prev) {
        return alpha * new_val + (1.0f - alpha) * prev;
    }

    float rollingAvg(float* buf, float new_val) {
        buf[buf_idx % MOVING_AVG_DEPTH] = new_val;
        int count = buf_full ? MOVING_AVG_DEPTH : (buf_idx + 1);
        float sum = 0.0f;
        for (int k = 0; k < count; k++) sum += buf[k];
        return sum / static_cast<float>(count);
    }

    // Compute variance from a rolling buffer
    float bufferVariance(float* buf, int count) {
        if (count < 2) return 0.0f;
        float sum = 0.0f, sq_sum = 0.0f;
        for (int k = 0; k < count; k++) {
            sum    += buf[k];
            sq_sum += buf[k] * buf[k];
        }
        float mean = sum / count;
        float var  = (sq_sum / count) - (mean * mean);
        return (var > 0.0f) ? var : 0.0f;
    }

    void updateNoiseFloor(float raw_v_phys, float raw_i_phys) {
        // Residual = instantaneous raw (physical) - IIR-filtered value
        // This captures high-frequency noise rejected by the IIR
        float res_v = raw_v_phys - iir_v;
        float res_i = raw_i_phys - iir_i;

        noise_v_rms_sq = NOISE_ALPHA * (res_v * res_v) +
                         (1.0f - NOISE_ALPHA) * noise_v_rms_sq;
        noise_i_rms_sq = NOISE_ALPHA * (res_i * res_i) +
                         (1.0f - NOISE_ALPHA) * noise_i_rms_sq;
    }

    void updateMinMax() {
        if (v_filtered < v_min) v_min = v_filtered;
        if (v_filtered > v_max) v_max = v_filtered;
        if (i_filtered < i_min) i_min = i_filtered;
        if (i_filtered > i_max) i_max = i_filtered;
    }

    void checkSaturation(int raw_v, int raw_i) {
        // Voltage channel: flag both low-rail (V=0 on live mains = sensor failure)
        // and high-rail (>300V clamped at ADC ceiling).
        bool v_sat = (raw_v <= 5 || raw_v >= ADC_MAX_RAW - 5);

        // Current channel: raw=0 is normal no-load / CURR_DEADBAND condition.
        // Flagging low-rail as saturation causes false EC-06 triggers every time
        // the load is off (produces spurious [ADC] CURRENT SATURATION: raw=0 logs
        // and penalises SensorDiagnostics ADCHealth score for a healthy sensor).
        // True saturation for current is ONLY at the HIGH rail — ADC clipped
        // because instantaneous current exceeded CURRENT_FULL_SCALE.
        bool i_sat = (raw_i >= ADC_MAX_RAW - 5);

        if (v_sat && !v_saturated) {
            v_saturated = true;
            sat_count++;
            Serial.printf("[ADC] VOLTAGE SATURATION: raw=%d\n", raw_v);
        }
        if (i_sat && !i_saturated) {
            i_saturated = true;
            sat_count++;
            Serial.printf("[ADC] CURRENT SATURATION: raw=%d\n", raw_i);
        }
        // Clear saturation flag once reading moves comfortably away from rail
        if (!v_sat && raw_v > 50 && raw_v < ADC_MAX_RAW - 50) v_saturated = false;
        if (!i_sat && raw_i < ADC_MAX_RAW - 50)                i_saturated = false;
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
            rate_window_count    = 0;
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
            v_drift_last  = v_filtered;
            i_drift_last  = i_filtered;
            ema_seeded = true;
            return;
        }

        if (!ema_seeded) return;

        // Update dual EMAs
        v_ema_fast = DRIFT_FAST_ALPHA * v_filtered + (1.0f - DRIFT_FAST_ALPHA) * v_ema_fast;
        v_ema_slow = DRIFT_SLOW_ALPHA * v_filtered + (1.0f - DRIFT_SLOW_ALPHA) * v_ema_slow;
        i_ema_fast = DRIFT_FAST_ALPHA * i_filtered + (1.0f - DRIFT_FAST_ALPHA) * i_ema_fast;
        i_ema_slow = DRIFT_SLOW_ALPHA * i_filtered + (1.0f - DRIFT_SLOW_ALPHA) * i_ema_slow;

        // Update drift rate every DRIFT_UPDATE_MS
        uint32_t dt_ms = now - drift_last_ts;
        if (dt_ms >= DRIFT_UPDATE_MS) {
            float dt_s = dt_ms / 1000.0f;

            // Drift = how much the fast EMA has moved relative to the slow EMA,
            // normalized to per-second rate. Fast-slow gap gives trend direction.
            float v_gap = v_ema_fast - v_ema_slow;
            float i_gap = i_ema_fast - i_ema_slow;

            // Rate of change = gap / time window of slow EMA convergence
            // At α=0.005, slow EMA converges in ~200 samples.
            // Gap normalized to per-second gives meaningful rate.
            v_drift_rate = v_gap / dt_s;
            i_drift_rate = i_gap / dt_s;

            drift_last_ts = now;
            v_drift_last  = v_filtered;
            i_drift_last  = i_filtered;
        }
    }

    void updateVariance() {
        int count = buf_full ? MOVING_AVG_DEPTH : (buf_idx + 1);
        if (count < 2) return;
        v_variance = bufferVariance(v_buf, count);
        i_variance = bufferVariance(i_buf, count);
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────
namespace ADCSampler {

    void init() {
        // Set attenuation for 0–3.3 V input range on both channels
        adc1_config_width(ADC_WIDTH_BIT_12);
        adc1_config_channel_atten(ADC1_CHANNEL_6, ADC_ATTEN_DB_11);
        adc1_config_channel_atten(ADC1_CHANNEL_7, ADC_ATTEN_DB_11);

        // Characterise ADC using eFuse calibration when available
        esp_adc_cal_value_t val_type_v = esp_adc_cal_characterize(
            ADC_UNIT_1, ADC_ATTEN_DB_11, ADC_WIDTH_BIT_12,
            1100, &adc_chars_v);
        esp_adc_cal_value_t val_type_i = esp_adc_cal_characterize(
            ADC_UNIT_1, ADC_ATTEN_DB_11, ADC_WIDTH_BIT_12,
            1100, &adc_chars_i);

        // Map calibration type to quality score
        if (val_type_v == ESP_ADC_CAL_VAL_EFUSE_TP) {
            calibration_quality = 2;  // Best: two-point eFuse
        } else if (val_type_v == ESP_ADC_CAL_VAL_EFUSE_VREF) {
            calibration_quality = 1;  // Good: Vref eFuse
        } else {
            calibration_quality = 0;  // None: default reference
        }

        // Init min/max to impossible values so first sample overwrites them
        v_min =  FLT_MAX;  v_max = -FLT_MAX;
        i_min =  FLT_MAX;  i_max = -FLT_MAX;

        Serial.printf("[ADC] init — cal_quality=%d (%s)\n",
            calibration_quality,
            calibration_quality == 2 ? "EFUSE_TP" :
            calibration_quality == 1 ? "EFUSE_VREF" : "DEFAULT");
    }

    void tick() {
        // 1) Oversample raw ADC
        int raw_v = oversample(ADC1_CHANNEL_6);
        int raw_i = oversample(ADC1_CHANNEL_7);

        last_raw_v = raw_v;
        last_raw_i = raw_i;

        // 2) Convert to physical units
        float v_new = rawToVoltage(raw_v);
        float i_new = rawToCurrent(raw_i);

        // 3) Noise floor BEFORE IIR (residual = raw physical - current IIR state)
        updateNoiseFloor(v_new, i_new);

        // 4) IIR filter
        iir_v = iir(IIR_ALPHA_VOLTAGE, v_new, iir_v);
        iir_i = iir(IIR_ALPHA_CURRENT, i_new, iir_i);

        // 5) Current deadband — snap to 0 below noise floor
        if (iir_i < CURR_DEADBAND_A) iir_i = 0.0f;

        // 6) Rolling average (final smoothed output)
        float v_avg = rollingAvg(v_buf, iir_v);
        float i_avg = rollingAvg(i_buf, iir_i);

        if (buf_idx == MOVING_AVG_DEPTH - 1) buf_full = true;
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

    // ── Core outputs ──────────────────────────────────────────────────────
    float    getVoltage()     { return v_filtered; }
    float    getCurrent()     { return i_filtered; }
    uint32_t getSampleCount() { return sample_count; }

    // ── Noise floor ───────────────────────────────────────────────────────
    float getNoiseFloorV() { return sqrtf(noise_v_rms_sq); }
    float getNoiseFloorA() { return sqrtf(noise_i_rms_sq); }

    // ── Min / Max ─────────────────────────────────────────────────────────
    float getVoltageMin() { return (v_min ==  FLT_MAX) ? 0.0f : v_min; }
    float getVoltageMax() { return (v_max == -FLT_MAX) ? 0.0f : v_max; }
    float getCurrentMin() { return (i_min ==  FLT_MAX) ? 0.0f : i_min; }
    float getCurrentMax() { return (i_max == -FLT_MAX) ? 0.0f : i_max; }

    // ── Saturation ────────────────────────────────────────────────────────
    bool     isVoltageSaturated()  { return v_saturated; }
    bool     isCurrentSaturated()  { return i_saturated; }
    uint32_t getSaturationCount()  { return sat_count; }

    // ── Sample rate ───────────────────────────────────────────────────────
    float getActualSampleRateHz() { return actual_rate_hz; }

    // ── Drift rates ───────────────────────────────────────────────────────
    float getVoltageDriftRateVperS() { return v_drift_rate; }
    float getCurrentDriftRateAperS() { return i_drift_rate; }

    // ── Calibration quality ───────────────────────────────────────────────
    uint8_t getCalibrationQuality() { return calibration_quality; }

    // ── Variance ──────────────────────────────────────────────────────────
    float getVoltageVariance() { return v_variance; }
    float getCurrentVariance() { return i_variance; }

    // ── Raw ADC last values ───────────────────────────────────────────────
    int getLastRawV() { return last_raw_v; }
    int getLastRawI() { return last_raw_i; }
}