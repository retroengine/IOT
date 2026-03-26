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
#include "config.h"
#include <esp_adc/adc_oneshot.h>   // IDF v5 oneshot hardware driver
#include <esp_adc/adc_cali.h>      // Abstract calibration API
#include <esp_adc/adc_cali_scheme.h> // Curve fitting / line fitting schemes
#include <cfloat>
#include <cmath>
#include <Arduino.h>

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

    // ── Protection signal path outputs (Finding #6 / #20) ────────────────
    // 4× oversampled + calibrated physical values, BEFORE any IIR or
    // moving average. FaultEngine consumes these as its input — its own
    // asymmetric IIR is then the single and only filter stage on the
    // protection signal path, eliminating the 4-stage cascade that was
    // attenuating 50ms short-circuit spikes to near noise.
    float raw_v_phys = 0.0f;   // volts, post-calibration, pre-IIR
    float raw_i_phys = 0.0f;   // amps,  post-calibration, pre-IIR

    // ── IDF v5 ADC handles ────────────────────────────────────────────────
    // One unit handle for ADC1, one calibration handle shared by both
    // channels (same unit + same attenuation → single cali scheme valid).
    adc_oneshot_unit_handle_t s_adc1_handle   = nullptr;
    adc_cali_handle_t         s_cali_handle   = nullptr;
    bool                      s_cali_active   = false;

    // calibration_quality: 0=none, 1=line fitting, 2=curve fitting
    uint8_t calibration_quality = 0;

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

    // ── IDF v5 calibration setup ──────────────────────────────────────────
    // Attempts curve fitting first (forward-compatible with newer silicon).
    // Falls back to line fitting (appropriate for original ESP32).
    // Falls back to uncalibrated (raw linear) if both fail.
    // Returns calibration_quality: 2=curve, 1=line, 0=none.
    uint8_t initCalibration() {
        esp_err_t ret;

        // ── Attempt 1: Curve Fitting (ESP32-S3, C3, C6 — not original ESP32) ──
#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
        {
            adc_cali_curve_fitting_config_t curve_cfg = {
                .unit_id  = ADC_UNIT_1,
                .chan     = ADC_CHANNEL_6,        // applies to both CH6/CH7 at same atten
                .atten    = ADC_ATTEN_DB_11,
                .bitwidth = ADC_BITWIDTH_DEFAULT,
            };
            ret = adc_cali_create_scheme_curve_fitting(&curve_cfg, &s_cali_handle);
            if (ret == ESP_OK) {
                s_cali_active = true;
                Serial.println("[ADC] Calibration: CURVE_FITTING (best)");
                return 2;
            }
            // ESP_ERR_NOT_SUPPORTED = silicon lacks curve fitting eFuse — fall through
            if (ret != ESP_ERR_NOT_SUPPORTED) {
                Serial.printf("[ADC] Curve fitting error: %s\n", esp_err_to_name(ret));
            }
        }
#endif

        // ── Attempt 2: Line Fitting (original ESP32 — uses eFuse Vref or 1100mV) ──
#if ADC_CALI_SCHEME_LINE_FITTING_SUPPORTED
        {
            adc_cali_line_fitting_config_t line_cfg = {
                .unit_id      = ADC_UNIT_1,
                .atten        = ADC_ATTEN_DB_11,
                .bitwidth     = ADC_BITWIDTH_DEFAULT,
                .default_vref = 1100,   // nominal fallback if eFuse Vref is absent
            };
            ret = adc_cali_create_scheme_line_fitting(&line_cfg, &s_cali_handle);
            if (ret == ESP_OK) {
                s_cali_active = true;
                Serial.println("[ADC] Calibration: LINE_FITTING");
                return 1;
            }
            Serial.printf("[ADC] Line fitting error: %s — running uncalibrated\n",
                          esp_err_to_name(ret));
        }
#endif

        // ── Fallback: No calibration — raw linear scaling ──────────────────
        s_cali_active = false;
        Serial.println("[ADC] Calibration: NONE (raw linear)");
        return 0;
    }

    // ── IDF v5 oversampling ───────────────────────────────────────────────
    // Reads ADC_OVERSAMPLE raw samples, averages them (pre-calibration),
    // then applies a single calibration pass to the mean.
    // Pre-calibration averaging is 75% cheaper than post-calibration
    // averaging and preserves full signal integrity for Gaussian noise.
    inline int oversample(adc_channel_t ch) {
        int32_t sum = 0;
        int     raw = 0;
        for (int k = 0; k < ADC_OVERSAMPLE; k++) {
            if (adc_oneshot_read(s_adc1_handle, ch, &raw) == ESP_OK) {
                sum += raw;
            }
        }
        return static_cast<int>(sum / ADC_OVERSAMPLE);
    }

    // ── Physical unit conversion ──────────────────────────────────────────
    // If calibrated: convert raw mean to millivolts via eFuse cali map,
    // then scale to physical units using the full-scale constants.
    // If uncalibrated: fall through to direct linear mapping on raw.
    inline float rawToVoltage(int raw) {
        if (s_cali_active && s_cali_handle) {
            int mv = 0;
            if (adc_cali_raw_to_voltage(s_cali_handle, raw, &mv) == ESP_OK) {
                // mv is in millivolts (0–3300 range for DB_11).
                // Scale to physical voltage using calibrated mV reference.
                return (static_cast<float>(mv) / 3300.0f) * VOLTAGE_FULL_SCALE;
            }
        }
        // Uncalibrated fallback: direct linear mapping
        return (static_cast<float>(raw) / ADC_MAX_RAW) * VOLTAGE_FULL_SCALE;
    }

    inline float rawToCurrent(int raw) {
        if (s_cali_active && s_cali_handle) {
            int mv = 0;
            if (adc_cali_raw_to_voltage(s_cali_handle, raw, &mv) == ESP_OK) {
                return (static_cast<float>(mv) / 3300.0f) * CURRENT_FULL_SCALE;
            }
        }
        return (static_cast<float>(raw) / ADC_MAX_RAW) * CURRENT_FULL_SCALE;
    }

    // ── All signal processing helpers unchanged from v2.0 ─────────────────

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

    // Compute sample variance from a rolling buffer.
    // Finding #9 fix: uses (count-1) denominator (Bessel's correction)
    // instead of count (population variance). For a 10-sample window this
    // corrects a 10% systematic underestimate (N/(N-1) = 10/9 = 1.11×).
    // Guard: returns 0 for count < 2 (insufficient samples for sample variance).
    float bufferVariance(float* buf, int count) {
        if (count < 2) return 0.0f;
        float sum = 0.0f, sq_sum = 0.0f;
        for (int k = 0; k < count; k++) {
            sum    += buf[k];
            sq_sum += buf[k] * buf[k];
        }
        float mean = sum / count;
        // Bessel's correction: divide by (count-1) not count
        float var  = (sq_sum - count * mean * mean) / (count - 1);
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
        // ── 1. Allocate ADC1 hardware unit ────────────────────────────────
        adc_oneshot_unit_init_cfg_t unit_cfg = {
            .unit_id  = ADC_UNIT_1,
            .ulp_mode = ADC_ULP_MODE_DISABLE,  // ESP32 CPU retains exclusive control
            .clk_src  = (adc_oneshot_clk_src_t)0,  // HAL selects default peripheral clock
        };
        esp_err_t ret = adc_oneshot_new_unit(&unit_cfg, &s_adc1_handle);
        if (ret != ESP_OK) {
            Serial.printf("[ADC] FATAL: adc_oneshot_new_unit failed: %s\n",
                          esp_err_to_name(ret));
            return;
        }

        // ── 2. Configure both channels: 12-bit, 11dB attenuation ──────────
        // 11dB → 0–3.3V nominal input range. Must be called per-channel.
        adc_oneshot_chan_cfg_t chan_cfg = {
            .bitwidth = ADC_BITWIDTH_DEFAULT,  // resolves to 12-bit on ESP32
            .atten    = ADC_ATTEN_DB_11,
        };

        ret = adc_oneshot_config_channel(s_adc1_handle, ADC_CHANNEL_6, &chan_cfg);
        if (ret != ESP_OK) {
            Serial.printf("[ADC] FATAL: config CH6 failed: %s\n", esp_err_to_name(ret));
            return;
        }

        ret = adc_oneshot_config_channel(s_adc1_handle, ADC_CHANNEL_7, &chan_cfg);
        if (ret != ESP_OK) {
            Serial.printf("[ADC] FATAL: config CH7 failed: %s\n", esp_err_to_name(ret));
            return;
        }

        // ── 3. Initialise calibration with curve→line→none fallback chain ─
        calibration_quality = initCalibration();

        // ── 4. Init min/max to impossible values so first sample resets them
        v_min =  FLT_MAX;  v_max = -FLT_MAX;
        i_min =  FLT_MAX;  i_max = -FLT_MAX;

        Serial.printf("[ADC] init complete — cal_quality=%d (%s)\n",
            calibration_quality,
            calibration_quality == 2 ? "CURVE_FITTING" :
            calibration_quality == 1 ? "LINE_FITTING"  : "NONE");
    }

    void tick() {
        // 1) Oversample raw ADC (pre-calibration: average integers, then calibrate once)
        int raw_v = oversample(ADC_CHANNEL_6);
        int raw_i = oversample(ADC_CHANNEL_7);

        last_raw_v = raw_v;
        last_raw_i = raw_i;

        // 2) Convert to physical units via IDF v5 calibration (or linear fallback)
        float v_new = rawToVoltage(raw_v);
        float i_new = rawToCurrent(raw_i);

        // ── Finding #6 / #20: store pre-IIR physical values ──────────────
        // These are the protection signal path outputs. FaultEngine reads
        // getRawVoltagePhys() / getRawCurrentPhys() and applies its own
        // asymmetric IIR as the single filter. No cascade attenuation.
        raw_v_phys = v_new;
        raw_i_phys = i_new;

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

    // ── Protection signal path (Finding #6 / #20) ─────────────────────────
    // Physical values after 4× oversampling + calibration ONLY.
    // No IIR. No moving average. FaultEngine uses these as its input
    // so its asymmetric IIR is the single filter on the protection path.
    float getRawVoltagePhys() { return raw_v_phys; }
    float getRawCurrentPhys() { return raw_i_phys; }
}
