// =============================================================================
// GridCurrentSimulator.cpp
// See GridCurrentSimulator.h for full architecture documentation.
//
// Real-time loop optimisations:
//   - No expf() in tick(): replaced by  state *= pre_computed_factor
//   - No sqrtf() branch on hot path (sqrtf for Z_mag is ~4 cycles on FPU)
//   - No atanf() branch on hot path: CT model uses atanf() which is ESP32
//     FPU-native and explicitly endorsed by the PDF for embedded arctangent CT
//     saturation (see §"Fröhlich Equation and Arctangent Approximations").
//   - All FP constants carry the 'f' suffix to force single-precision.
// =============================================================================

#include "GridCurrentSimulator.h"
#include <cmath>   // cosf sinf sqrtf expf fabsf atanf

// ── Float32 constants ─────────────────────────────────────────────────────────
static constexpr float kPi     = 3.14159265f;
static constexpr float kTwoPi  = 6.28318530f;
static constexpr float kHalfPi = 1.57079632f;

// ── Utility ───────────────────────────────────────────────────────────────────
static inline float clampf(float v, float lo, float hi) {
    return (v < lo) ? lo : ((v > hi) ? hi : v);
}

// =============================================================================
// Construction
// =============================================================================
GridCurrentSimulator::GridCurrentSimulator(float f_fundamental,
                                           const MotorParams& mp,
                                           const CTParams&    ct,
                                           float dt_seconds)
    : f0_(f_fundamental),
      dt_nom_(dt_seconds),
      mp_(mp),
      ct_(ct),
      motor_active_(false),
      slip_(0.0f),
      I_DC_state_(0.0f),
      flux_accum_(0.0f),
      norm_counter_(0u)
{
    // ── Pre-compute exponential decay factors ─────────────────────────────────
    // These are computed ONCE here and used in tick() as simple multiplications.
    // tau_stator guards against divide-by-zero on misconfiguration.
    dc_decay_factor_   = (mp_.tau_stator > 1.0e-6f)
                         ? expf(-dt_seconds / mp_.tau_stator)
                         : 0.0f;

    slip_decay_factor_ = (mp_.tau_mech > 1.0e-6f)
                         ? expf(-dt_seconds / mp_.tau_mech)
                         : 0.0f;

    // ── Initialise current oscillator (50 Hz) ────────────────────────────────
    // x1 = cos(φ_close), x2 = sin(φ_close)
    // The oscillator tracks the instantaneous phase of the grid voltage at the
    // moment of breaker closure.  The AC current waveform uses x2 (sine).
    float theta = kTwoPi * f_fundamental * dt_seconds;
    osc_curr_.c  = cosf(theta);
    osc_curr_.s  = sinf(theta);
    osc_curr_.x1 = cosf(mp_.phi_close_rad);
    osc_curr_.x2 = sinf(mp_.phi_close_rad);
}

// =============================================================================
// Oscillator helpers
// =============================================================================
void GridCurrentSimulator::normalizeOscillator(Oscillator& o) {
    float r2    = o.x1 * o.x1 + o.x2 * o.x2;
    float inv_r = 1.0f / sqrtf(r2);
    o.x1 *= inv_r;
    o.x2 *= inv_r;
}

// =============================================================================
// Motor control API
// =============================================================================
void GridCurrentSimulator::triggerMotorStart() {
    motor_active_ = true;
    slip_         = 1.0f;   // cold start: full slip

    // ── DC offset boundary condition ──────────────────────────────────────────
    // At the instant of breaker closure, flux linkages in the stator inductance
    // cannot change instantaneously.  The resulting unidirectional DC offset is
    // maximised when the voltage crosses zero (φ_close = 0).
    //
    //   I_DC0 = −I_LR_peak · sin(φ_close)
    //
    // where I_LR_peak is the locked-rotor (standstill, s=1) peak current.
    // The negation is the boundary condition from the circuit DE solution;
    // sign is captured automatically in the subsequent decay and oscillator.
    float I_LR_peak = computeACPeakCurrent(1.0f);
    I_DC_state_     = -I_LR_peak * sinf(mp_.phi_close_rad);

    flux_accum_ = 0.0f;   // reset CT flux state for new transient event
}

void GridCurrentSimulator::stopMotor() {
    motor_active_ = false;
    slip_         = 0.0f;
    I_DC_state_   = 0.0f;
    flux_accum_   = 0.0f;
}

// =============================================================================
// Slip-dependent rotor parameter model (linear skin-effect interpolation)
//
// From the Dommel/EMTP literature and IEEE Std 112:
//
//   R'₂(s) = R₂N + (R₂_standstill − R₂N) · s
//     At s=1: R'₂ = R₂_standstill  (skin effect forces current to bar surface,
//                                    raising effective resistance by 2–4×)
//     At s=0: R'₂ = R₂N            (uniform current, nominal resistance)
//
//   X'₂(s) = X₂a + (X₂N − X₂a) · (1 − s)
//     At s=1: X'₂ = X₂a   (reduced leakage — flux path constricted by skin effect)
//     At s=0: X'₂ = X₂N   (full leakage, uniform bar current distribution)
// =============================================================================
float GridCurrentSimulator::computeR2slip(float s) const {
    return mp_.R2N + (mp_.R2_standstill - mp_.R2N) * s;
}

float GridCurrentSimulator::computeX2slip(float s) const {
    return mp_.X2a + (mp_.X2N - mp_.X2a) * (1.0f - s);
}

// =============================================================================
// AC peak current from T-equivalent circuit (IEEE 112 Annex B)
//
//   Z_total = (R₁ + R'₂(s)/s) + j·(X₁ + X'₂(s))
//   I_AC_peak = V_phase / |Z_total|
//
// s is clamped to s_rated to prevent singularity as s → 0.
// This clamp is physically correct: once the motor reaches rated speed
// the slip stabilises at s_rated, not zero.
// =============================================================================
float GridCurrentSimulator::computeACPeakCurrent(float s) const {
    float s_clamped = (s < mp_.s_rated) ? mp_.s_rated : s;
    float R2s       = computeR2slip(s_clamped);
    float X2s       = computeX2slip(s_clamped);
    float Re        = mp_.R1 + R2s / s_clamped;   // effective rotor R referred to stator
    float Im        = mp_.X1 + X2s;
    float Z_mag     = sqrtf(Re * Re + Im * Im);
    return mp_.V_phase / Z_mag;
}

// =============================================================================
// CT Saturation: Arctangent fractional model + volt-time area hard cutoff
//
// Step 1 – Volt-time flux accumulation (leaky integrator):
//   φ(t) = φ(t−dt) · flux_leak + V_x · dt
//   V_x  = i_sec_ideal · (R_CT + Z_burden)
//
//   The leakage term (flux_leak ≲ 1) prevents long-term DC drift from initial
//   conditions while remaining transparent to fault-driven DC accumulation
//   (events complete within ≪ 1/|ln(flux_leak)| seconds).
//
//   Hard clamp: when |φ| ≥ φ_sat the CT core is fully saturated.
//   Volt-time area model: secondary current collapses to zero — the CT is
//   "blind".  Differential relays experience this as a missing half-cycle.
//
// Step 2 – Arctangent smooth compression (knee-region model):
//   i_sec_sat = I_sat · arctan(a · i_sec_ideal)
//               ─────────────────────────────────
//                   arctan(a · I_knee)
//
//   This is the 3-parameter fractional form from:
//   "Fitting saturation and hysteresis via arctangent functions", ResearchGate.
//   Asymptote → I_sat as i_sec_ideal → ±∞.
//   At i_sec_ideal = I_knee: output = I_sat (by normalisation denominator).
//   Below knee: response is approximately linear (arctangent ≈ argument).
//
//   The ESP32 FPU evaluates atanf() natively — explicitly cited in the
//   source PDF as the recommended embedded CT saturation method.
// =============================================================================
float GridCurrentSimulator::applyCTSaturation(float i_primary, float dt_s) {
    // ── Ideal CT secondary current ────────────────────────────────────────────
    float i_sec_ideal = i_primary / ct_.turns_ratio;

    // ── Volt-time flux accumulation (leaky integration) ───────────────────────
    float V_x = i_sec_ideal * (ct_.R_ct + ct_.Z_burden);
    flux_accum_ = flux_accum_ * ct_.flux_leak + V_x * dt_s;

    // ── Hard saturation threshold (volt-time area model) ─────────────────────
    if (fabsf(flux_accum_) >= ct_.phi_sat) {
        // Core fully saturated: secondary current collapses to zero.
        // The CT cannot drive its secondary; the relay sees a gap in current.
        return 0.0f;
    }

    // ── Arctangent smooth saturation (sub-saturation, near-knee behaviour) ───
    // Compute denominator: arctan(a · I_knee).
    // This constant depends only on CT parameters — could be pre-computed at
    // construction for extra speed.  Kept here for clarity and correctness.
    float denom = atanf(ct_.arctan_a * ct_.I_knee);

    float i_sec_sat;
    if (fabsf(denom) < 1.0e-9f) {
        // Degenerate: arctan_a → 0 → linear CT (no saturation)
        i_sec_sat = i_sec_ideal;
    } else {
        i_sec_sat = (ct_.I_sat * atanf(ct_.arctan_a * i_sec_ideal)) / denom;
    }

    // Hard clamp to absolute maximum rated secondary current
    return clampf(i_sec_sat, -ct_.I_sat, ct_.I_sat);
}

// =============================================================================
// tick() — O(1) deterministic real-time kernel
//
// Motor inactive path:
//   Oscillator advance → CT saturation(0) → returns 0.0f (no load)
//
// Motor active path (DOL inrush):
//   1. Oscillator advance      (2 FPU muls + 1 add)
//   2. DC offset decay         (1 FPU mul — no expf)
//   3. Slip update             (1 FPU mul + 1 FPU sub + 1 FPU add — no expf)
//   4. AC peak current         (2 muls + 1 div + 1 sqrtf + 1 div + 2 adds)
//   5. Composite primary i     (1 FPU add + 1 FPU mul)
//   6. CT saturation           (1 atanf + 1 atanf + 1 mul + 1 div + clamp)
// =============================================================================
float GridCurrentSimulator::tick(float dt_seconds) {
    // ── Advance 50 Hz current oscillator ─────────────────────────────────────
    advanceOscillator(osc_curr_);

    if (++norm_counter_ >= kNormPeriod) {
        norm_counter_ = 0u;
        normalizeOscillator(osc_curr_);
    }

    float i_primary = base_load_rms_ * 1.41421356f * osc_curr_.x2;

    if (motor_active_) {
        // ── DC offset exponential decay (one multiply, no expf) ───────────────
        // I_DC(t) = I_DC0 · e^(−t/τ_stator)
        // Implemented as iterative: I_DC_state(n) = I_DC_state(n−1) · dc_decay_factor_
        I_DC_state_ *= dc_decay_factor_;

        // ── Slip exponential decay toward s_rated (one multiply, no expf) ─────
        // s(t) = s_rated + (s(t−dt) − s_rated) · e^(−dt/τ_mech)
        //      = s_rated + (s − s_rated) · slip_decay_factor_
        slip_ = mp_.s_rated + (slip_ - mp_.s_rated) * slip_decay_factor_;

        // ── Slip-dependent AC current magnitude ───────────────────────────────
        // Uses updated slip — models rotor skin-effect current displacement.
        float I_AC_peak = computeACPeakCurrent(slip_);

        // ── Composite instantaneous primary current ────────────────────────────
        //   i(t) = I_DC(t) + I_AC(s(t)) · sin(ω₀t + φ_close)
        //        = I_DC_state_ + I_AC_peak · osc_curr_.x2
        //
        // osc_curr_.x2 = sin(ω₀·t + φ_close) — advanced per tick without trig.
        //
        // During inrush (s ≈ 1): I_DC_state_ is large, I_AC_peak ≈ I_LR_peak.
        // After acceleration (s → s_rated): I_DC_state_ → 0, I_AC_peak → I_nominal.
        i_primary = I_DC_state_ + I_AC_peak * osc_curr_.x2;
    }

    // ── CT saturation (always active, even in steady-state) ──────────────────
    // During normal operation: i_primary is small, CT operates linearly.
    // During fault / inrush:   large DC offset drives flux past φ_sat → clip.
    return applyCTSaturation(i_primary, dt_seconds);
}
