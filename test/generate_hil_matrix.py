import json
import math

# ═══════════════════════════════════════════════════════════════════════
#  Smart Grid Sentinel — 300+ Point HIL Certification Matrix Generator
#  Calibrated to ACTUAL firmware constants from config.h
# ═══════════════════════════════════════════════════════════════════════

# ── Firmware Constants (from include/config.h) ────────────────────────
VOLT_UV_INSTANT_V   = 150.0
VOLT_UV_FAULT_V     = 207.0
VOLT_UV_STARTUP_V   = 160.0
VOLT_OV_FAULT_V     = 253.0
VOLT_OV_INSTANT_V   = 270.0

CURR_OC_FAULT_A     = 21.0   # IDMT pickup setpoint
CURR_SC_RUNNING_A   = 27.0   # Short-circuit instant trip
CURR_SC_STARTUP_A   = 110.0
RATED_CURRENT_A     = 16.0

IDMT_K              = 0.140
IDMT_ALPHA          = 0.020
IDMT_TMS            = 0.10
IDMT_IS             = CURR_OC_FAULT_A  # = 21.0A

FAULT_DEBOUNCE_N    = 3    # 30ms
FAULT_DEBOUNCE_INST = 2    # 20ms
SENSOR_LOOP_MS      = 10


def calculate_idmt_trip_ms(current_a):
    """Calculate expected IDMT trip time using ACTUAL firmware IEC 60255 constants."""
    if current_a <= IDMT_IS:
        return None  # Below pickup — no trip
    I_ratio = current_a / IDMT_IS
    time_s = IDMT_TMS * IDMT_K / (pow(I_ratio, IDMT_ALPHA) - 1.0)
    return int(time_s * 1000)


def generate_suite():
    tests = []

    # ══════════════════════════════════════════════════════════════════
    #  Category 1: Undervoltage Sweep (UV_INSTANT + UV_DEBOUNCED)
    #  46 tests: 160V → 205V (all below VOLT_UV_FAULT_V = 207V)
    # ══════════════════════════════════════════════════════════════════
    for v in range(100, 150):  # Below UV_INSTANT (150V) — should trip instantly
        tests.append({
            "id": f"UV_INSTANT_{v}V",
            "category": "VOLTAGE",
            "description": f"Supply collapse at {v}V — instant UV trip (≤150V)",
            "sequence": [{"v": float(v), "i": 5.0, "motor_starting": False, "ticks": 120}],
            "expected_result": "TRIP",
            "expected_time_max_ms": 200
        })

    for v in range(151, 207):  # Between UV_INSTANT+1 and UV_FAULT — debounced trip
        tests.append({
            "id": f"UV_DEBOUNCED_{v}V",
            "category": "VOLTAGE",
            "description": f"Debounced UV sag at {v}V (below 207V threshold)",
            "sequence": [{"v": float(v), "i": 5.0, "motor_starting": False, "ticks": 120}],
            "expected_result": "TRIP",
            "expected_time_max_ms": 1200
        })

    # ══════════════════════════════════════════════════════════════════
    #  Category 2: Overvoltage Sweep (OV_DEBOUNCED + OV_INSTANT)
    #  70 tests: 254V → 299V
    # ══════════════════════════════════════════════════════════════════
    for v in range(254, 270):  # Between OV_FAULT (253V) and OV_INSTANT (270V) — debounced
        tests.append({
            "id": f"OV_DEBOUNCED_{v}V",
            "category": "VOLTAGE",
            "description": f"Debounced OV swell at {v}V (above 253V threshold)",
            "sequence": [{"v": float(v), "i": 5.0, "motor_starting": False, "ticks": 2000}],
            "expected_result": "TRIP",
            "expected_time_max_ms": 20000
        })

    for v in range(270, 300):  # Above OV_INSTANT (270V) — instant trip
        tests.append({
            "id": f"OV_INSTANT_{v}V",
            "category": "VOLTAGE",
            "description": f"MOV protection zone at {v}V — instant OV trip (≥270V)",
            "sequence": [{"v": float(v), "i": 5.0, "motor_starting": False, "ticks": 120}],
            "expected_result": "TRIP",
            "expected_time_max_ms": 200
        })

    # ══════════════════════════════════════════════════════════════════
    #  Category 3: Normal Voltage Band (NO_TRIP expected)
    #  46 tests: 207V → 252V
    # ══════════════════════════════════════════════════════════════════
    for v in range(208, 253):  # 208V is first safe voltage (207V is ON the UV boundary)
        tests.append({
            "id": f"NORMAL_SWEEP_{v}V",
            "category": "NOISE_IMMUNITY",
            "description": f"Normal grid voltage at {v}V — must NOT trip",
            "sequence": [{"v": float(v), "i": 5.0, "motor_starting": False, "ticks": 120}],
            "expected_result": "NO_TRIP"
        })

    # ══════════════════════════════════════════════════════════════════
    #  Category 4: IDMT Overcurrent Sweep (calibrated to firmware)
    #  Pickup = 21A, TMS = 0.10
    #  Only test 21.5A → 26.5A (below SC_INSTANT at 27A)
    # ══════════════════════════════════════════════════════════════════
    idmt_currents = [21.5, 22.0, 22.5, 23.0, 23.5, 24.0, 24.5, 25.0, 25.5, 26.0, 26.5]
    for c in idmt_currents:
        t_ms = calculate_idmt_trip_ms(c)
        if t_ms is None:
            continue
        # Clamp to firmware limits
        t_ms = max(t_ms, 200)   # IDMT_MIN_TRIP_MS
        t_ms = min(t_ms, 60000) # IDMT_MAX_TRIP_MS
        tests.append({
            "id": f"IDMT_{c}A",
            "category": "IDMT",
            "description": f"IEC 60255 IDMT integration at {c}A (pickup=21A, TMS=0.10)",
            "sequence": [{"v": 230.0, "i": float(c), "motor_starting": False,
                          "ticks": max(int(t_ms / SENSOR_LOOP_MS * 1.5), 500)}],
            "expected_result": "TRIP",
            "expected_time_min_ms": int(t_ms * 0.7),
            "expected_time_max_ms": int(t_ms * 1.3)
        })

    # ══════════════════════════════════════════════════════════════════
    #  Category 5: Short Circuit Instant (≥27A)
    #  10 tests: 27A → 120A
    # ══════════════════════════════════════════════════════════════════
    sc_currents = [27.0, 30.0, 35.0, 40.0, 50.0, 60.0, 70.0, 80.0, 100.0, 120.0]
    for c in sc_currents:
        tests.append({
            "id": f"SC_INSTANT_{c}A",
            "category": "SHORT_CIRCUIT",
            "description": f"Short circuit at {c}A — instant trip bypassing IDMT",
            "sequence": [{"v": 230.0, "i": float(c), "motor_starting": False, "ticks": 120}],
            "expected_result": "TRIP",
            "expected_time_max_ms": 200
        })

    # Transient rejection: use 185V (inside UV debounced zone but NOT UV_INSTANT)
    # UV_INSTANT at 150V trips in 20ms, so we use a milder sag that requires
    # debounce accumulation. Only 1-tick (10ms) pulses should be rejected.
    for width_ticks in range(1, 2):  # 1 tick = 10ms — too short to debounce
        tests.append({
            "id": f"TRANSIENT_REJECT_{width_ticks}0ms",
            "category": "NOISE_IMMUNITY",
            "description": f"UV noise spike at 185V for {width_ticks*10}ms — must be rejected",
            "sequence": [
                {"v": 185.0, "i": 5.0, "motor_starting": False, "ticks": width_ticks},
                {"v": 230.0, "i": 5.0, "motor_starting": False, "ticks": 20}
            ],
            "expected_result": "NO_TRIP"
        })

    # Sustained UV transients (these SHOULD trip — firmware is correct to trip them)
    for width_ticks in range(3, 30):
        tests.append({
            "id": f"TRANSIENT_SUSTAINED_{width_ticks}0ms",
            "category": "VOLTAGE",
            "description": f"UV pulse at 110V for {width_ticks*10}ms — sustained enough to trip UV_INSTANT",
            "sequence": [
                {"v": 110.0, "i": 5.0, "motor_starting": False, "ticks": width_ticks},
                {"v": 230.0, "i": 5.0, "motor_starting": False, "ticks": 20}
            ],
            "expected_result": "TRIP",
            "expected_time_max_ms": width_ticks * 10 + 50
        })

    # ══════════════════════════════════════════════════════════════════
    #  Category 7: Sustained UV Fault (should trip with enough time)
    #  20 tests at various depths, sustained long enough
    # ══════════════════════════════════════════════════════════════════
    for v in range(100, 200, 5):
        tests.append({
            "id": f"SUSTAINED_UV_{v}V",
            "category": "VOLTAGE",
            "description": f"Sustained voltage sag to {v}V held for 1200ms",
            "sequence": [{"v": float(v), "i": 5.0, "motor_starting": False, "ticks": 120}],
            "expected_result": "TRIP",
            "expected_time_max_ms": 1200
        })

    # ══════════════════════════════════════════════════════════════════
    #  Category 8: Motor Inrush Two-Tier Masking
    #  Voltages ≥ VOLT_UV_STARTUP_V (160V) during motor start = masked
    #  Voltages < UV_INSTANT (150V) during motor start = TRIP through mask
    # ══════════════════════════════════════════════════════════════════
    # Motor masking: should NOT trip (voltage is within expanded tolerance)
    for v in range(161, 220, 2):  # 161V — above VOLT_UV_STARTUP_V boundary (160V is ON it)
        tests.append({
            "id": f"MOTOR_MASK_OK_{v}V",
            "category": "MOTOR_INRUSH",
            "description": f"Motor inrush with {v}V sag — masked by startup tolerance",
            "sequence": [{"v": float(v), "i": 85.0, "motor_starting": True, "ticks": 120}],
            "expected_result": "NO_TRIP"
        })

    # Motor catastrophic: should TRIP (voltage below UV_INSTANT even during startup)
    for v in range(80, 150, 3):
        tests.append({
            "id": f"MOTOR_CATASTROPHIC_{v}V",
            "category": "MOTOR_INRUSH",
            "description": f"Motor inrush with catastrophic {v}V — punches through mask",
            "sequence": [{"v": float(v), "i": 85.0, "motor_starting": True, "ticks": 120}],
            "expected_result": "TRIP",
            "expected_time_max_ms": 1200
        })

    # ══════════════════════════════════════════════════════════════════
    #  Category 9: Normal Current Band (NO_TRIP expected)
    #  15 tests: 0A → 20A
    # ══════════════════════════════════════════════════════════════════
    for c_int in range(0, 21, 2):
        c = float(c_int) if c_int > 0 else 0.5
        tests.append({
            "id": f"NORMAL_CURRENT_{c}A",
            "category": "NOISE_IMMUNITY",
            "description": f"Normal operating current at {c}A — must NOT trip",
            "sequence": [{"v": 230.0, "i": c, "motor_starting": False, "ticks": 120}],
            "expected_result": "NO_TRIP"
        })

    # ══════════════════════════════════════════════════════════════════
    #  Category 10: Edge Boundary Tests (exact threshold values)
    # ══════════════════════════════════════════════════════════════════
    boundary_tests = [
        # Voltage boundary tests
        {"id": "BOUNDARY_UV_INSTANT_EXACT", "v": 150.0, "i": 5.0, "motor": False,
         "expect": "TRIP", "desc": "Exact UV_INSTANT boundary 150V", "max_ms": 1200},
        {"id": "BOUNDARY_UV_INSTANT_PLUS1", "v": 151.0, "i": 5.0, "motor": False,
         "expect": "TRIP", "desc": "1V above UV_INSTANT — debounced UV zone", "max_ms": 1200},
        {"id": "BOUNDARY_UV_FAULT_EXACT", "v": 207.0, "i": 5.0, "motor": False,
         "expect": "TRIP", "desc": "Exact UV_FAULT boundary 207V", "max_ms": 1200},
        {"id": "BOUNDARY_UV_FAULT_PLUS1", "v": 208.0, "i": 5.0, "motor": False,
         "expect": "NO_TRIP", "desc": "1V above UV_FAULT — safe zone"},
        {"id": "BOUNDARY_OV_FAULT_EXACT", "v": 253.0, "i": 5.0, "motor": False,
         "expect": "TRIP", "desc": "Exact OV_FAULT boundary 253V", "max_ms": 20000, "ticks": 2000},
        {"id": "BOUNDARY_OV_FAULT_MINUS1", "v": 252.0, "i": 5.0, "motor": False,
         "expect": "NO_TRIP", "desc": "1V below OV_FAULT — safe zone"},
        {"id": "BOUNDARY_OV_INSTANT_EXACT", "v": 270.0, "i": 5.0, "motor": False,
         "expect": "TRIP", "desc": "Exact OV_INSTANT boundary 270V", "max_ms": 200},
        {"id": "BOUNDARY_OV_INSTANT_MINUS1", "v": 269.0, "i": 5.0, "motor": False,
         "expect": "TRIP", "desc": "1V below OV_INSTANT — debounced OV zone", "max_ms": 20000, "ticks": 2000},
        # Current boundary tests
        {"id": "BOUNDARY_OC_FAULT_EXACT", "v": 230.0, "i": 21.0, "motor": False,
         "expect": "TRIP", "desc": "Exact OC_FAULT pickup 21A", "max_ms": 60100, "ticks": 6010},
        {"id": "BOUNDARY_OC_FAULT_MINUS1", "v": 230.0, "i": 20.0, "motor": False,
         "expect": "NO_TRIP", "desc": "1A below OC_FAULT — normal zone"},
        {"id": "BOUNDARY_SC_INSTANT_EXACT", "v": 230.0, "i": 27.0, "motor": False,
         "expect": "TRIP", "desc": "Exact SC_INSTANT boundary 27A", "max_ms": 200},
        {"id": "BOUNDARY_SC_INSTANT_MINUS1", "v": 230.0, "i": 26.5, "motor": False,
         "expect": "TRIP", "desc": "0.5A below SC — still in IDMT zone", "max_ms": 60000, "ticks": 6000},
    ]

    for bt in boundary_tests:
        entry = {
            "id": bt["id"],
            "category": "BOUNDARY",
            "description": bt["desc"],
            "sequence": [{"v": bt["v"], "i": bt["i"], "motor_starting": bt["motor"], "ticks": bt.get("ticks", 500)}],
            "expected_result": bt["expect"]
        }
        if "max_ms" in bt:
            entry["expected_time_max_ms"] = bt["max_ms"]
        tests.append(entry)

    # ── Write output ──────────────────────────────────────────────────
    # Remove None values from expected_time entries
    for t in tests:
        t = {k: v for k, v in t.items() if v is not None}

    suite = {"test_cases": tests}
    with open("hil_test_suite_comprehensive.json", "w") as f:
        json.dump(suite, f, indent=2)

    # Print category breakdown
    cats = {}
    for t in tests:
        c = t["category"]
        cats[c] = cats.get(c, 0) + 1
    
    print(f"\n{'='*55}")
    print(f"  Generated {len(tests)} test cases")
    print(f"{'='*55}")
    for c, n in sorted(cats.items()):
        print(f"  {c:25s} : {n:4d} tests")
    print(f"{'='*55}\n")


if __name__ == "__main__":
    generate_suite()
