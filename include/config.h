#pragma once
// ============================================================
//  config.h — Smart Grid Sentinel
//  REVISION: 3.0 — Full Indian Grid Compliance
//
//  Standards applied:
//    IS 12360       : Indian voltage tolerance ±10% consumer side
//    CEA Regs 2005  : Supply voltage ±6% at point of delivery
//    IS 8828        : MCB trip curves (mirrors IEC 60898)
//    IEC 60255      : IDMT overcurrent protection curves
//    IEC 60898      : MCB Curve B / C / D trip multiples
//    IEC 61000-4-15 : Flicker / power quality
//    EN 50160       : Voltage event classification (adopted by BIS)
//
//  Grid parameters: 230V nominal, 50Hz, single phase
//  Current scale  : 0–30A (changed from 0–5A prototype)
//  Sensor         : ZMPT101B voltage, SCT-013 / ACS758 current
//                   DS18B20 temperature (1-Wire, 12-bit)
//
//  EDGE CASES HANDLED:
//    EC-01  Motor/compressor inrush (5–8× rated, 500ms–3s)
//    EC-02  SMPS capacitive inrush (20–40×, 1–10ms)
//    EC-03  Resistive load cold inrush (10–15×, 50ms)
//    EC-04  DS18B20 +85°C boot sentinel ignored for 2s
//    EC-05  DS18B20 -127°C disconnect → immediate LOCKOUT
//    EC-06  ADC saturation → sensor hardware fault → LOCKOUT
//    EC-07  ADC frozen (variance=0) → frozen sensor fault
//    EC-08  Physics impossibility (I>2A, V<5V) → sensor fault
//    EC-09  Motor-induced UV sag suppressed during inrush
//    EC-10  OV instantaneous (>270V) bypasses debounce
//    EC-11  Short circuit (>27A) bypasses inrush blank
//    EC-12  Thermal fault bypasses auto-reclose → LOCKOUT
//    EC-13  SC fault bypasses auto-reclose → LOCKOUT
//    EC-14  All voltage threshold hysteresis bands defined
//    EC-15  IDMT thermal memory (accumulator decays slowly)
// ============================================================

// ─── GPIO Pins ────────────────────────────────────────────────────────────────
#define PIN_RELAY_LOAD1     26
#define PIN_RELAY_LOAD2     27
#define PIN_ALERT_LED       2
#define PIN_BUZZER          25
#define PIN_DS18B20         4
#define PIN_OLED_SDA        21
#define PIN_OLED_SCL        22

// ─── ADC Core ────────────────────────────────────────────────────────────────
// 4× oversample → +1 ENOB (12-bit → effective ~13-bit on stable signal)
// 16× recommended for +2 ENOB but increases loop latency — use 4× at 100Hz
#define ADC_OVERSAMPLE          4
#define ADC_MAX_RAW             4095.0f

// ─── Sensor Scales ───────────────────────────────────────────────────────────
// Voltage: ZMPT101B stepped down to ADC range 0–3.3V mapped to 0–300V
// Current: SCT-013-030 (0–30A : 0–1V) or ACS758-30AB mapped to 0–30A
#define VOLTAGE_FULL_SCALE      300.0f      // V  — ADC upper rail represents 300V
#define CURRENT_FULL_SCALE      30.0f       // A  — CHANGED from 5A to 30A

// ─── IIR Filter Alphas ───────────────────────────────────────────────────────
// Voltage: symmetric, slower — real grid voltages never change instantaneously
// Current (display path): symmetric — fault engine uses asymmetric separately
#define IIR_ALPHA_VOLTAGE       0.2f
#define IIR_ALPHA_CURRENT       0.3f

// Current deadband — noise suppression at idle
// 30A scale: 100mA deadband = 0.33% of scale (tighter than old 1%)
#define CURR_DEADBAND_A         0.10f

// Moving average window depth (final display smoothing)
#define MOVING_AVG_DEPTH        10

// ─── Indian Grid Reference ───────────────────────────────────────────────────
// IS 12360 / CEA Regulations 2005 — 230V ±6% supply, ±10% consumer tolerance
#define NOMINAL_VOLTAGE_V       230.0f
#define GRID_FREQ_HZ            50.0f

// ─── Voltage Fault Thresholds — IS 12360 / CEA 2005 ────────────────────────
//
//  ZONE DIAGRAM (volts):
//
//  0     150    170    207    216    218.5  230  241.5  243    253    270   300
//  |      |      |      |      |      |      |    |      |      |      |    |
//  |VOID  |      |UV_INS|UV_FLT|UV_WRN|RA_LO | NOM|RA_HI |OV_WRN|OV_FLT|OV_INS
//
//  UV_INSTANT  : <150V — supply near collapse, motor winding destruction imminent
//  UV_FAULT    : <207V — IS 12360 -10% hard limit, motor overheating zone
//  UV_WARN     : <216V — CEA -6% supply deviation, first alert
//  RANGE_A_LO  : 218.5V — ±5% preferred band lower
//  NOMINAL     : 230V
//  RANGE_A_HI  : 241.5V — ±5% preferred band upper
//  OV_WARN     : >243V — CEA +6% supply deviation, first alert
//  OV_FAULT    : >253V — IS 12360 +10% hard limit, equipment damage zone
//  OV_INSTANT  : >270V — approaching MOV MCOV (275V), zero-debounce trip

// Overvoltage
#define VOLT_OV_WARN_V          243.0f      // CEA +6%  — WARNING issued
#define VOLT_OV_FAULT_V         253.0f      // IS 12360 +10% — FAULT (debounced)
#define VOLT_OV_INSTANT_V       270.0f      // MOV protection zone — ZERO debounce
// Hysteresis dropout (fault clears only when V falls below this)
// 8V band prevents chattering at the 253V boundary (EN 50160 guidance)
#define VOLT_OV_FAULT_HYST_V    245.0f      // fault held until V drops below 245V
#define VOLT_OV_WARN_HYST_V     240.0f      // warning held until V drops below 240V

// Undervoltage
#define VOLT_UV_WARN_V          216.0f      // CEA -6%  — WARNING issued
#define VOLT_UV_FAULT_V         207.0f      // IS 12360 -10% — FAULT (motor protection)
#define VOLT_UV_INSTANT_V       150.0f      // near supply collapse — ZERO debounce
// Hysteresis pickup (fault clears only when V rises above this)
// 8V band prevents chattering at the 207V boundary
#define VOLT_UV_FAULT_HYST_V    215.0f      // fault held until V rises above 215V
#define VOLT_UV_WARN_HYST_V     220.0f      // warning held until V rises above 220V

// Recovery validation: voltage must hold in this band before relay re-closes
// IS 12360 Range A (±5%) — most stable zone for motor re-energisation
#define VOLT_RECOVERY_LO_V      218.5f      // 230V × 0.95
#define VOLT_RECOVERY_HI_V      241.5f      // 230V × 1.05
// Recovery must hold in-band for this many consecutive samples before reclose
#define VOLT_RECOVERY_CONFIRM_N 50          // 50 × 10ms = 500ms of stable voltage

// ─── Current Fault Thresholds — 0–30A Scale ─────────────────────────────────
//
//  Indian household typical protection rating: 16A MCB (IS 8828 Curve C)
//  System rated current base for IDMT calculation
//
//  CURRENT FAULT ZONES:
//
//  0    0.1   18    21    27    30A
//  |     |     |     |     |     |
//  |DEAD |NORM |WARN |IDMT |SC   |RAIL
//
//  DEADBAND     : <0.1A  — noise floor, forced to 0.00A
//  NORMAL       : 0.1–18A — safe continuous operation
//  OC_WARN      : >18A  — 112% of rated, overload warning
//  OC_FAULT     : >21A  — 131% of rated, IDMT accumulator starts
//  SC_INSTANT   : >27A  — 169% ADC scale, near saturation = short circuit
//                          NOTE: SC bypasses inrush blank (see EC-11)
//
//  Rated current (IS 8828 MCB base for IDMT calculation)
#define RATED_CURRENT_A         16.0f       // 16A rated — standard Indian MCB

#define CURR_OC_WARN_A          18.0f       // 112% rated — WARNING (sustained overload)
#define CURR_OC_FAULT_A         21.0f       // 131% rated — IDMT trip zone start
#define CURR_SC_INSTANT_A       27.0f       // near ADC saturation — SC trip, NO blank

// Hysteresis dropout (OC fault clears when I drops below this)
// Prevents relay chattering when current hovers at fault threshold
#define CURR_OC_FAULT_HYST_A    16.5f       // 103% rated — fault clears here
#define CURR_OC_WARN_HYST_A     15.0f       // 94% rated — warning clears here

// Heavy-load adaptive debounce threshold
// Above this: stricter consecutive-sample requirement before tripping
// Indian context: compressor/pump running at high load is normal
#define LOAD_HEAVY_A            12.0f       // 75% of rated = heavy load mode

// ─── IDMT Overcurrent — IEC 60255 Standard Inverse Curve ────────────────────
//
//  Formula: t(I) = TMS × k / ((I/Is)^α - 1)
//
//  Constants for IEC Standard Inverse curve:
//    k     = 0.140
//    α     = 0.020
//    TMS   = 0.10  (Time Multiplier — tuned for 16A Indian household)
//    Is    = CURR_OC_FAULT_A (pickup setpoint)
//
//  Trip time examples at TMS=0.10, Is=21A:
//    I=22A (105% Is) → t ≈ 15.0 seconds
//    I=25A (119% Is) → t ≈ 4.0  seconds
//    I=27A (129% Is) → SC_INSTANT bypasses IDMT entirely → <30ms
//
//  IDMT accumulator: increments by (SENSOR_LOOP_MS / t_trip_ms) each tick
//  Trips when accumulator >= 1.0
//  Decays at 0.5%/tick when below pickup (thermal memory — EC-15)
//  Resets to 0 on relay open

#define IDMT_K                  0.140f
#define IDMT_ALPHA              0.020f
#define IDMT_TMS                0.10f       // Time Multiplier Setting
#define IDMT_IS                 CURR_OC_FAULT_A  // = 21.0A pickup
#define IDMT_ACCUMULATOR_DECAY  0.995f      // per-tick decay factor below pickup
#define IDMT_MIN_TRIP_MS        200         // hardware minimum — relay mechanical delay
#define IDMT_MAX_TRIP_MS        60000       // 60s maximum — beyond = sustained overload

// ─── Temperature Fault Thresholds ────────────────────────────────────────────
//
//  TEMPERATURE ZONES:
//
//  -127    0    60    70    85    105   130°C
//    |      |    |     |     |     |     |
//   DISC  NORM  RST  WARN  FAULT  CAP  PCB_DEL
//
//  DISC  : DS18B20 disconnected sentinel → LOCKOUT (EC-05)
//  RST   : Manual reset blocked above 60°C (thermal guard)
//  WARN  : >70°C — thermal warning, shed auxiliary load
//  FAULT : >85°C — electrolytic capacitor rated limit → LOCKOUT (EC-12)
//  CAP   : 105°C — capacitor absolute maximum (already in LOCKOUT)
//  PCB   : 130°C — FR4 delamination (physically catastrophic)
//
//  IMPORTANT: Thermal fault goes directly to LOCKOUT, not FAULT→RECOVERY
//  This forces physical inspection before re-energisation.

#define TEMP_WARN_C             70.0f       // WARNING threshold
#define TEMP_FAULT_C            85.0f       // FAULT threshold → LOCKOUT
// Hysteresis: fault held until temp drops to this (prevents oscillation)
#define TEMP_FAULT_HYST_C       70.0f       // = same as warning threshold
#define TEMP_RESET_BLOCK_C      60.0f       // manual reset blocked above this

// ─── DS18B20 Sentinel Values — Section 11 of reference document ──────────────
//
//  EC-04: +85°C power-on default
//    DS18B20 scratchpad initialises to exactly 85°C on power-up.
//    First conversion takes up to 750ms. Reading 85°C before conversion
//    completes will false-trip thermal fault.
//    FIX: Ignore any 85°C reading within DS18B20_BOOT_IGNORE_MS of init().
//
//  EC-05: -127°C disconnect sentinel
//    Returned by DallasTemperature library when 1-Wire bus is shorted
//    or sensor is physically unplugged.
//    FIX: Any -127°C reading triggers immediate LOCKOUT from ANY state.
//    System cannot operate safely without thermal protection.

#define DS18B20_BOOT_IGNORE_MS  2000        // ignore +85°C for 2s after init
#define DS18B20_SENTINEL_HOT    85.0f       // power-on default — ignore in boot window
#define DS18B20_SENTINEL_DISC   -127.0f     // disconnected — LOCKOUT immediately

// ─── Fault Engine Debounce ────────────────────────────────────────────────────
//
//  Consecutive samples required to confirm a fault condition.
//  At SENSOR_LOOP_MS=10ms: N=3 → 30ms confirmation window
//
//  INSTANT faults (OV>270V, UV<150V, SC>27A) use N=2 only — minimum
//  latency, prevents missing codes on DNL-affected ADC.
//
//  Voltage debounce: applies to sustained OV/UV faults
//  Current debounce: applies to IDMT zone (not SC which is instant)
//  Temp debounce: applies to thermal warning/fault (slow-changing)

#define FAULT_DEBOUNCE_N        3           // 3 samples = 30ms (normal load)
#define FAULT_DEBOUNCE_HEAVY    5           // 5 samples = 50ms (heavy load >12A)
#define FAULT_DEBOUNCE_INSTANT  2           // 2 samples = 20ms (OV_INST, UV_INST, SC)
#define WARN_DEBOUNCE_N         2
#define WARN_DEBOUNCE_HEAVY     4

// ─── Inrush Blanking — Tuned for Indian AC Loads ─────────────────────────────
//
//  Indian load inrush profiles (reference: Section 6 + Indian load study):
//
//  Load type              | Inrush multiple | Duration  | Blank needed
//  -----------------------|-----------------|-----------|-------------
//  Ceiling fan            | 3–5×            | 200–500ms | 600ms
//  Tube light (magnetic)  | 5–8×            | 100–300ms | 400ms
//  Refrigerator compressor| 5–8× FLA        | 500ms–2s  | 2500ms
//  Water pump (fractional)| 6–10×           | 500ms–3s  | 3500ms  ← worst case
//  Mixer/grinder          | 2–4× brief      | 50–100ms  | 200ms
//  LED TV / SMPS          | 10–20× capac.   | 1–10ms    | 50ms
//  Washing machine motor  | 5–8×            | 500ms–2s  | 2500ms
//  Iron / heater          | 1.5–2× cold     | 50ms      | 150ms
//
//  BLANK WINDOW = 3500ms covers worst-case pump start.
//
//  EC-09: Motor-induced UV sag
//    A motor drawing 8× rated current depresses local voltage below UV_WARN.
//    This UV is caused by the load itself during startup. It is NOT a grid fault.
//    FIX: UV_WARN and UV_FAULT are also suppressed during inrush blank window.
//    UV_INSTANT (<150V) is NEVER suppressed — supply collapse is always real.
//
//  EC-11: Short circuit bypasses blank window
//    A genuine short circuit at startup must still trip instantly.
//    FIX: SC_INSTANT (>27A) detection is NEVER suppressed by inrush blank.
//    SC uses slope logic: if current is RISING after 300ms, it is SC not inrush.
//
//  EC-02: SMPS capacitive inrush
//    SMPS inrush spike is 1–10ms maximum. The 3500ms blank window means a
//    genuine SC occurring 100ms after relay close would be missed for 3.4s.
//    FIX: SC_INSTANT bypass above handles this. Any current ≥27A = SC trip
//    regardless of inrush window, because genuine SMPS inrush decays within 10ms.

#define INRUSH_BLANK_MS         3500        // OC fault + UV suppressed post relay-close
#define INRUSH_BLANK_WARN_MS    1000        // OC warn + UV warn suppressed (shorter)
// SC_INSTANT and OV_INSTANT are NEVER blanked — defined by logic in fault_engine

// Slope threshold for adaptive SC detection inside blank window
// If slope > this AND current > SC threshold → SC trip (not inrush)
#define INRUSH_SC_SLOPE_A_PER_TICK  0.5f   // 0.5A per 10ms tick = rising, not decaying

// ─── FSM Auto-Reclose — Escalating Dead Times ────────────────────────────────
//
//  Standard utility recloser profile (Section 7 reference):
//  Attempt 1: short delay (transient event likely)
//  Attempt 2: medium delay (wait for arc to extinguish)
//  Attempt 3: long delay (serious fault — last chance before LOCKOUT)
//
//  Indian grid context: frequent transient sags/swells from nearby heavy
//  industrial loads. First reclose is fast to restore service quickly.
//
//  LOCKOUT bypass (no auto-reclose):
//    - FAULT_THERMAL  → direct LOCKOUT (fire risk, must inspect physically)
//    - FAULT_SC       → direct LOCKOUT (wiring damage possible)
//    - FAULT_SENSOR   → direct LOCKOUT (cannot protect without sensors)
//
//  Recovery confirmation: voltage must hold in VOLT_RECOVERY_LO..HI for
//  VOLT_RECOVERY_CONFIRM_N samples before relay re-closes.

#define RECLOSE_DELAY_1_MS      5000        // Trip 1: 5 second wait
#define RECLOSE_DELAY_2_MS      15000       // Trip 2: 15 second wait
#define RECLOSE_DELAY_3_MS      30000       // Trip 3: 30 second wait then LOCKOUT
#define MAX_TRIP_COUNT          3           // after 3 trips → LOCKOUT

// ─── Multi-Fault Priority Bitmask — Section 8 ────────────────────────────────
//
//  Priority order (highest → lowest destructive potential):
//  P1: Sensor hardware failure → LOCKOUT (operating blind is catastrophic)
//  P2: Short circuit ANSI 50   → instant FAULT (<30ms), LOCKOUT after trip
//  P3: Severe overvoltage >270V→ instant FAULT (MOV / semiconductor SOA)
//  P4: Thermal limit           → FAULT → LOCKOUT (fire risk)
//  P5: Sustained overvoltage   → FAULT via debounce
//  P6: IDMT overcurrent        → FAULT via accumulator
//  P7: Undervoltage            → FAULT via debounce (motor protection)
//
//  Bitmask allows SIMULTANEOUS faults to be tracked.
//  Example: stalled motor → UV + OC_IDMT both active simultaneously.
//  The highest-priority active bit determines the FSM action.

#define FAULT_BIT_NONE          0x0000U
#define FAULT_BIT_SENSOR        0x0001U     // P1 — hardware sensor failure
#define FAULT_BIT_SC            0x0002U     // P2 — short circuit ANSI 50
#define FAULT_BIT_OV_INSTANT    0x0004U     // P3 — severe OV >270V ANSI 59 inst
#define FAULT_BIT_THERMAL       0x0008U     // P4 — thermal limit exceeded
#define FAULT_BIT_OV            0x0010U     // P5 — sustained overvoltage
#define FAULT_BIT_OC_IDMT       0x0020U     // P6 — IDMT overcurrent ANSI 51
#define FAULT_BIT_UV            0x0040U     // P7 — undervoltage

// Warning bitmask values are defined as enum WarnFlags in types.h.
// Macros removed here to  preprocessor collision with the enum.

// Legacy /api/state and /api/config endpoints reference a single
// recovery delay. Map it to Trip-1 delay so the JSON remains valid.
// The FSM itself uses the full escalating RECLOSE_DELAY_1/2/3_MS table.
#define RECOVERY_DELAY_MS       RECLOSE_DELAY_1_MS

// ─── Sensor Failure Detection — Section 11 ───────────────────────────────────
//
//  EC-06: ADC saturation (wire break / op-amp rail short)
//    ADC reads ≤5 or ≥4090 continuously for SENSOR_SAT_WINDOW_MS
//    → sensor hardware fault → LOCKOUT
//
//  EC-07: Frozen sensor (ADC multiplexer hang / IC lockup)
//    Variance of last SENSOR_FROZEN_N samples = 0.0 exactly
//    Real AC mains signal always has ≥1–2 LSB thermal jitter
//    → frozen sensor fault → LOCKOUT
//
//  EC-08: Physics impossibility (cross-channel sanity check)
//    current_a > SENSOR_PHYSICS_I_MIN AND voltage_v < SENSOR_PHYSICS_V_MAX
//    Physical impossibility on AC mains — at least one sensor has failed
//    → sensor integrity fault → LOCKOUT

#define SENSOR_SAT_WINDOW_MS    50          // 50ms continuous saturation = fault
#define SENSOR_FROZEN_N         20          // 20 samples with zero variance = frozen
#define SENSOR_PHYSICS_I_MIN    2.0f        // current > 2A
#define SENSOR_PHYSICS_V_MAX    5.0f        // while voltage < 5V = impossible

// ─── Temperature Sensor ───────────────────────────────────────────────────────
// Non-blocking conversion: request → wait 800ms → read
// At 2000ms interval: effectively 0.5Hz sampling (sufficient for thermal mass)
#define TEMP_READ_INTERVAL_MS   2000

// ─── OLED ─────────────────────────────────────────────────────────────────────
#define OLED_WIDTH              128
#define OLED_HEIGHT             64
#define OLED_RESET_PIN          -1
#define OLED_I2C_ADDR           0x3C
#define OLED_PAGE_FLIP_MS       4000

// ─── Buzzer (LEDC) ────────────────────────────────────────────────────────────
#define BUZZER_LEDC_CHANNEL     0
#define BUZZER_LEDC_RES_BITS    8
#define BUZZER_FREQ_WARN        1000
#define BUZZER_FREQ_FAULT       2000
#define BUZZER_FREQ_LOCK        500
#define BUZZER_DUTY_50          128

// ─── NVS / Preferences ────────────────────────────────────────────────────────
#define NVS_NAMESPACE           "sgs"
#define NVS_KEY_WIFI_SSID       "wifi_ssid"
#define NVS_KEY_WIFI_PASS       "wifi_pass"
#define NVS_KEY_API_KEY         "api_key"
#define NVS_KEY_MQTT_HOST       "mqtt_host"
#define NVS_KEY_MQTT_PORT       "mqtt_port"
#define NVS_KEY_MQTT_USER       "mqtt_user"
#define NVS_KEY_MQTT_PASS       "mqtt_pass"
#define NVS_KEY_LOG_HEAD        "log_head"
#define NVS_KEY_LOG_COUNT       "log_count"
#define NVS_KEY_LOG_ENTRY       "log_e"
#define EVENT_LOG_CAPACITY      50

// ─── MQTT ─────────────────────────────────────────────────────────────────────
#define MQTT_KEEPALIVE          60
#define MQTT_PUB_INTERVAL_MS    5000
#define MQTT_DEFAULT_HOST       "e7fc2b846d3f4104914943838d5c7c27.s1.eu.hivemq.cloud"
#define MQTT_DEFAULT_PORT       8883
#define MQTT_USERNAME           "sgs-device-01"
#define MQTT_PASSWORD           "Chicken@65"
#define MQTT_TOPIC_TELEMETRY    "sgs/telemetry"
#define MQTT_TOPIC_FAULT        "sgs/fault"
#define MQTT_TOPIC_STATE        "sgs/state"
// #define MQTT_SKIP_CERT_VERIFY   // Uncomment ONLY for development

// ─── HTTP API ─────────────────────────────────────────────────────────────────
#define API_PORT                80
#define API_KEY_LENGTH          16

// ─── FreeRTOS Tasks ───────────────────────────────────────────────────────────
#define SENSOR_LOOP_MS          10          // 100Hz protection task
#define COMMS_LOOP_MS           50          // 20Hz comms task
#define HEALTH_LOOP_MS          10000
#define SENSOR_QUEUE_LEN        1
#define TASK_PROT_STACK_WORDS   4096
#define TASK_COMMS_STACK_WORDS  6144
#define TASK_HEALTH_STACK_WORDS 2048
#define TASK_PROT_PRIORITY      5
#define TASK_COMMS_PRIORITY     3
#define TASK_HEALTH_PRIORITY    1

// ─── Watchdog ─────────────────────────────────────────────────────────────────
#define WDT_TIMEOUT_S           10

// ─── Health Monitor ───────────────────────────────────────────────────────────
#define HEAP_WARN_BYTES         20000

// ─── Types.h Additions Required ──────────────────────────────────────────────
// ADD these to your FaultType enum in types.h:
//
//   FAULT_SHORT_CIRCUIT,    // ANSI 50 — instantaneous SC, bypasses reclose
//   FAULT_SENSOR_FAIL,      // hardware sensor failure, triggers LOCKOUT
//
// ADD this to faultTypeName() in types.h or shared utility:
//   case FAULT_SHORT_CIRCUIT: return "SHORT_CIRCUIT";
//   case FAULT_SENSOR_FAIL:   return "SENSOR_FAIL";
// ─────────────────────────────────────────────────────────────────────────────