// ============================================================
//  sensor_diagnostics.cpp — Sensor Intelligence & Health Engine
//
//  Reads from ADCSampler and DS18B20 public APIs.
//  Computes structured health scores, power quality, and
//  stability metrics across all sensing channels.
//
//  Called from telemetry_builder::buildJSON() — no separate tick.
//  All state maintained in static storage — zero heap allocation.
// ============================================================
#include "sensor_diagnostics.h"
#include "adc_sampler.h"
#include "ds18b20.h"
#include "config.h"
#include <cmath>
#include <esp_system.h>
#include <Arduino.h>

namespace {

    // ── Power quality sliding window ──────────────────────────────────────
    // 60-sample window. At SENSOR_LOOP_MS=10ms this covers 600ms.
    // At COMMS_LOOP_MS=50ms and calling from buildJSON (every 5s) this
    // accumulates the last 60 voltage readings from the ADCSampler.
    static constexpr int PQ_WINDOW = 60;
    float pq_v_buf[PQ_WINDOW] = {};
    int   pq_idx   = 0;
    bool  pq_full  = false;

    // ── Thermal health state ──────────────────────────────────────────────
    uint32_t thermal_read_attempts = 0;
    uint32_t thermal_read_successes = 0;
    uint16_t thermal_disconnect_count = 0;
    bool     thermal_was_valid = false;

    // Thermal variance window (20 samples)
    static constexpr int TEMP_WINDOW = 20;
    float temp_hist[TEMP_WINDOW] = {};
    int   temp_hist_idx = 0;
    bool  temp_hist_full = false;

    // ── Cached last snapshot ──────────────────────────────────────────────
    DiagnosticsSnapshot s_last = {};

    // ── Score label helpers ───────────────────────────────────────────────
    const char* scoreLabel(uint8_t score) {
        if (score >= 90) return "EXCELLENT";
        if (score >= 75) return "GOOD";
        if (score >= 50) return "DEGRADED";
        return "FAULT";
    }

    // ── SNR computation ───────────────────────────────────────────────────
    // SNR = 20 * log10(signal / noise)
    // signal = filtered value (DC level)
    // noise  = RMS of residuals (high-frequency component)
    // Returns 0 dB if noise is at noise floor of float arithmetic.
    float computeSNR(float signal, float noise_rms) {
        if (noise_rms < 1e-6f || signal < 1e-3f) return 0.0f;
        float ratio = fabsf(signal) / noise_rms;
        return 20.0f * log10f(ratio);
    }

    // ── Linearity error estimate ──────────────────────────────────────────
    // ESP32 ADC non-linearity is well-documented: worst at mid-scale and
    // near rails. With DB_11 attenuation, typical non-linearity is 1–5%.
    // We estimate from calibration type — with two-point cal, the error
    // reduces significantly. Without cal, worst case ~5%.
    float estimateLinearityError(uint8_t cal_type, int raw_v) {
        // Base non-linearity by calibration quality
        float base_error = (cal_type == 2) ? 1.0f :
                           (cal_type == 1) ? 2.5f : 5.0f;

        // Non-linearity is worst in the mid-scale hump (1000–3000 raw)
        // and at rails. Scale penalty accordingly.
        float pos = (float)raw_v / 4095.0f;  // 0.0 to 1.0
        float mid_penalty = 0.0f;
        if (pos > 0.25f && pos < 0.75f) {
            // Mid-scale: extra 0.5% worst at center
            float dist_from_center = fabsf(pos - 0.5f);
            mid_penalty = (0.25f - dist_from_center) * 2.0f;  // 0–0.5%
        }

        return base_error + mid_penalty;
    }

    // ── Voltage stability score ───────────────────────────────────────────
    uint8_t scoreVoltage(float noise_v, float snr_db, bool saturated,
                         uint8_t cal_type, uint32_t sample_count) {
        int score = 100;

        // Noise floor penalty
        if (noise_v > 10.0f)  score -= 35;
        else if (noise_v > 5.0f)  score -= 20;
        else if (noise_v > 2.0f)  score -= 10;
        else if (noise_v > 1.0f)  score -= 5;

        // SNR penalty
        if (snr_db < 15.0f)   score -= 30;
        else if (snr_db < 25.0f)  score -= 15;
        else if (snr_db < 35.0f)  score -= 5;

        // Saturation: likely open circuit or overrange
        if (saturated) score -= 30;

        // Calibration quality
        if (cal_type == 0)       score -= 15;
        else if (cal_type == 1)  score -= 5;
        // cal_type == 2: no penalty

        // Warmup penalty (filter not fully converged)
        if (sample_count < (uint32_t)MOVING_AVG_DEPTH) score -= 20;

        return (score < 0) ? 0 : (uint8_t)min(score, 100);
    }

    // ── Current stability score ───────────────────────────────────────────
    uint8_t scoreCurrent(float noise_a, float snr_db, bool saturated,
                         uint8_t cal_type, uint32_t sample_count) {
        int score = 100;

        // Current noise thresholds are tighter (5A full scale, not 300V)
        if (noise_a > 0.5f)   score -= 35;
        else if (noise_a > 0.2f)  score -= 20;
        else if (noise_a > 0.1f)  score -= 10;
        else if (noise_a > 0.05f) score -= 5;

        if (snr_db < 15.0f)   score -= 30;
        else if (snr_db < 25.0f)  score -= 15;
        else if (snr_db < 35.0f)  score -= 5;

        if (saturated) score -= 30;

        if (cal_type == 0)       score -= 15;
        else if (cal_type == 1)  score -= 5;

        if (sample_count < (uint32_t)MOVING_AVG_DEPTH) score -= 20;

        return (score < 0) ? 0 : (uint8_t)min(score, 100);
    }

    // ── Thermal health ────────────────────────────────────────────────────
    void updateThermalState(float temp_c) {
        thermal_read_attempts++;

        bool valid = (temp_c > -100.0f) && DS18B20::isReady();

        if (valid) {
            thermal_read_successes++;

            // Track disconnect → reconnect events
            if (!thermal_was_valid && thermal_read_attempts > 1) {
                // Was disconnected, now valid: reconnect event (not counted as disconnect)
            }
            thermal_was_valid = true;

            // Update temperature history for variance computation
            temp_hist[temp_hist_idx % TEMP_WINDOW] = temp_c;
            if (temp_hist_idx == TEMP_WINDOW - 1) temp_hist_full = true;
            temp_hist_idx = (temp_hist_idx + 1) % TEMP_WINDOW;

        } else {
            if (thermal_was_valid) {
                thermal_disconnect_count++;
                Serial.printf("[DIAG] Thermal disconnect #%d\n", thermal_disconnect_count);
            }
            thermal_was_valid = false;
        }
    }

    float computeThermalVariance() {
        int count = temp_hist_full ? TEMP_WINDOW : temp_hist_idx;
        if (count < 2) return 0.0f;
        float sum = 0.0f, sq = 0.0f;
        for (int k = 0; k < count; k++) {
            sum += temp_hist[k];
            sq  += temp_hist[k] * temp_hist[k];
        }
        float mean = sum / count;
        float var  = (sq / count) - (mean * mean);
        return (var > 0.0f) ? var : 0.0f;
    }

    uint8_t scoreThermal(bool present, uint8_t success_rate,
                         uint16_t disconnects, float variance) {
        if (!present) return 0;

        int score = 100;

        // Success rate
        if (success_rate < 50)  score -= 40;
        else if (success_rate < 80)  score -= 20;
        else if (success_rate < 95)  score -= 10;

        // Disconnect history
        if (disconnects > 10)  score -= 30;
        else if (disconnects > 3)   score -= 15;
        else if (disconnects > 0)   score -= 5;

        // Temperature stability (variance > 4 = changing by ~2°C — suspicious)
        if (variance > 16.0f)  score -= 20;
        else if (variance > 4.0f)   score -= 10;
        else if (variance > 1.0f)   score -= 5;

        return (score < 0) ? 0 : (uint8_t)min(score, 100);
    }

    // ── Power quality computation ─────────────────────────────────────────
    void pushPowerQualityWindow(float v) {
        pq_v_buf[pq_idx % PQ_WINDOW] = v;
        if (pq_idx == PQ_WINDOW - 1) pq_full = true;
        pq_idx = (pq_idx + 1) % PQ_WINDOW;
    }

    PowerQuality computePowerQuality(float voltage_v, float current_a) {
        PowerQuality pq = {};
        pq.nominal_voltage_v      = NOMINAL_VOLTAGE_V;
        pq.power_factor_estimated = 0.85f;  // assumed — not measured on DC proxy

        pushPowerQualityWindow(voltage_v);

        int count = pq_full ? PQ_WINDOW : (pq_idx == 0 ? 1 : pq_idx);
        if (count < 1) {
            pq.real_power_w       = voltage_v * current_a * 0.85f;
            pq.apparent_power_va  = voltage_v * current_a;
            pq.voltage_stability_score = 50;
            pq.power_quality_label     = "UNKNOWN";
            return pq;
        }

        float sum = 0.0f, sq_sum = 0.0f;
        float v_min_w = pq_v_buf[0], v_max_w = pq_v_buf[0];
        for (int k = 0; k < count; k++) {
            float v = pq_v_buf[k];
            sum    += v;
            sq_sum += v * v;
            if (v < v_min_w) v_min_w = v;
            if (v > v_max_w) v_max_w = v;
        }
        float mean   = sum / count;
        float var    = (sq_sum / count) - (mean * mean);
        if (var < 0.0f) var = 0.0f;

        float p2p = v_max_w - v_min_w;

        pq.mean_voltage_v    = mean;
        pq.voltage_deviation_pct = (mean > 0.1f) ?
            fabsf(mean - NOMINAL_VOLTAGE_V) / NOMINAL_VOLTAGE_V * 100.0f : 0.0f;

        // Sag: how far below nominal the minimum went
        pq.sag_depth_v   = (v_min_w < NOMINAL_VOLTAGE_V) ?
                            (NOMINAL_VOLTAGE_V - v_min_w) : 0.0f;

        // Swell: how far above nominal the maximum went
        pq.swell_height_v = (v_max_w > NOMINAL_VOLTAGE_V) ?
                             (v_max_w - NOMINAL_VOLTAGE_V) : 0.0f;

        // Ripple: peak-to-peak / mean (DC proxy for distortion content)
        pq.ripple_pct = (mean > 0.1f) ? (p2p / mean) * 100.0f : 0.0f;

        // Flicker index: variance / mean² (IEC 61000-4-15 proxy)
        pq.flicker_index = (mean > 0.1f) ? (var / (mean * mean)) : 0.0f;

        // Power metrics
        pq.apparent_power_va  = mean * current_a;
        pq.real_power_w       = pq.apparent_power_va * pq.power_factor_estimated;

        // Stability score
        int s = 100;
        if (pq.voltage_deviation_pct > 15.0f)  s -= 40;
        else if (pq.voltage_deviation_pct > 10.0f)  s -= 25;
        else if (pq.voltage_deviation_pct > 5.0f)   s -= 10;
        else if (pq.voltage_deviation_pct > 2.0f)   s -= 5;

        if (pq.sag_depth_v > 50.0f)   s -= 25;
        else if (pq.sag_depth_v > 20.0f)   s -= 15;
        else if (pq.sag_depth_v > 10.0f)   s -= 5;

        if (pq.swell_height_v > 30.0f)  s -= 20;
        else if (pq.swell_height_v > 15.0f)  s -= 10;

        if (pq.ripple_pct > 10.0f)  s -= 20;
        else if (pq.ripple_pct > 5.0f)   s -= 10;
        else if (pq.ripple_pct > 2.0f)   s -= 5;

        if (pq.flicker_index > 0.05f)  s -= 15;
        else if (pq.flicker_index > 0.02f) s -= 7;

        pq.voltage_stability_score = (s < 0) ? 0 : (uint8_t)min(s, 100);

        if (pq.voltage_stability_score >= 90) pq.power_quality_label = "EXCELLENT";
        else if (pq.voltage_stability_score >= 75) pq.power_quality_label = "GOOD";
        else if (pq.voltage_stability_score >= 50) pq.power_quality_label = "FAIR";
        else pq.power_quality_label = "POOR";

        return pq;
    }

    // ── Overall health score ──────────────────────────────────────────────
    uint8_t computeOverallScore(const DiagnosticsSnapshot& s) {
        // Weighted average: voltage 25%, current 20%, thermal 20%, ADC 15%, power 20%
        float weighted =
            s.voltage.stability_score      * 0.25f +
            s.current.stability_score      * 0.20f +
            s.thermal.stability_score      * 0.20f +
            s.adc.health_score             * 0.15f +
            s.power_quality.voltage_stability_score * 0.20f;

        return (uint8_t)min((int)weighted, 100);
    }
}

namespace SensorDiagnostics {

    DiagnosticsSnapshot compute(float voltage_v, float current_a, float temp_c) {

        DiagnosticsSnapshot snap = {};
        snap.computed_at_ms = millis();

        uint32_t sample_count  = ADCSampler::getSampleCount();
        uint8_t  cal_type      = ADCSampler::getCalibrationQuality();
        int      last_raw_v    = ADCSampler::getLastRawV();

        // ── Voltage Health ────────────────────────────────────────────────
        {
            float noise_v  = ADCSampler::getNoiseFloorV();
            float snr_db   = computeSNR(voltage_v, noise_v);

            snap.voltage.noise_floor_v      = noise_v;
            snap.voltage.drift_rate_v_per_s = ADCSampler::getVoltageDriftRateVperS();
            snap.voltage.min_seen_v         = ADCSampler::getVoltageMin();
            snap.voltage.max_seen_v         = ADCSampler::getVoltageMax();
            snap.voltage.peak_to_peak_v     = snap.voltage.max_seen_v - snap.voltage.min_seen_v;
            snap.voltage.saturated          = ADCSampler::isVoltageSaturated();
            snap.voltage.snr_db             = snr_db;
            snap.voltage.variance           = ADCSampler::getVoltageVariance();
            snap.voltage.stability_score    = scoreVoltage(
                noise_v, snr_db, snap.voltage.saturated, cal_type, sample_count);
            snap.voltage.stability_label    = scoreLabel(snap.voltage.stability_score);
        }

        // ── Current Health ────────────────────────────────────────────────
        {
            float noise_a = ADCSampler::getNoiseFloorA();
            float snr_db  = computeSNR(current_a, noise_a);

            snap.current.noise_floor_a      = noise_a;
            snap.current.drift_rate_a_per_s = ADCSampler::getCurrentDriftRateAperS();
            snap.current.min_seen_a         = ADCSampler::getCurrentMin();
            snap.current.max_seen_a         = ADCSampler::getCurrentMax();
            snap.current.saturated          = ADCSampler::isCurrentSaturated();
            snap.current.snr_db             = snr_db;
            snap.current.variance           = ADCSampler::getCurrentVariance();
            snap.current.stability_score    = scoreCurrent(
                noise_a, snr_db, snap.current.saturated, cal_type, sample_count);
            snap.current.stability_label    = scoreLabel(snap.current.stability_score);
        }

        // ── Thermal Health ────────────────────────────────────────────────
        {
            updateThermalState(temp_c);

            bool valid = (temp_c > -100.0f) && DS18B20::isReady();
            uint8_t success_rate = (thermal_read_attempts > 0)
                ? (uint8_t)((thermal_read_successes * 100) / thermal_read_attempts)
                : 0;

            snap.thermal.read_success_rate  = success_rate;
            snap.thermal.disconnect_count   = thermal_disconnect_count;
            snap.thermal.reading_age_ms     = 0;  // DS18B20 doesn't expose last read ts
            snap.thermal.sensor_present     = valid;
            snap.thermal.temp_variance      = computeThermalVariance();
            snap.thermal.temp_stable        = (snap.thermal.temp_variance < 4.0f);
            snap.thermal.stability_score    = scoreThermal(
                valid, success_rate, thermal_disconnect_count, snap.thermal.temp_variance);
            snap.thermal.stability_label    = valid ? scoreLabel(snap.thermal.stability_score)
                                                    : "FAULT";
        }

        // ── ADC Hardware Health ───────────────────────────────────────────
        {
            float actual_rate    = ADCSampler::getActualSampleRateHz();
            float expected_rate  = 1000.0f / SENSOR_LOOP_MS;
            float rate_dev_pct   = (expected_rate > 0.0f)
                ? fabsf(actual_rate - expected_rate) / expected_rate * 100.0f
                : 0.0f;

            const char* cal_labels[] = { "NONE", "EFUSE_VREF", "EFUSE_TP" };

            snap.adc.calibration_type           = cal_type;
            snap.adc.calibration_label          = cal_labels[min(cal_type, (uint8_t)2)];
            snap.adc.linearity_error_pct        = estimateLinearityError(cal_type, last_raw_v);
            snap.adc.actual_sample_rate_hz      = actual_rate;
            snap.adc.expected_sample_rate_hz    = expected_rate;
            snap.adc.sample_rate_deviation_pct  = rate_dev_pct;
            snap.adc.saturation_events          = ADCSampler::getSaturationCount();
            snap.adc.voltage_saturated          = ADCSampler::isVoltageSaturated();
            snap.adc.current_saturated          = ADCSampler::isCurrentSaturated();

            // ADC health score
            int s = 100;
            if (cal_type == 0)        s -= 20;
            else if (cal_type == 1)   s -= 8;
            if (rate_dev_pct > 20.0f)   s -= 20;
            else if (rate_dev_pct > 10.0f)   s -= 10;
            if (snap.adc.saturation_events > 0) s -= 15;
            if (snap.adc.linearity_error_pct > 4.0f) s -= 10;
            else if (snap.adc.linearity_error_pct > 2.0f) s -= 5;
            snap.adc.health_score = (s < 0) ? 0 : (uint8_t)min(s, 100);
        }

        // ── Power Quality ─────────────────────────────────────────────────
        snap.power_quality = computePowerQuality(voltage_v, current_a);

        // ── System Diagnostics ────────────────────────────────────────────
        {
            uint32_t uptime_s     = millis() / 1000;
            uint32_t free_heap    = esp_get_free_heap_size();

            snap.system.uptime_s         = uptime_s;
            snap.system.free_heap_bytes  = free_heap;
            snap.system.heap_healthy     = (free_heap > HEAP_WARN_BYTES);

            if      (uptime_s < 300)    snap.system.uptime_quality = "WARMING_UP";
            else if (uptime_s < 3600)   snap.system.uptime_quality = "SETTLING";
            else                        snap.system.uptime_quality = "STABLE";

            // CPU load estimate from sample rate deviation
            float rate_dev = snap.adc.sample_rate_deviation_pct;
            snap.system.cpu_load_estimate_pct = min(rate_dev * 2.0f, 100.0f);

            snap.system.overall_health_score = computeOverallScore(snap);

            if      (snap.system.overall_health_score >= 85) snap.system.health_status = "HEALTHY";
            else if (snap.system.overall_health_score >= 60) snap.system.health_status = "DEGRADED";
            else                                              snap.system.health_status = "CRITICAL";
        }

        s_last = snap;
        return snap;
    }

    const DiagnosticsSnapshot& lastSnapshot() {
        return s_last;
    }
}
