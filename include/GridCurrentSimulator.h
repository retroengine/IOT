// =============================================================================
// GridCurrentSimulator.h
// Digital Twin Load-Current and CT Sensor Model
// ESP32 RTOS Software-in-the-Loop Module
//
// Architecture:
//   ┌──────────────────────────────────────────────────────────────────────┐
//   │  Induction Motor DOL Inrush Model                                    │
//   │                                                                      │
//   │  i_primary(t) = I_DC(t) + I_AC(s(t)) · sin(ω₀t + φ_close)         │
//   │                                                                      │
//   │  DC Offset (flux-continuity boundary condition):                     │
//   │    I_DC(t) = I_DC0 · exp(−t / τ_stator)                            │
//   │    Implemented as:  I_DC_state *= dc_decay_factor_  per tick         │
//   │    (one FPU multiply — no expf() in real-time loop)                  │
//   │                                                                      │
//   │  Slip dynamics (mechanical acceleration):                            │
//   │    s(t) = s_rated + (s(t−dt) − s_rated) · slip_decay_factor_        │
//   │    slip_decay_factor_ = expf(−dt / τ_mech)  at construction         │
//   │                                                                      │
//   │  Slip-dependent rotor skin-effect (current displacement):            │
//   │    R'₂(s) = R₂N + (R₂_standstill − R₂N) · s                       │
//   │    X'₂(s) = X₂a + (X₂N − X₂a) · (1 − s)                           │
//   │                                                                      │
//   │  AC current magnitude from T-equivalent circuit:                     │
//   │    I_AC_peak(s) = V_phase / √[(R₁ + R'₂(s)/s)² + (X₁ + X'₂(s))²] │
//   └──────────────────────────────────────────────────────────────────────┘
//
//   ┌──────────────────────────────────────────────────────────────────────┐
//   │  CT Saturation Model  (Arctangent fractional, 3-parameter)           │
//   │                                                                      │
//   │  Smooth compression through the B-H knee:                           │
//   │    i_sec_sat = I_sat · arctan(a · i_sec_ideal)                      │
//   │                       ─────────────────────────                     │
//   │                         arctan(a · I_knee)                           │
//   │                                                                      │
//   │  Volt-time area flux accumulation:                                  │
//   │    φ(t) ≈ φ(t−dt) · leak + V_x · dt                                │
//   │    V_x = i_sec_ideal · (R_CT + Z_burden)                            │
//   │    Hard clamp to zero secondary when |φ| ≥ φ_sat                   │
//   └──────────────────────────────────────────────────────────────────────┘
//
// ESP32 constraints:
//   - ALL arithmetic is Float32.  No `double`.
//   - expf() called ONLY at construction (decay factors pre-computed).
//   - tick() is O(1) deterministic; safe for RTOS tick ISR.
// =============================================================================

#pragma once
#include <cstdint>

class GridCurrentSimulator {
public:
    // -------------------------------------------------------------------------
    // Induction motor equivalent-circuit parameters
    // All resistances / reactances in Ohms, referred to stator side.
    // -------------------------------------------------------------------------
    struct MotorParams {
        float V_phase;          // Peak phase voltage driving the stator (V)
        float R1;               // Stator winding resistance (Ω)
        float X1;               // Stator leakage reactance at 50 Hz (Ω)
        float R2N;              // Nominal rotor resistance at rated slip (Ω)
        float R2_standstill;    // Rotor resistance at standstill s=1 — skin effect (Ω)
                                //   Typically 2–4× R2N for deep-bar rotors.
        float X2N;              // Rotor leakage reactance at rated slip (Ω)
        float X2a;              // Rotor leakage reactance at standstill s=1 (Ω)
                                //   Typically 0.3–0.6× X2N due to flux path constriction.
        float tau_stator;       // L/R DC-offset decay time constant (s) ≈ L_s / (R1 + R2)
        float tau_mech;         // Mechanical acceleration time constant (s)
                                //   Controls slip decay rate s(t) → s_rated.
        float phi_close_rad;    // Voltage angle at breaker close (rad).
                                //   φ = 0 → zero-crossing start → maximum DC offset.
                                //   φ = π/2 → voltage peak start  → zero DC offset.
        float s_rated;          // Rated full-load slip (e.g., 0.04f)
    };

    // -------------------------------------------------------------------------
    // Current Transformer parameters
    // -------------------------------------------------------------------------
    struct CTParams {
        float turns_ratio;   // N = N_primary / N_secondary
        float R_ct;          // CT secondary winding resistance (Ω)
        float Z_burden;      // External relay/metering burden magnitude (Ω)
        float I_knee;        // Knee-point current on secondary (A).
                             //   arctangent model: at I_knee, output ≈ 0.785 · I_sat.
        float I_sat;         // Asymptotic saturation limit, secondary (A)
        float arctan_a;      // Arctangent model shape parameter (1/A).
                             //   Set to (π/2)/I_knee for normalised knee-point.
        float phi_sat;       // Flux saturation threshold (Wb).
                             //   Must exceed steady-state peak flux:
                             //   φ_ss_peak = I_sec_peak·(R_ct+Z_burden) / (2π·f₀).
                             //   Hard-clamp to zero output when |φ_accum| ≥ φ_sat.
        float flux_leak;     // Per-tick flux leakage factor ∈ (0.9990, 1.0f).
                             //   Removes integration DC offset between events.
                             //   Typical: expf(−dt / 1.0f) for 1-second decay.
    };

    // -------------------------------------------------------------------------
    // Constructor
    //   f_fundamental : fundamental grid frequency (Hz)
    //   dt_seconds    : fixed RTOS tick period
    // Oscillator rotation coefficients and exponential decay factors are
    // computed here — NEVER inside tick().
    // -------------------------------------------------------------------------
    GridCurrentSimulator(float f_fundamental,
                         const MotorParams& mp,
                         const CTParams&    ct,
                         float dt_seconds);

    // Advance one time step; returns CT secondary current (A), saturated.
    float tick(float dt_seconds);

    // -------------------------------------------------------------------------
    // Motor control API
    // -------------------------------------------------------------------------
    // Trigger a Direct-On-Line start.
    // Sets slip = 1, computes I_DC0 from phi_close_rad, resets flux accumulator.
    void triggerMotorStart();

    // Disconnect motor; clears inrush state and flux accumulator.
    void stopMotor();

    // -------------------------------------------------------------------------
    // Baseline load API
    // -------------------------------------------------------------------------
    // Sets a continuous sinusoidal base load (A RMS) independent of motor state.
    void setBaseLoad(float rms_current) { base_load_rms_ = rms_current; }

    // -------------------------------------------------------------------------
    // Oscillator struct (same layout as GridVoltageSimulator for portability)
    // -------------------------------------------------------------------------
    struct Oscillator {
        float x1, x2;  // cosine / sine channels
        float c,  s;   // rotation coefficients
    };

private:
    float f0_;
    float dt_nom_;  // nominal dt stored for guard-band checks

    // ── 50 Hz current waveform oscillator ────────────────────────────────────
    Oscillator osc_curr_;
    uint32_t   norm_counter_;
    static constexpr uint32_t kNormPeriod = 1024u;

    static inline void advanceOscillator(Oscillator& o) {
        float nx1 = o.c * o.x1 - o.s * o.x2;
        float nx2 = o.s * o.x1 + o.c * o.x2;
        o.x1 = nx1;
        o.x2 = nx2;
    }
    static void normalizeOscillator(Oscillator& o);

    // ── Motor DOL inrush state ────────────────────────────────────────────────
    MotorParams mp_;
    bool  motor_active_;
    float slip_;              // Current slip value, decays from 1 → s_rated
    float I_DC_state_;        // Running DC-offset current (A); decays per tick
    float dc_decay_factor_;   // expf(−dt / tau_stator) — pre-computed
    float slip_decay_factor_; // expf(−dt / tau_mech)   — pre-computed

    // Slip-dependent rotor parameters (linear skin-effect interpolation)
    float computeR2slip(float s) const;
    float computeX2slip(float s) const;

    // AC peak current from T-equivalent circuit at slip s
    float computeACPeakCurrent(float s) const;

    // ── CT saturation state ───────────────────────────────────────────────────
    CTParams ct_;
    float    flux_accum_;  // Integrated volt-time flux (Wb); leaky integrator

    // Apply arctangent saturation + volt-time hard cutoff.
    // Returns saturated CT secondary current.
    float applyCTSaturation(float i_primary, float dt_s);

    float base_load_rms_ = 0.0f;
};
