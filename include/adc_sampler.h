// ============================================================
//  adc_sampler.h — ADC Sampler Public API
//  Voltage: GPIO34 ADC1_CH6 → 0–300 V
//  Current: GPIO35 ADC1_CH7 → 0–5 A
//
//  Expanded v2.0 API adds:
//    - Noise floor (RMS residual voltage/current)
//    - Min/max seen since boot
//    - Saturation flags (ADC rail hit)
//    - Actual measured sample rate
//    - Drift rate (V/s and A/s)
//    - Welford online variance for SNR computation
//    - ADC calibration type exposure
// ============================================================
#pragma once
#include <Arduino.h>

namespace ADCSampler {

    // ── Core lifecycle ────────────────────────────────────────────────────
    void     init();
    void     tick();

    // ── Primary filtered outputs ──────────────────────────────────────────
    float    getVoltage();          // IIR + rolling-avg filtered, volts
    float    getCurrent();          // IIR + rolling-avg filtered, amps
    uint32_t getSampleCount();      // total samples since boot

    // ── Noise floor (RMS of raw-minus-filtered residuals) ─────────────────
    // Computed from an exponential moving RMS of residuals.
    // Represents high-frequency noise on each channel.
    float    getNoiseFloorV();      // noise RMS in volts
    float    getNoiseFloorA();      // noise RMS in amps

    // ── Min / Max seen since boot ──────────────────────────────────────────
    // Tracks the all-time extremes of the filtered output.
    float    getVoltageMin();
    float    getVoltageMax();
    float    getCurrentMin();
    float    getCurrentMax();

    // ── Saturation detection ───────────────────────────────────────────────
    // True if any ADC sample hit 0 or ADC_MAX_RAW (4095).
    // Indicates sensor wiring fault, overrange, or open circuit.
    bool     isVoltageSaturated();
    bool     isCurrentSaturated();
    uint32_t getSaturationCount();  // total saturation events since boot

    // ── Actual sample rate ────────────────────────────────────────────────
    // Measured from real tick() call timing, not config constant.
    // Deviates from config if Core-0 task is starved.
    float    getActualSampleRateHz();

    // ── Drift rate ────────────────────────────────────────────────────────
    // Difference between fast EMA (α=0.1) and slow EMA (α=0.005), per second.
    // Positive = rising. Negative = falling. Near-zero = stable.
    float    getVoltageDriftRateVperS();
    float    getCurrentDriftRateAperS();

    // ── ADC calibration quality ───────────────────────────────────────────
    // 0 = not calibrated
    // 1 = calibrated using eFuse Vref
    // 2 = calibrated using eFuse Two-Point (best accuracy)
    uint8_t  getCalibrationQuality();   // 0, 1, or 2

    // ── Welford running variance (for SNR in diagnostics) ─────────────────
    // Population variance of the filtered voltage/current values
    // over the last MOVING_AVG_DEPTH samples.
    float    getVoltageVariance();
    float    getCurrentVariance();

    // ── Raw ADC reads (last oversampled value before filtering) ───────────
    // Used by sensor_diagnostics for linearity estimation.
    int      getLastRawV();   // 0–4095
    int      getLastRawI();   // 0–4095
}
