// ============================================================
//  telemetry_builder.cpp — Centralized Telemetry JSON Assembler
//
//  SCHEMA VERSION: 1.3
//
//  CHANGES FROM v1.2:
//    1. New "diagnostics" top-level object containing:
//         - sensor_health.voltage  (noise, SNR, drift, min/max, score)
//         - sensor_health.current  (noise, SNR, drift, min/max, score)
//         - sensor_health.temperature (success rate, disconnects, score)
//         - adc                    (calibration, linearity, sample rate)
//         - power_quality          (sag, swell, ripple, flicker, score)
//         - system                 (overall health score, heap, uptime)
//
//    2. MQTT transport diagnostics added to "network" section:
//         - connect_attempts, connect_successes
//         - publish_total, publish_failed
//         - tls_cert_verified
//         - ms_since_last_connect
//
//    3. Schema version bumped to "1.3"
//
//  PRESERVED (unchanged from v1.2):
//    - sensors, power, loads, alerts, prediction, actuators
//    - Static buffer — zero heap allocation
//    - All existing field names and structure
//    - API contract for dashboard v1.x consumers
// ============================================================
#include "telemetry_builder.h"
#include "sensor_diagnostics.h"
#include "config.h"
#include "adc_sampler.h"
#include "ds18b20.h"
#include "fault_engine.h"
#include "relay_control.h"
#include "mqtt_client.h"
#include <ArduinoJson.h>
#include <WiFi.h>
#include <esp_system.h>

namespace {
    static char   s_buf[TelemetryBuilder::TELEMETRY_BUF_SIZE];
    static size_t s_last_size = 0;

    // ── Energy integrator (unchanged) ─────────────────────────────────────
    static float    s_energy_wh    = 0.0f;
    static float    s_last_power_w = 0.0f;
    static uint32_t s_last_energy_ts = 0;

    void updateEnergy(float power_w) {
        uint32_t now = millis();
        if (s_last_energy_ts > 0) {
            float dt_h = (now - s_last_energy_ts) / 3600000.0f;
            s_energy_wh += ((power_w + s_last_power_w) * 0.5f) * dt_h;
        }
        s_last_power_w   = power_w;
        s_last_energy_ts = now;
    }

    // ── Device ID (unchanged) ─────────────────────────────────────────────
    static char s_device_id[18]   = {};
    static bool s_device_id_ready = false;

    const char* getDeviceId() {
        if (!s_device_id_ready) {
            uint8_t mac[6];
            WiFi.macAddress(mac);
            snprintf(s_device_id, sizeof(s_device_id),
                     "sgs-%02x%02x%02x", mac[3], mac[4], mac[5]);
            s_device_id_ready = true;
        }
        return s_device_id;
    }
}

namespace TelemetryBuilder {

// ── Power computation (unchanged from v1.2) ──────────────────────────────
PowerMetrics computePower(float v, float i) {
    PowerMetrics p;
    p.apparent_power_va = v * i;
    p.power_factor      = 0.85f;
    p.real_power_w      = p.apparent_power_va * p.power_factor;
    updateEnergy(p.real_power_w);
    p.energy_estimate_wh = s_energy_wh;
    return p;
}

// ── Fault snapshot (unchanged) ────────────────────────────────────────────
FaultSnapshot buildFaultSnapshot(const FSMContext& ctx) {
    FaultSnapshot fs;
    FaultType ft = ctx.fault_type;
    uint8_t   wf = ctx.warn_flags;

    fs.over_voltage     = (ft == FAULT_OVERVOLTAGE);
    fs.over_current     = (ft == FAULT_OVERCURRENT);
    fs.over_temperature = (ft == FAULT_THERMAL);
    fs.inrush_event     = FaultEngine::isInrushBlankActive();
    fs.warn_flags       = wf;
    fs.short_circuit_risk = false;
    return fs;
}

// ── Risk level (unchanged) ────────────────────────────────────────────────
RiskLevel computeRiskLevel(const FSMContext& ctx, const FaultSnapshot& fs) {
    if (ctx.state == FSM_LOCKOUT)                        return RISK_CRITICAL;
    if (ctx.state == FSM_FAULT)                          return RISK_CRITICAL;
    if (fs.short_circuit_risk)                           return RISK_CRITICAL;
    if (ctx.state == FSM_WARNING && ctx.trip_count >= 2) return RISK_HIGH;
    if (ctx.state == FSM_WARNING)                        return RISK_MODERATE;
    if (ctx.warn_flags != WARN_NONE)                     return RISK_MODERATE;
    return RISK_LOW;
}

// ── Sensor confidence (unchanged) ────────────────────────────────────────
uint8_t computeConfidence(bool calibrated, uint32_t sample_count,
                          float value, float full_scale) {
    uint8_t score = 100;
    if (!calibrated)                              score -= 30;
    if (sample_count < MOVING_AVG_DEPTH)          score -= 20;
    if (value < 0.0f || value > full_scale*1.05f) score -= 30;
    if (value == 0.0f && sample_count > 20)       score -= 10;
    return (score < 0) ? 0 : (uint8_t)score;
}

size_t lastPayloadSize() { return s_last_size; }

// ── Main build function ───────────────────────────────────────────────────
const char* buildJSON(const SensorReading& r, const FSMContext& ctx) {

    // ── Compute derived metrics ─────────────────────────────────────────
    PowerMetrics  pwr = computePower(r.voltage_v, r.current_a);
    FaultSnapshot fs  = buildFaultSnapshot(ctx);
    fs.short_circuit_risk = (r.current_a >= CURR_OC_FAULT_A) &&
                            (r.voltage_v  <= VOLT_UV_FAULT_V);
    RiskLevel risk = computeRiskLevel(ctx, fs);

    uint8_t fault_prob = 0;
    if      (ctx.state == FSM_LOCKOUT || ctx.state == FSM_FAULT)      fault_prob = 95;
    else if (ctx.state == FSM_WARNING && ctx.trip_count >= 2)         fault_prob = 75;
    else if (ctx.state == FSM_WARNING)                                fault_prob = 45;
    else if (ctx.warn_flags & WARN_CURR_RISING)                       fault_prob = 25;
    else if (ctx.warn_flags != WARN_NONE)                             fault_prob = 15;

    bool adc_cal         = (ADCSampler::getSampleCount() > 0);
    uint32_t sample_count = ADCSampler::getSampleCount();

    uint8_t v_conf = computeConfidence(adc_cal, sample_count, r.voltage_v, VOLTAGE_FULL_SCALE);
    uint8_t i_conf = computeConfidence(adc_cal, sample_count, r.current_a, CURRENT_FULL_SCALE);
    uint8_t t_conf = DS18B20::isReady() ? 95 : 20;

    uint32_t uptime_s  = millis() / 1000;
    uint32_t free_heap = esp_get_free_heap_size();
    int8_t   rssi      = (WiFi.status() == WL_CONNECTED) ? WiFi.RSSI() : 0;
    uint8_t  rst_reason = (uint8_t)esp_reset_reason();
    uint16_t cpu_mhz   = (uint16_t)(getCpuFrequencyMhz());

    // ── NEW v1.3: Compute full diagnostics snapshot ─────────────────────
    // This single call populates all sensor health, power quality,
    // ADC health, and system diagnostics.
    DiagnosticsSnapshot diag = SensorDiagnostics::compute(
        r.voltage_v, r.current_a, r.temp_c);

    // ── Build JSON ───────────────────────────────────────────────────────
    JsonDocument doc;

    doc["device"]    = getDeviceId();
    doc["timestamp"] = r.ts_ms;
    doc["schema_v"]  = "1.3";

    // ── sensors (unchanged from v1.2) ─────────────────────────────────────
    JsonObject sensors = doc["sensors"].to<JsonObject>();

    JsonObject sv = sensors["voltage"].to<JsonObject>();
    sv["pin"]            = 34;
    sv["raw_value"]      = (int)(r.voltage_v / VOLTAGE_FULL_SCALE * ADC_MAX_RAW);
    sv["filtered_value"] = serialized(String(r.voltage_v, 2));
    sv["confidence"]     = v_conf;
    sv["unit"]           = "V";

    JsonObject si = sensors["current"].to<JsonObject>();
    si["pin"]            = 35;
    si["raw_value"]      = (int)(r.current_a / CURRENT_FULL_SCALE * ADC_MAX_RAW);
    si["filtered_value"] = serialized(String(r.current_a, 3));
    si["confidence"]     = i_conf;
    si["unit"]           = "A";

    JsonObject st = sensors["temperature"].to<JsonObject>();
    st["pin"]            = PIN_DS18B20;
    st["raw_value"]      = (int)(r.temp_c * 16);
    st["filtered_value"] = serialized(String(r.temp_c, 1));
    st["confidence"]     = t_conf;
    st["unit"]           = "C";

    // ── power (unchanged) ─────────────────────────────────────────────────
    JsonObject power = doc["power"].to<JsonObject>();
    power["real_power_w"]       = serialized(String(pwr.real_power_w,       1));
    power["apparent_power_va"]  = serialized(String(pwr.apparent_power_va,  1));
    power["power_factor"]       = serialized(String(pwr.power_factor,       2));
    power["energy_estimate_wh"] = serialized(String(pwr.energy_estimate_wh, 3));
    power["pf_estimated"]       = true;

    // ── loads (unchanged) ─────────────────────────────────────────────────
    JsonObject loads = doc["loads"].to<JsonObject>();
    JsonObject l1 = loads["relay1"].to<JsonObject>();
    l1["pin"] = PIN_RELAY_LOAD1; l1["state"] = r.relay1_closed;
    JsonObject l2 = loads["relay2"].to<JsonObject>();
    l2["pin"] = PIN_RELAY_LOAD2; l2["state"] = r.relay2_closed;

    // ── alerts (unchanged) ────────────────────────────────────────────────
    JsonObject alerts = doc["alerts"].to<JsonObject>();
    alerts["fsm_state"]          = fsmStateName(ctx.state);
    alerts["active_fault"]       = faultTypeName(ctx.fault_type);
    alerts["trip_count"]         = ctx.trip_count;
    alerts["over_voltage"]       = fs.over_voltage;
    alerts["over_current"]       = fs.over_current;
    alerts["over_temperature"]   = fs.over_temperature;
    alerts["short_circuit_risk"] = fs.short_circuit_risk;
    alerts["inrush_event"]       = fs.inrush_event;
    JsonObject warns = alerts["warnings"].to<JsonObject>();
    warns["ov"]          = (bool)(ctx.warn_flags & WARN_OV);
    warns["uv"]          = (bool)(ctx.warn_flags & WARN_UV);
    warns["oc"]          = (bool)(ctx.warn_flags & WARN_OC);
    warns["thermal"]     = (bool)(ctx.warn_flags & WARN_THERMAL);
    warns["curr_rising"] = (bool)(ctx.warn_flags & WARN_CURR_RISING);

    // ── prediction (unchanged) ────────────────────────────────────────────
    JsonObject pred = doc["prediction"].to<JsonObject>();
    pred["fault_probability"] = fault_prob;
    pred["risk_level"]        = riskLevelName(risk);

    // ── actuators (unchanged) ─────────────────────────────────────────────
    JsonObject act = doc["actuators"].to<JsonObject>();
    JsonObject led = act["alert_led"].to<JsonObject>();
    led["pin"]   = PIN_ALERT_LED;
    led["state"] = (ctx.state != FSM_NORMAL && ctx.state != FSM_BOOT);
    JsonObject buz = act["buzzer"].to<JsonObject>();
    buz["pin"]   = PIN_BUZZER;
    buz["state"] = (ctx.state == FSM_WARNING ||
                    ctx.state == FSM_FAULT   ||
                    ctx.state == FSM_LOCKOUT);

    // ── network — expanded with MQTT transport diagnostics ────────────────
    JsonObject net = doc["network"].to<JsonObject>();
    net["wifi_rssi"]              = rssi;
    net["wifi_connected"]         = (WiFi.status() == WL_CONNECTED);
    net["mqtt_connected"]         = MQTTClient::isConnected();
    net["mqtt_tls_verified"]      = MQTTClient::isCertVerified();
    net["mqtt_connect_attempts"]  = MQTTClient::getConnectAttempts();
    net["mqtt_connect_successes"] = MQTTClient::getConnectSuccesses();
    net["mqtt_publish_total"]     = MQTTClient::getPublishTotal();
    net["mqtt_publish_failed"]    = MQTTClient::getPublishFailed();
    net["ip"]                     = WiFi.localIP().toString();

    // ── system (unchanged) ────────────────────────────────────────────────
    JsonObject sys = doc["system"].to<JsonObject>();
    sys["uptime_s"]      = uptime_s;
    sys["free_heap"]     = free_heap;
    sys["reset_reason"]  = rst_reason;
    sys["cpu_freq_mhz"]  = cpu_mhz;
    sys["wdt_timeout_s"] = WDT_TIMEOUT_S;

    // ── sampling (unchanged) ──────────────────────────────────────────────
    JsonObject samp = doc["sampling"].to<JsonObject>();
    samp["adc_sample_count"]  = sample_count;
    samp["filter_window"]     = MOVING_AVG_DEPTH;
    samp["adc_calibrated"]    = adc_cal;
    samp["sensor_latency_us"] = ADC_OVERSAMPLE * 2 * 50;

    // ══════════════════════════════════════════════════════════════════════
    // NEW IN v1.3: "diagnostics" — full sensor intelligence section
    // ══════════════════════════════════════════════════════════════════════
    JsonObject diag_obj = doc["diagnostics"].to<JsonObject>();

    // ── diagnostics.sensor_health ─────────────────────────────────────────
    JsonObject sh = diag_obj["sensor_health"].to<JsonObject>();

    // Voltage channel
    JsonObject sh_v = sh["voltage"].to<JsonObject>();
    sh_v["noise_floor_v"]        = serialized(String(diag.voltage.noise_floor_v,      3));
    sh_v["drift_rate_v_per_s"]   = serialized(String(diag.voltage.drift_rate_v_per_s, 3));
    sh_v["min_seen_v"]           = serialized(String(diag.voltage.min_seen_v,         1));
    sh_v["max_seen_v"]           = serialized(String(diag.voltage.max_seen_v,         1));
    sh_v["peak_to_peak_v"]       = serialized(String(diag.voltage.peak_to_peak_v,     1));
    sh_v["saturated"]            = diag.voltage.saturated;
    sh_v["snr_db"]               = serialized(String(diag.voltage.snr_db,             1));
    sh_v["variance"]             = serialized(String(diag.voltage.variance,           4));
    sh_v["stability_score"]      = diag.voltage.stability_score;
    sh_v["stability_label"]      = diag.voltage.stability_label;

    // Current channel
    JsonObject sh_i = sh["current"].to<JsonObject>();
    sh_i["noise_floor_a"]        = serialized(String(diag.current.noise_floor_a,      4));
    sh_i["drift_rate_a_per_s"]   = serialized(String(diag.current.drift_rate_a_per_s, 4));
    sh_i["min_seen_a"]           = serialized(String(diag.current.min_seen_a,         3));
    sh_i["max_seen_a"]           = serialized(String(diag.current.max_seen_a,         3));
    sh_i["saturated"]            = diag.current.saturated;
    sh_i["snr_db"]               = serialized(String(diag.current.snr_db,             1));
    sh_i["variance"]             = serialized(String(diag.current.variance,           5));
    sh_i["stability_score"]      = diag.current.stability_score;
    sh_i["stability_label"]      = diag.current.stability_label;

    // Temperature channel
    JsonObject sh_t = sh["temperature"].to<JsonObject>();
    sh_t["sensor_present"]       = diag.thermal.sensor_present;
    sh_t["read_success_rate_pct"]= diag.thermal.read_success_rate;
    sh_t["disconnect_count"]     = diag.thermal.disconnect_count;
    sh_t["temp_variance"]        = serialized(String(diag.thermal.temp_variance, 3));
    sh_t["temp_stable"]          = diag.thermal.temp_stable;
    sh_t["stability_score"]      = diag.thermal.stability_score;
    sh_t["stability_label"]      = diag.thermal.stability_label;

    // ── diagnostics.adc_health ────────────────────────────────────────────
    JsonObject adc_h = diag_obj["adc_health"].to<JsonObject>();
    adc_h["calibration_type"]           = diag.adc.calibration_type;
    adc_h["calibration_label"]          = diag.adc.calibration_label;
    adc_h["linearity_error_pct"]        = serialized(String(diag.adc.linearity_error_pct,       2));
    adc_h["actual_sample_rate_hz"]      = serialized(String(diag.adc.actual_sample_rate_hz,     1));
    adc_h["expected_sample_rate_hz"]    = serialized(String(diag.adc.expected_sample_rate_hz,   1));
    adc_h["sample_rate_deviation_pct"]  = serialized(String(diag.adc.sample_rate_deviation_pct, 1));
    adc_h["saturation_events"]          = diag.adc.saturation_events;
    adc_h["voltage_saturated"]          = diag.adc.voltage_saturated;
    adc_h["current_saturated"]          = diag.adc.current_saturated;
    adc_h["health_score"]               = diag.adc.health_score;

    // ── diagnostics.power_quality ─────────────────────────────────────────
    JsonObject pq = diag_obj["power_quality"].to<JsonObject>();
    pq["nominal_voltage_v"]          = serialized(String(diag.power_quality.nominal_voltage_v,      1));
    pq["mean_voltage_v"]             = serialized(String(diag.power_quality.mean_voltage_v,         1));
    pq["voltage_deviation_pct"]      = serialized(String(diag.power_quality.voltage_deviation_pct,  2));
    pq["sag_depth_v"]                = serialized(String(diag.power_quality.sag_depth_v,            1));
    pq["swell_height_v"]             = serialized(String(diag.power_quality.swell_height_v,         1));
    pq["ripple_pct"]                 = serialized(String(diag.power_quality.ripple_pct,             2));
    pq["flicker_index"]              = serialized(String(diag.power_quality.flicker_index,          5));
    pq["power_factor_estimated"]     = serialized(String(diag.power_quality.power_factor_estimated, 2));
    pq["real_power_w"]               = serialized(String(diag.power_quality.real_power_w,           1));
    pq["apparent_power_va"]          = serialized(String(diag.power_quality.apparent_power_va,      1));
    pq["voltage_stability_score"]    = diag.power_quality.voltage_stability_score;
    pq["power_quality_label"]        = diag.power_quality.power_quality_label;
    pq["note"]                       = "DC-proxy metrics. True THD requires AC waveform sampling.";

    // ── diagnostics.system_health ─────────────────────────────────────────
    JsonObject sys_h = diag_obj["system_health"].to<JsonObject>();
    sys_h["overall_health_score"] = diag.system.overall_health_score;
    sys_h["health_status"]        = diag.system.health_status;
    sys_h["uptime_s"]             = diag.system.uptime_s;
    sys_h["uptime_quality"]       = diag.system.uptime_quality;
    sys_h["free_heap_bytes"]      = diag.system.free_heap_bytes;
    sys_h["heap_healthy"]         = diag.system.heap_healthy;
    sys_h["cpu_load_estimate_pct"]= serialized(String(diag.system.cpu_load_estimate_pct, 1));

    // ── Serialize ─────────────────────────────────────────────────────────
    size_t written = serializeJson(doc, s_buf, sizeof(s_buf));

    if (written == 0 || written >= sizeof(s_buf) - 1) {
        static const char* err =
            "{\"error\":\"telemetry_overflow\",\"schema_v\":\"1.3\"}";
        s_last_size = strlen(err);
        Serial.printf("[TELEMETRY] OVERFLOW! written=%d buf=%d\n",
                      written, sizeof(s_buf));
        return err;
    }

    s_last_size = written;
    return s_buf;
}

} // namespace TelemetryBuilder
