// =============================================================================
// GridVoltageSimulator.cpp
// See GridVoltageSimulator.h for full architecture documentation.
//
// All transcendental function calls (cosf, sinf, sqrtf, logf) appear ONLY
// in construction-time helpers (initOscillator, normalizeOscillator) and in
// the Box-Muller path which executes at most once every TWO ticks (z₁ caching).
// The hot real-time path in tick() contains ZERO trig calls.
// =============================================================================

#include "GridVoltageSimulator.h"
#include <cmath>  // cosf sinf sqrtf logf — Float32 FPU path on ESP32

// ── Float32 constants ─────────────────────────────────────────────────────────
static constexpr float kPi     = 3.14159265f;
static constexpr float kTwoPi  = 6.28318530f;
static constexpr float kSqrt2  = 1.41421356f;
// 1 / 2^32 — maps uint32 full range to (0, 1] after +1 offset
static constexpr float kUint32ToFloat = 2.32830644e-10f;

// ── Clamping helper ───────────────────────────────────────────────────────────
static inline float clampf(float v, float lo, float hi) {
    return (v < lo) ? lo : ((v > hi) ? hi : v);
}

// =============================================================================
// Construction
// =============================================================================
GridVoltageSimulator::GridVoltageSimulator(const Config& cfg, float dt_seconds)
    : norm_counter_(0u),
      z1_cached_(0.0f),
      z1_valid_(false),
      lfsr_state_(cfg.lfsr_seed ? cfg.lfsr_seed : 0xCAFEBABEu),
      flicker_enabled_(false),
      sagSwell_active_(false),
      sagSwell_target_alpha_(0.0f),
      sagSwell_current_alpha_(0.0f),
      sagSwell_elapsed_s_(0.0f),
      sagSwell_duration_s_(0.0f)
{
    // ── IEEE 519-2022 amplitude and harmonic clamping ─────────────────────────
    v_peak_     = cfg.v_rms * kSqrt2;
    alpha_h3_   = clampf(cfg.alpha_h3,   0.0f, 0.05f);
    alpha_h5_   = clampf(cfg.alpha_h5,   0.0f, 0.05f);
    alpha_h7_   = clampf(cfg.alpha_h7,   0.0f, 0.05f);
    noise_sigma_ = cfg.noise_sigma;
    flicker_m_  = clampf(cfg.flicker_m,  0.005f, 0.02f);

    // ── Coupled-form oscillator initialisation ────────────────────────────────
    // All oscillators start at phase zero (sin channel = 0, cos channel = 1).
    // The rotation coefficients are computed here from the fixed RTOS dt —
    // the ONLY place cosf/sinf is called for waveform generation.
    initOscillator(osc_fund_,  cfg.f_fundamental * 1.0f, dt_seconds, 0.0f);
    initOscillator(osc_h3_,    cfg.f_fundamental * 3.0f, dt_seconds, 0.0f);
    initOscillator(osc_h5_,    cfg.f_fundamental * 5.0f, dt_seconds, 0.0f);
    initOscillator(osc_h7_,    cfg.f_fundamental * 7.0f, dt_seconds, 0.0f);
    initOscillator(osc_flick_, 8.8f,                     dt_seconds, 0.0f);
    // IEC 61000-4-15 §5.3: human ocular system most sensitive at 8.8 Hz.
}

// =============================================================================
// Static oscillator helpers
// =============================================================================

void GridVoltageSimulator::initOscillator(Oscillator& o, float freq_hz,
                                           float dt_s, float init_phase_rad) {
    float theta = kTwoPi * freq_hz * dt_s;
    o.c  = cosf(theta);
    o.s  = sinf(theta);
    // Initial state: rotate identity by init_phase
    o.x1 = cosf(init_phase_rad);  // cosine channel
    o.x2 = sinf(init_phase_rad);  // sine   channel
}

// Euclidean renormalisation: projects (x1, x2) back onto the unit circle.
// Called every kNormPeriod ticks to correct accumulated Float32 rounding error.
void GridVoltageSimulator::normalizeOscillator(Oscillator& o) {
    float r2    = o.x1 * o.x1 + o.x2 * o.x2;
    float inv_r = 1.0f / sqrtf(r2);
    o.x1 *= inv_r;
    o.x2 *= inv_r;
}

// =============================================================================
// URNG: Xorshift32 — statistically superior to rand(), ~4 cycles on Xtensa
// Marsaglia (2003). Output mapped to (0, 1] by adding 1 before scaling.
// =============================================================================
float GridVoltageSimulator::uniformRandom() {
    lfsr_state_ ^= (lfsr_state_ << 13u);
    lfsr_state_ ^= (lfsr_state_ >> 17u);
    lfsr_state_ ^= (lfsr_state_ <<  5u);
    // +1 before multiply guarantees the result is never exactly 0.0f,
    // which would cause log(0) = -inf in Box-Muller.
    return (static_cast<float>(lfsr_state_) + 1.0f) * kUint32ToFloat;
}

// =============================================================================
// Box-Muller AWGN with z₁ caching
//
// Transform: U₁, U₂ ~ Uniform(0,1] →
//   z₀ = √(−2 ln U₁) · cos(2π U₂) ~ N(0,1)
//   z₁ = √(−2 ln U₁) · sin(2π U₂) ~ N(0,1)
//
// z₁ is stored in z1_cached_ and returned on the NEXT call without
// recomputing the transcendentals.  Average transcendental cost: 1 sqrtf +
// 1 logf + 1 cosf + 1 sinf per TWO ticks — acceptable for RTOS budgets.
// =============================================================================
float GridVoltageSimulator::gaussianSample() {
    if (z1_valid_) {
        z1_valid_ = false;
        return z1_cached_ * noise_sigma_;
    }
    float u1 = uniformRandom();   // guaranteed > 0, log safe
    float u2 = uniformRandom();
    float mag      = sqrtf(-2.0f * logf(u1));
    float twopi_u2 = kTwoPi * u2;
    float z0       = mag * cosf(twopi_u2);
    z1_cached_     = mag * sinf(twopi_u2);
    z1_valid_      = true;
    return z0 * noise_sigma_;
}

// =============================================================================
// Power-quality event triggers
// =============================================================================
void GridVoltageSimulator::triggerSag(float depth_pu, float duration_s) {
    sagSwell_target_alpha_ = -clampf(depth_pu,  0.1f, 0.9f);  // negative → subtract
    sagSwell_duration_s_   =  duration_s;
    sagSwell_elapsed_s_    =  0.0f;
    sagSwell_active_       =  true;
}

void GridVoltageSimulator::triggerSwell(float height_pu, float duration_s) {
    sagSwell_target_alpha_ = clampf(height_pu, 0.1f, 0.8f);   // positive → add
    sagSwell_duration_s_   = duration_s;
    sagSwell_elapsed_s_    = 0.0f;
    sagSwell_active_       = true;
}

void GridVoltageSimulator::enableFlicker(bool enable) {
    flicker_enabled_ = enable;
}

void GridVoltageSimulator::clearAnomalies() {
    sagSwell_active_        = false;
    sagSwell_target_alpha_  = 0.0f;
    sagSwell_current_alpha_ = 0.0f;
    sagSwell_elapsed_s_     = 0.0f;
    sagSwell_duration_s_    = 0.0f;
}

// =============================================================================
// tick() — O(1) deterministic real-time kernel
//
// Execution path (hot, no branches on harmonics/noise — always executed):
//   1. Advance 5 oscillators:  5 × (2 FPU muls + 1 add) = 10 muls + 5 adds
//   2. Conditional renormalise every 1024 ticks (amortised ~zero cost)
//   3. Amplitude modifier:  flicker (1 mul) + sag/swell (1 mul, conditional)
//   4. Waveform sum:         4 muls + 3 adds
//   5. AWGN:                 returns cached z₁ (1 mul) every other tick
// =============================================================================
float GridVoltageSimulator::tick(float dt_seconds) {
    // ── Step 1: Advance all oscillators ──────────────────────────────────────
    // Each call executes:  x1' = c·x1 − s·x2 ;  x2' = s·x1 + c·x2
    advanceOscillator(osc_fund_);
    advanceOscillator(osc_h3_);
    advanceOscillator(osc_h5_);
    advanceOscillator(osc_h7_);
    advanceOscillator(osc_flick_);

    // ── Step 2: Periodic Euclidean renormalisation ────────────────────────────
    // Float32 rounding causes the state vector to drift off the unit circle
    // at roughly 1 ULP / step.  After kNormPeriod steps the accumulated error
    // is ≲ kNormPeriod × 1.2e-7 ≈ 1.2e-4, well within ADC noise floor.
    if (++norm_counter_ >= kNormPeriod) {
        norm_counter_ = 0u;
        normalizeOscillator(osc_fund_);
        normalizeOscillator(osc_h3_);
        normalizeOscillator(osc_h5_);
        normalizeOscillator(osc_h7_);
        normalizeOscillator(osc_flick_);
    }

    // ── Step 3: Compute dynamic amplitude ────────────────────────────────────
    float amplitude = v_peak_;

    // IEC 61000-4-15 Flicker: AM modulation onto the fundamental carrier.
    //   v(t) = A₀·(1 + m·sin(2π·fM·t))·sin(ω₀·t)
    // osc_flick_.x2 = sin(2π·8.8·t) — no extra computation required.
    if (flicker_enabled_) {
        amplitude *= (1.0f + flicker_m_ * osc_flick_.x2);
    }

    // Sag / Swell with 10ms smooth interpolation ramp to prevent DSP filter shock
    if (sagSwell_active_) {
        sagSwell_elapsed_s_ += dt_seconds;
        float target = 0.0f;
        
        if (sagSwell_elapsed_s_ >= sagSwell_duration_s_) {
            target = 0.0f; // End of event, ramp back to nominal
            if (sagSwell_elapsed_s_ >= sagSwell_duration_s_ + 0.02f) { // 20ms full clear
                sagSwell_active_ = false;
            }
        } else {
            target = sagSwell_target_alpha_;
        }
        
        // IIR envelope smoothing (tau ~ 5ms). At 10kHz dt=0.0001, alpha=0.02.
        sagSwell_current_alpha_ += (target - sagSwell_current_alpha_) * 0.02f;
        amplitude *= (1.0f + sagSwell_current_alpha_);
    } else {
        sagSwell_current_alpha_ = 0.0f;
    }

    // ── Step 4: Fourier-series voltage synthesis ──────────────────────────────
    // v(t) = A(t)·[sin(ω₀t) + α₃·sin(3ω₀t) + α₅·sin(5ω₀t) + α₇·sin(7ω₀t)]
    // Sine outputs are the x2 channels of each coupled-form oscillator.
    float v = amplitude * (       osc_fund_.x2
                           + alpha_h3_ * osc_h3_.x2
                           + alpha_h5_ * osc_h5_.x2
                           + alpha_h7_ * osc_h7_.x2);

    // ── Step 5: Additive Gaussian White Noise (AWGN) ──────────────────────────
    // Simulates ADC thermal noise, EMI pick-up, and quantisation error.
    // gaussianSample() returns cached z₁ on even ticks (1 mul, no trig).
    v += gaussianSample();

    return v;
}
