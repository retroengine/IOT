// =============================================================================
// GridVoltageSimulator.h
// Hyper-realistic 230 V / 50 Hz Digital Twin Voltage Source
// ESP32 RTOS Software-in-the-Loop Module
//
// Architecture:
//   - Coupled-form (magic-circle) recursive oscillator:
//       x1' = c·x1 − s·x2
//       x2' = s·x1 + c·x2      ← sine output
//     c = cosf(θ), s = sinf(θ) computed ONCE at construction, never in loop.
//     Advances via 2 FPU multiplications + 1 addition per oscillator per tick.
//
//   - IEEE 519-2022 compliance: harmonic coefficients clamped ≤ 5 % of V_peak.
//     Synthesised waveform:
//       v(t) = A(t)·[sin(ω₀t) + α₃·sin(3ω₀t)
//                             + α₅·sin(5ω₀t)
//                             + α₇·sin(7ω₀t)] + η(t)
//
//   - AWGN: Box-Muller transform driven by Xorshift32 URNG.
//     z₁ cached across two consecutive calls → halves transcendental cost.
//
//   - Sag / Swell: Heaviside-switch amplitude modulation.
//       A_sag (t) = V_peak·(1 − α),   t₁ ≤ t < t₂
//       A_swell(t) = V_peak·(1 + α),  t₁ ≤ t < t₂
//
//   - IEC 61000-4-15 flicker: 8.8 Hz AM on the fundamental carrier.
//       v(t) = A₀·(1 + m·sin(2π·8.8·t))·sin(ω₀t)
//
// Hardware target: ESP32 Xtensa LX6 with 32-bit hardware FPU.
//   - ALL arithmetic is Float32.  No `double`, no standard sin()/cos().
//   - tick() executes in O(1) deterministic time, safe for RTOS ISR context.
// =============================================================================

#pragma once
#include <cstdint>

class GridVoltageSimulator {
public:
    // -------------------------------------------------------------------------
    // Configuration – every field is Float32
    // -------------------------------------------------------------------------
    struct Config {
        float    v_rms;         // Nominal RMS voltage                (230.0f  V)
        float    f_fundamental; // Fundamental frequency              ( 50.0f Hz)
        float    alpha_h3;      // 3rd harmonic coefficient   [0.0f … 0.05f]
        float    alpha_h5;      // 5th harmonic coefficient   [0.0f … 0.05f]
        float    alpha_h7;      // 7th harmonic coefficient   [0.0f … 0.05f]
        float    noise_sigma;   // AWGN standard deviation            (V)
        float    flicker_m;     // Flicker modulation index  [0.005f … 0.02f]
        uint32_t lfsr_seed;     // Xorshift32 seed  (MUST be non-zero)
    };

    // -------------------------------------------------------------------------
    // dt_seconds : fixed RTOS tick period used to pre-compute oscillator
    //              rotation coefficients.  Typically 50 µs … 200 µs.
    // -------------------------------------------------------------------------
    GridVoltageSimulator(const Config& cfg, float dt_seconds);

    // Advance one time step; returns instantaneous synthetic voltage (V).
    // dt_seconds passed here is used only for sag/swell duration tracking.
    float tick(float dt_seconds);

    // -------------------------------------------------------------------------
    // Power-quality event API
    // -------------------------------------------------------------------------
    // depth_pu ∈ [0.1, 0.9] : fraction of V_peak to subtract (sag)
    void triggerSag  (float depth_pu,  float duration_s);

    // height_pu ∈ [0.1, 0.8] : fraction of V_peak to add (swell)
    void triggerSwell(float height_pu, float duration_s);

    // Enable / disable IEC 61000-4-15 flicker modulation
    void enableFlicker(bool enable);

    // Safely clear any active sag/swell event and return to nominal amplitude.
    // Replaces the old triggerSag(0,0) hack which was clamped
    // to depth=0.1 by clampf(), creating a phantom 100ms 10% sag event every
    // time NORMAL_GRID was injected.
    void clearAnomalies();

    // -------------------------------------------------------------------------
    // Oscillator struct – exposed so the .cpp static helpers can be inlined
    // -------------------------------------------------------------------------
    struct Oscillator {
        float x1, x2;   // running state:  x1 = cosine channel, x2 = sine channel
        float c,  s;    // rotation coefficients: cosf(θ), sinf(θ)
    };

private:
    // ── Oscillator instances ─────────────────────────────────────────────────
    Oscillator osc_fund_;   //  50 Hz  fundamental
    Oscillator osc_h3_;     // 150 Hz  3rd harmonic
    Oscillator osc_h5_;     // 250 Hz  5th harmonic
    Oscillator osc_h7_;     // 350 Hz  7th harmonic
    Oscillator osc_flick_;  //   8.8 Hz flicker modulator

    uint32_t norm_counter_;
    // Renormalise every NORM_PERIOD ticks to suppress Float32 amplitude drift.
    // 1024 ticks @ 100 µs/tick ≈ 102 ms — imperceptible and deterministic.
    static constexpr uint32_t kNormPeriod = 1024u;

    // Rotation: x1' = c·x1 − s·x2 ;  x2' = s·x1 + c·x2
    // Inlined for zero function-call overhead in the RTOS loop.
    static inline void advanceOscillator(Oscillator& o) {
        float nx1 = o.c * o.x1 - o.s * o.x2;
        float nx2 = o.s * o.x1 + o.c * o.x2;
        o.x1 = nx1;
        o.x2 = nx2;
    }

    // Periodic Euclidean renormalisation: enforce ‖(x1, x2)‖ = 1
    static void normalizeOscillator(Oscillator& o);

    // Helper: initialise one oscillator from frequency and dt
    static void initOscillator(Oscillator& o, float freq_hz, float dt_s,
                                float init_phase_rad);

    // ── Box-Muller AWGN ──────────────────────────────────────────────────────
    float    z1_cached_;   // second output from previous Box-Muller call
    bool     z1_valid_;    // true when z1_cached_ holds a usable sample
    uint32_t lfsr_state_;  // Xorshift32 state

    float uniformRandom();  // returns U ~ Uniform(0, 1] via Xorshift32
    float gaussianSample(); // returns N(0, noise_sigma_) with z₁ caching

    // ── Waveform parameters (IEEE 519-2022 clamped at construction) ──────────
    float v_peak_;                         // √2 · v_rms
    float alpha_h3_, alpha_h5_, alpha_h7_; // clamped to [0, 0.05]
    float noise_sigma_;
    float flicker_m_;                      // clamped to [0.005, 0.02]
    bool  flicker_enabled_;

    // ── Sag / Swell state machine ────────────────────────────────────────────
    bool  sagSwell_active_;
    float sagSwell_target_alpha_;
    float sagSwell_current_alpha_;
    float sagSwell_elapsed_s_;
    float sagSwell_duration_s_;
};
