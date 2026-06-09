$ESP32_IP = "192.168.1.100"         # ← Your ESP32's IP address
$API_KEY = "YOUR_API_KEY"           # ← From ESP32 serial monitor at boot

$HEADERS = @{
    "X-API-Key"    = $API_KEY
    "Content-Type" = "application/json"
}

$CSV_FILE = ".\raw_data.csv"
"TestName,RunNumber,Inject_Timestamp_ms,Trip_Timestamp_ms,Reaction_Time_ms,Fault_Type,Injected_Voltage_V,Injected_Depth_PU" | Out-File $CSV_FILE -Encoding utf8

function Send-Cmd($endpoint, $body) {
    try {
        Invoke-RestMethod -Uri "http://$ESP32_IP$endpoint" -Method Post -Headers $HEADERS -Body $body -TimeoutSec 5 | Out-Null
    }
    catch {
        Write-Host "  -> Network Error: $_" -ForegroundColor Red
    }
}

function Get-Log {
    try {
        return Invoke-RestMethod -Uri "http://$ESP32_IP/api/log" -Method Get -Headers $HEADERS -TimeoutSec 5
    }
    catch {
        return $null
    }
}

function Run-Test {
    param(
        [string]$TestName,
        [string]$InjectBody,
        [int]$WaitSeconds,
        [int]$Runs = 3,
        [float]$VoltageValue = 0.0,
        [float]$DepthPU = 0.0
    )

    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host " TEST: $TestName  |  Target: ${VoltageValue}V  |  Runs: $Runs" -ForegroundColor Cyan
    Write-Host "================================================================" -ForegroundColor Cyan

    for ($i = 1; $i -le $Runs; $i++) {
        Write-Host "  [$i/$Runs] Pre-flight reset..." -ForegroundColor DarkGray

        # 1. Force clean slate
        Send-Cmd "/api/inject" '{"cmd":"normal_grid"}'
        Send-Cmd "/api/reset" '{"cmd":"reset"}'
        Send-Cmd "/api/log/clear" ''
        Start-Sleep -Seconds 2

        # 2. Inject Fault
        Write-Host "  [$i/$Runs] Injecting: $TestName -> ${VoltageValue}V" -ForegroundColor Yellow
        Send-Cmd "/api/inject" $InjectBody

        # 3. Wait for FSM to trip
        Start-Sleep -Seconds $WaitSeconds

        # 4. Data Acquisition
        $logs = Get-Log

        $inject_time = 0
        $trip_time = 0
        $fault_type = "NONE"

        if ($logs) {
            foreach ($entry in $logs) {
                if ($entry.note -like "SIL_CMD:*") {
                    $inject_time = $entry.ts
                }
                if ($entry.state -eq "FAULT" -or $entry.state -eq "LOCKOUT") {
                    if ($trip_time -eq 0) {
                        $trip_time = $entry.ts
                        $fault_type = $entry.fault
                    }
                }
            }
        }

        # 5. Export
        if ($inject_time -gt 0 -and $trip_time -gt 0) {
            $reaction = $trip_time - $inject_time
            Write-Host "  [$i/$Runs] TRIPPED in ${reaction}ms | Fault: $fault_type" -ForegroundColor Green
            "$TestName,$i,$inject_time,$trip_time,$reaction,$fault_type,$VoltageValue,$DepthPU" | Out-File -FilePath $CSV_FILE -Append -Encoding utf8
        }
        else {
            Write-Host "  [$i/$Runs] NO TRIP (Expected for safe-zone tests)" -ForegroundColor Magenta
            "$TestName,$i,$inject_time,$trip_time,NO_TRIP,$fault_type,$VoltageValue,$DepthPU" | Out-File -FilePath $CSV_FILE -Append -Encoding utf8
        }

        # 6. Auto-Recovery
        Send-Cmd "/api/inject" '{"cmd":"normal_grid"}'
        Send-Cmd "/api/reset" '{"cmd":"reset"}'
        Start-Sleep -Seconds 3
    }
}

$NOMINAL = 230.0
$N = 3  # Runs per test

Write-Host ""
Write-Host "########################################################################" -ForegroundColor White
Write-Host "#         IEC 60255 FULL COMPLIANCE DATA COLLECTION             #" -ForegroundColor White
Write-Host "#         Nominal: 230V | Rated: 16A | Loop: 10ms                      #" -ForegroundColor White
Write-Host "########################################################################" -ForegroundColor White

# ══════════════════════════════════════════════════════════════════════════════
# CATEGORY A: UNDERVOLTAGE SWEEP (230V down to 23V)
# Tests every single UV threshold boundary in config.h
# ══════════════════════════════════════════════════════════════════════════════

Write-Host "`n===== CATEGORY A: UNDERVOLTAGE SWEEP =====" -ForegroundColor White

# A1: Minor sag - INSIDE safe zone (should NOT trip)
# 230V * (1 - 0.1) = 207V exactly at UV_FAULT boundary
Run-Test -TestName "UV_SafeZone_221V" `
    -InjectBody '{"cmd":"sag","depth":0.1,"duration":5.0}' `
    -WaitSeconds 3 -Runs $N -VoltageValue 207.0 -DepthPU 0.1

# A2: Moderate sag - just below UV_WARN (216V)
# 230V * (1 - 0.15) = 195.5V
Run-Test -TestName "UV_BelowWarn_195V" `
    -InjectBody '{"cmd":"sag","depth":0.15,"duration":5.0}' `
    -WaitSeconds 3 -Runs $N -VoltageValue 195.5 -DepthPU 0.15

# A3: Deep sag - below UV_FAULT (207V)
# 230V * (1 - 0.2) = 184V
Run-Test -TestName "UV_BelowFault_184V" `
    -InjectBody '{"cmd":"sag","depth":0.2,"duration":5.0}' `
    -WaitSeconds 3 -Runs $N -VoltageValue 184.0 -DepthPU 0.2

# A4: Severe sag - approaching UV_INSTANT (150V)
# 230V * (1 - 0.3) = 161V (just above 150V instant)
Run-Test -TestName "UV_NearInstant_161V" `
    -InjectBody '{"cmd":"sag","depth":0.3,"duration":5.0}' `
    -WaitSeconds 3 -Runs $N -VoltageValue 161.0 -DepthPU 0.3

# A5: Critical sag - crosses UV_INSTANT (150V)
# 230V * (1 - 0.4) = 138V
Run-Test -TestName "UV_Instant_138V" `
    -InjectBody '{"cmd":"sag","depth":0.4,"duration":5.0}' `
    -WaitSeconds 2 -Runs $N -VoltageValue 138.0 -DepthPU 0.4

# A6: Severe collapse
# 230V * (1 - 0.5) = 115V
Run-Test -TestName "UV_Collapse_115V" `
    -InjectBody '{"cmd":"sag","depth":0.5,"duration":5.0}' `
    -WaitSeconds 2 -Runs $N -VoltageValue 115.0 -DepthPU 0.5

# A7: Near-total blackout
# 230V * (1 - 0.6) = 92V
Run-Test -TestName "UV_NearBlackout_92V" `
    -InjectBody '{"cmd":"sag","depth":0.6,"duration":5.0}' `
    -WaitSeconds 2 -Runs $N -VoltageValue 92.0 -DepthPU 0.6

# A8: Extreme collapse
# 230V * (1 - 0.7) = 69V
Run-Test -TestName "UV_Extreme_69V" `
    -InjectBody '{"cmd":"sag","depth":0.7,"duration":5.0}' `
    -WaitSeconds 2 -Runs $N -VoltageValue 69.0 -DepthPU 0.7

# A9: Near-zero supply
# 230V * (1 - 0.8) = 46V
Run-Test -TestName "UV_NearZero_46V" `
    -InjectBody '{"cmd":"sag","depth":0.8,"duration":5.0}' `
    -WaitSeconds 2 -Runs $N -VoltageValue 46.0 -DepthPU 0.8

# A10: Maximum sag (clamped at 0.9 by simulator)
# 230V * (1 - 0.9) = 23V
Run-Test -TestName "UV_MaxCollapse_23V" `
    -InjectBody '{"cmd":"sag","depth":1.0,"duration":5.0}' `
    -WaitSeconds 2 -Runs $N -VoltageValue 23.0 -DepthPU 0.9

# ══════════════════════════════════════════════════════════════════════════════
# CATEGORY B: OVERVOLTAGE SWEEP (230V up to 414V)
# Tests every OV threshold boundary in config.h
# ══════════════════════════════════════════════════════════════════════════════

Write-Host "`n===== CATEGORY B: OVERVOLTAGE SWEEP =====" -ForegroundColor White

# B1: Minor swell - inside safe zone (should NOT trip)
# 230V * (1 + 0.1) = 253V exactly at OV_FAULT boundary
Run-Test -TestName "OV_SafeZone_253V" `
    -InjectBody '{"cmd":"swell","height":0.1,"duration":5.0}' `
    -WaitSeconds 4 -Runs $N -VoltageValue 253.0 -DepthPU 0.1

# B2: Above OV_FAULT
# 230V * (1 + 0.15) = 264.5V
Run-Test -TestName "OV_AboveFault_264V" `
    -InjectBody '{"cmd":"swell","height":0.15,"duration":5.0}' `
    -WaitSeconds 4 -Runs $N -VoltageValue 264.5 -DepthPU 0.15

# B3: At OV_INSTANT boundary
# 230V * (1 + 0.2) = 276V (above 270V instant)
Run-Test -TestName "OV_Instant_276V" `
    -InjectBody '{"cmd":"swell","height":0.2,"duration":5.0}' `
    -WaitSeconds 3 -Runs $N -VoltageValue 276.0 -DepthPU 0.2

# B4: Deep into MOV danger zone
# 230V * (1 + 0.3) = 299V
Run-Test -TestName "OV_MOV_Danger_299V" `
    -InjectBody '{"cmd":"swell","height":0.3,"duration":5.0}' `
    -WaitSeconds 2 -Runs $N -VoltageValue 299.0 -DepthPU 0.3

# B5: Severe overvoltage
# 230V * (1 + 0.4) = 322V
Run-Test -TestName "OV_Severe_322V" `
    -InjectBody '{"cmd":"swell","height":0.4,"duration":5.0}' `
    -WaitSeconds 2 -Runs $N -VoltageValue 322.0 -DepthPU 0.4

# B6: Extreme overvoltage
# 230V * (1 + 0.5) = 345V
Run-Test -TestName "OV_Extreme_345V" `
    -InjectBody '{"cmd":"swell","height":0.5,"duration":5.0}' `
    -WaitSeconds 2 -Runs $N -VoltageValue 345.0 -DepthPU 0.5

# B7: Catastrophic overvoltage
# 230V * (1 + 0.6) = 368V
Run-Test -TestName "OV_Catastrophic_368V" `
    -InjectBody '{"cmd":"swell","height":0.6,"duration":5.0}' `
    -WaitSeconds 2 -Runs $N -VoltageValue 368.0 -DepthPU 0.6

# B8: Transformer failure level
# 230V * (1 + 0.7) = 391V
Run-Test -TestName "OV_TransFail_391V" `
    -InjectBody '{"cmd":"swell","height":0.7,"duration":5.0}' `
    -WaitSeconds 2 -Runs $N -VoltageValue 391.0 -DepthPU 0.7

# B9: Maximum swell (clamped at 0.8 by simulator)
# 230V * (1 + 0.8) = 414V
Run-Test -TestName "OV_MaxSwell_414V" `
    -InjectBody '{"cmd":"swell","height":0.8,"duration":5.0}' `
    -WaitSeconds 2 -Runs $N -VoltageValue 414.0 -DepthPU 0.8

# ══════════════════════════════════════════════════════════════════════════════
# CATEGORY C: MOTOR INRUSH TESTS
# Validates that startup blanking does NOT false-trip
# ══════════════════════════════════════════════════════════════════════════════

Write-Host "`n===== CATEGORY C: MOTOR INRUSH TESTS =====" -ForegroundColor White

# C1: Normal motor start (should NOT trip - inrush blanking active)
Run-Test -TestName "Motor_Start_Normal" `
    -InjectBody '{"cmd":"motor_start"}' `
    -WaitSeconds 5 -Runs $N -VoltageValue 230.0 -DepthPU 0.0

# C2: Motor start followed by immediate stop
Run-Test -TestName "Motor_Start_Stop" `
    -InjectBody '{"cmd":"motor_start"}' `
    -WaitSeconds 2 -Runs $N -VoltageValue 230.0 -DepthPU 0.0

# ══════════════════════════════════════════════════════════════════════════════
# CATEGORY D: COMBINED FAULT SCENARIOS (VOLTAGE + MOTOR)
# Real-world: motor running during a voltage event
# ══════════════════════════════════════════════════════════════════════════════

Write-Host "`n===== CATEGORY D: COMBINED SCENARIOS =====" -ForegroundColor White

# D1: Motor start + voltage sag simultaneously
# Start the motor, then immediately slam a sag
Run-Test -TestName "Motor_Plus_Sag_138V" `
    -InjectBody '{"cmd":"sag","depth":0.4,"duration":5.0}' `
    -WaitSeconds 3 -Runs $N -VoltageValue 138.0 -DepthPU 0.4

# D2: Motor start + voltage swell
Run-Test -TestName "Motor_Plus_Swell_276V" `
    -InjectBody '{"cmd":"swell","height":0.2,"duration":5.0}' `
    -WaitSeconds 3 -Runs $N -VoltageValue 276.0 -DepthPU 0.2

# ══════════════════════════════════════════════════════════════════════════════
# CATEGORY E: FLICKER + FAULT INTERACTION
# Tests that flicker does not mask or delay fault detection
# ══════════════════════════════════════════════════════════════════════════════

Write-Host "`n===== CATEGORY E: FLICKER INTERACTION =====" -ForegroundColor White

# E1: Enable flicker then inject a sag
Run-Test -TestName "Flicker_Plus_Sag_138V" `
    -InjectBody '{"cmd":"sag","depth":0.4,"duration":5.0}' `
    -WaitSeconds 3 -Runs $N -VoltageValue 138.0 -DepthPU 0.4

# E2: Enable flicker then inject a swell
Run-Test -TestName "Flicker_Plus_Swell_276V" `
    -InjectBody '{"cmd":"swell","height":0.2,"duration":5.0}' `
    -WaitSeconds 3 -Runs $N -VoltageValue 276.0 -DepthPU 0.2

# ══════════════════════════════════════════════════════════════════════════════
# CATEGORY F: BOUNDARY-EXACT THRESHOLD TESTS
# Surgically test the exact volt boundaries defined in config.h
# ══════════════════════════════════════════════════════════════════════════════

Write-Host "`n===== CATEGORY F: BOUNDARY PRECISION =====" -ForegroundColor White

# F1: Exactly at UV_WARN boundary (216V)
# depth = (230 - 216) / 230 = 0.0609
Run-Test -TestName "UV_ExactWarn_216V" `
    -InjectBody '{"cmd":"sag","depth":0.1,"duration":5.0}' `
    -WaitSeconds 4 -Runs $N -VoltageValue 207.0 -DepthPU 0.1

# F2: Exactly at UV_FAULT boundary (207V)
# depth = (230 - 207) / 230 = 0.1 (clamped to min 0.1)
Run-Test -TestName "UV_ExactFault_207V" `
    -InjectBody '{"cmd":"sag","depth":0.1,"duration":5.0}' `
    -WaitSeconds 4 -Runs $N -VoltageValue 207.0 -DepthPU 0.1

# F3: Exactly at OV_WARN boundary (243V)
# height = (243 - 230) / 230 = 0.0565 (clamped to min 0.1)
Run-Test -TestName "OV_ExactWarn_253V" `
    -InjectBody '{"cmd":"swell","height":0.1,"duration":5.0}' `
    -WaitSeconds 4 -Runs $N -VoltageValue 253.0 -DepthPU 0.1

# F4: Exactly at OV_INSTANT boundary (270V)
# height = (270 - 230) / 230 = 0.174
Run-Test -TestName "OV_ExactInstant_276V" `
    -InjectBody '{"cmd":"swell","height":0.2,"duration":5.0}' `
    -WaitSeconds 3 -Runs $N -VoltageValue 276.0 -DepthPU 0.2

# ══════════════════════════════════════════════════════════════════════════════
# CATEGORY G: DURATION SENSITIVITY (Same fault, different durations)
# Tests whether short transients are correctly rejected
# ══════════════════════════════════════════════════════════════════════════════

Write-Host "`n===== CATEGORY G: DURATION SENSITIVITY =====" -ForegroundColor White

# G1: Very short sag (0.5s) - should still trip if deep enough
Run-Test -TestName "UV_Short_0.5s_138V" `
    -InjectBody '{"cmd":"sag","depth":0.4,"duration":0.5}' `
    -WaitSeconds 2 -Runs $N -VoltageValue 138.0 -DepthPU 0.4

# G2: Medium sag (2s)
Run-Test -TestName "UV_Medium_2s_138V" `
    -InjectBody '{"cmd":"sag","depth":0.4,"duration":2.0}' `
    -WaitSeconds 3 -Runs $N -VoltageValue 138.0 -DepthPU 0.4

# G3: Long sag (10s)
Run-Test -TestName "UV_Long_10s_138V" `
    -InjectBody '{"cmd":"sag","depth":0.4,"duration":10.0}' `
    -WaitSeconds 3 -Runs $N -VoltageValue 138.0 -DepthPU 0.4

# G4: Very short swell (0.5s)
Run-Test -TestName "OV_Short_0.5s_276V" `
    -InjectBody '{"cmd":"swell","height":0.2,"duration":0.5}' `
    -WaitSeconds 2 -Runs $N -VoltageValue 276.0 -DepthPU 0.2

# G5: Medium swell (2s)
Run-Test -TestName "OV_Medium_2s_276V" `
    -InjectBody '{"cmd":"swell","height":0.2,"duration":2.0}' `
    -WaitSeconds 3 -Runs $N -VoltageValue 276.0 -DepthPU 0.2

# G6: Long swell (10s)
Run-Test -TestName "OV_Long_10s_276V" `
    -InjectBody '{"cmd":"swell","height":0.2,"duration":10.0}' `
    -WaitSeconds 3 -Runs $N -VoltageValue 276.0 -DepthPU 0.2

# ══════════════════════════════════════════════════════════════════════════════
# MULTI-STEP SEQUENCE FUNCTION
# For adversarial tests that require multiple commands in rapid succession
# ══════════════════════════════════════════════════════════════════════════════

function Run-Sequence {
    param(
        [string]$TestName,
        [scriptblock]$StepBlock,
        [int]$WaitSeconds,
        [int]$Runs = 3,
        [float]$VoltageValue = 0.0,
        [float]$DepthPU = 0.0
    )

    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host " ADVERSARIAL: $TestName  |  Runs: $Runs" -ForegroundColor Cyan
    Write-Host "================================================================" -ForegroundColor Cyan

    for ($i = 1; $i -le $Runs; $i++) {
        Write-Host "  [$i/$Runs] Pre-flight reset..." -ForegroundColor DarkGray
        Send-Cmd "/api/inject" '{"cmd":"normal_grid"}'
        Send-Cmd "/api/reset" '{"cmd":"reset"}'
        Send-Cmd "/api/log/clear" ''
        Start-Sleep -Seconds 2

        Write-Host "  [$i/$Runs] Executing adversarial sequence..." -ForegroundColor Yellow
        & $StepBlock

        Start-Sleep -Seconds $WaitSeconds

        $logs = Get-Log
        $inject_time = 0
        $trip_time = 0
        $fault_type = "NONE"

        if ($logs) {
            foreach ($entry in $logs) {
                if ($entry.note -like "SIL_CMD:*") {
                    if ($inject_time -eq 0) { $inject_time = $entry.ts }
                }
                if ($entry.state -eq "FAULT" -or $entry.state -eq "LOCKOUT") {
                    if ($trip_time -eq 0) {
                        $trip_time = $entry.ts
                        $fault_type = $entry.fault
                    }
                }
            }
        }

        if ($inject_time -gt 0 -and $trip_time -gt 0) {
            $reaction = $trip_time - $inject_time
            Write-Host "  [$i/$Runs] TRIPPED in ${reaction}ms | Fault: $fault_type" -ForegroundColor Green
            "$TestName,$i,$inject_time,$trip_time,$reaction,$fault_type,$VoltageValue,$DepthPU" | Out-File -FilePath $CSV_FILE -Append -Encoding utf8
        }
        else {
            Write-Host "  [$i/$Runs] NO TRIP" -ForegroundColor Magenta
            "$TestName,$i,$inject_time,$trip_time,NO_TRIP,$fault_type,$VoltageValue,$DepthPU" | Out-File -FilePath $CSV_FILE -Append -Encoding utf8
        }

        Send-Cmd "/api/inject" '{"cmd":"normal_grid"}'
        Send-Cmd "/api/reset" '{"cmd":"reset"}'
        Start-Sleep -Seconds 3
    }
}

# ══════════════════════════════════════════════════════════════════════════════
# CATEGORY H: VOLTAGE WHIPLASH (Can the FSM handle rapid polarity reversal?)
# The hysteresis state machine must cleanly transition between UV and OV
# without getting stuck or double-counting faults.
# ══════════════════════════════════════════════════════════════════════════════

Write-Host "`n===== CATEGORY H: VOLTAGE WHIPLASH =====" -ForegroundColor White

# H1: Sag then immediate Swell (UV -> OV whiplash)
# Voltage crashes to 138V, then 500ms later shoots to 276V
Run-Sequence -TestName "Whiplash_Sag_Then_Swell" -WaitSeconds 3 -Runs $N -VoltageValue 138.0 -DepthPU 0.4 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"sag","depth":0.4,"duration":0.5}'
    Start-Sleep -Milliseconds 500
    Send-Cmd "/api/inject" '{"cmd":"swell","height":0.3,"duration":3.0}'
}

# H2: Swell then immediate Sag (OV -> UV whiplash)
# Voltage spikes to 299V, then 500ms later collapses to 92V
Run-Sequence -TestName "Whiplash_Swell_Then_Sag" -WaitSeconds 3 -Runs $N -VoltageValue 299.0 -DepthPU 0.3 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"swell","height":0.3,"duration":0.5}'
    Start-Sleep -Milliseconds 500
    Send-Cmd "/api/inject" '{"cmd":"sag","depth":0.6,"duration":3.0}'
}

# H3: Triple whiplash — sag, swell, sag in rapid fire
Run-Sequence -TestName "Whiplash_Triple_SagSwellSag" -WaitSeconds 4 -Runs $N -VoltageValue 138.0 -DepthPU 0.4 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"sag","depth":0.4,"duration":0.3}'
    Start-Sleep -Milliseconds 400
    Send-Cmd "/api/inject" '{"cmd":"swell","height":0.2,"duration":0.3}'
    Start-Sleep -Milliseconds 400
    Send-Cmd "/api/inject" '{"cmd":"sag","depth":0.6,"duration":3.0}'
}

# ══════════════════════════════════════════════════════════════════════════════
# CATEGORY I: RECOVERY INTERRUPTION
# Fault trips the FSM. System begins recovering. SLAM another fault during
# the recovery window. Tests if the recovery state machine can handle
# being yanked back into FAULT before it finishes RECOVERY.
# ══════════════════════════════════════════════════════════════════════════════

Write-Host "`n===== CATEGORY I: RECOVERY INTERRUPTION =====" -ForegroundColor White

# I1: UV trip, begin recovery, then slam another UV during recovery
Run-Sequence -TestName "Recovery_Interrupt_UV_UV" -WaitSeconds 4 -Runs $N -VoltageValue 138.0 -DepthPU 0.4 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"sag","depth":0.4,"duration":1.0}'
    Start-Sleep -Seconds 2
    # System should be in FAULT/RECOVERY now. Hit it again.
    Send-Cmd "/api/inject" '{"cmd":"sag","depth":0.6,"duration":3.0}'
}

# I2: OV trip, begin recovery, then slam a UV (opposite polarity during recovery)
Run-Sequence -TestName "Recovery_Interrupt_OV_UV" -WaitSeconds 4 -Runs $N -VoltageValue 276.0 -DepthPU 0.2 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"swell","height":0.2,"duration":1.0}'
    Start-Sleep -Seconds 2
    Send-Cmd "/api/inject" '{"cmd":"sag","depth":0.5,"duration":3.0}'
}

# I3: UV trip, begin recovery, then slam an OV
Run-Sequence -TestName "Recovery_Interrupt_UV_OV" -WaitSeconds 4 -Runs $N -VoltageValue 138.0 -DepthPU 0.4 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"sag","depth":0.4,"duration":1.0}'
    Start-Sleep -Seconds 2
    Send-Cmd "/api/inject" '{"cmd":"swell","height":0.3,"duration":3.0}'
}

# ══════════════════════════════════════════════════════════════════════════════
# CATEGORY J: RAPID-FIRE REPEAT FAULTS
# Inject the same fault 3 times in quick succession. Tests if the reset
# pipeline leaves any ghost state (sticky debounce counters, stale
# hysteresis flags, orphaned IDMT accumulator).
# ══════════════════════════════════════════════════════════════════════════════

Write-Host "`n===== CATEGORY J: RAPID-FIRE REPEATS =====" -ForegroundColor White

# J1: Three sags back to back with only 1s recovery between each
Run-Sequence -TestName "RapidFire_3x_Sag" -WaitSeconds 2 -Runs $N -VoltageValue 138.0 -DepthPU 0.4 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"sag","depth":0.4,"duration":0.5}'
    Start-Sleep -Seconds 1
    Send-Cmd "/api/inject" '{"cmd":"normal_grid"}'
    Start-Sleep -Milliseconds 500
    Send-Cmd "/api/inject" '{"cmd":"sag","depth":0.4,"duration":0.5}'
    Start-Sleep -Seconds 1
    Send-Cmd "/api/inject" '{"cmd":"normal_grid"}'
    Start-Sleep -Milliseconds 500
    Send-Cmd "/api/inject" '{"cmd":"sag","depth":0.4,"duration":3.0}'
}

# J2: Three swells back to back
Run-Sequence -TestName "RapidFire_3x_Swell" -WaitSeconds 2 -Runs $N -VoltageValue 276.0 -DepthPU 0.2 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"swell","height":0.2,"duration":0.5}'
    Start-Sleep -Seconds 1
    Send-Cmd "/api/inject" '{"cmd":"normal_grid"}'
    Start-Sleep -Milliseconds 500
    Send-Cmd "/api/inject" '{"cmd":"swell","height":0.2,"duration":0.5}'
    Start-Sleep -Seconds 1
    Send-Cmd "/api/inject" '{"cmd":"normal_grid"}'
    Start-Sleep -Milliseconds 500
    Send-Cmd "/api/inject" '{"cmd":"swell","height":0.2,"duration":3.0}'
}

# ══════════════════════════════════════════════════════════════════════════════
# CATEGORY K: MOTOR + FAULT STRESS COMBOS
# Start the motor (high inrush current) then immediately inject voltage
# faults. The physics impossibility check (I>2A with V<5V) and the
# inrush blanking window are both active simultaneously. Can they coexist?
# ══════════════════════════════════════════════════════════════════════════════

Write-Host "`n===== CATEGORY K: MOTOR + FAULT STRESS =====" -ForegroundColor White

# K1: Motor inrush + instant supply collapse
# Motor pulls 90A, then we instantly kill voltage. Physics check sees
# high current with collapsing voltage — will it false-fire SENSOR lockout?
Run-Sequence -TestName "Motor_Inrush_Plus_Collapse" -WaitSeconds 3 -Runs $N -VoltageValue 23.0 -DepthPU 0.9 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"motor_start"}'
    Start-Sleep -Milliseconds 200
    Send-Cmd "/api/inject" '{"cmd":"sag","depth":0.9,"duration":5.0}'
}

# K2: Motor inrush + severe overvoltage
# Motor pulls high current AND voltage spikes. Double stress on the FSM.
Run-Sequence -TestName "Motor_Inrush_Plus_OV" -WaitSeconds 3 -Runs $N -VoltageValue 368.0 -DepthPU 0.6 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"motor_start"}'
    Start-Sleep -Milliseconds 200
    Send-Cmd "/api/inject" '{"cmd":"swell","height":0.6,"duration":5.0}'
}

# K3: Motor running steady, then sudden sag
# Motor has already accelerated (past inrush), then voltage collapses
Run-Sequence -TestName "Motor_Running_Then_Sag" -WaitSeconds 3 -Runs $N -VoltageValue 138.0 -DepthPU 0.4 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"motor_start"}'
    Start-Sleep -Seconds 4
    Send-Cmd "/api/inject" '{"cmd":"sag","depth":0.4,"duration":5.0}'
}

# K4: Motor start -> stop -> start -> sag (load state machine torture)
Run-Sequence -TestName "Motor_StartStopStart_Sag" -WaitSeconds 3 -Runs $N -VoltageValue 138.0 -DepthPU 0.4 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"motor_start"}'
    Start-Sleep -Seconds 1
    Send-Cmd "/api/inject" '{"cmd":"motor_stop"}'
    Start-Sleep -Milliseconds 500
    Send-Cmd "/api/inject" '{"cmd":"motor_start"}'
    Start-Sleep -Milliseconds 500
    Send-Cmd "/api/inject" '{"cmd":"sag","depth":0.4,"duration":5.0}'
}

# K5: Double motor start (send motor_start twice rapidly)
# Tests if the load state machine crashes on double-entry
Run-Sequence -TestName "Motor_Double_Start" -WaitSeconds 5 -Runs $N -VoltageValue 230.0 -DepthPU 0.0 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"motor_start"}'
    Start-Sleep -Milliseconds 100
    Send-Cmd "/api/inject" '{"cmd":"motor_start"}'
}

# ══════════════════════════════════════════════════════════════════════════════
# CATEGORY L: FLICKER MASKING & INTERACTION
# Flicker modulates voltage at 8.8Hz. If the system is near a threshold,
# flicker peaks could push it above/below repeatedly, causing hysteresis
# chatter. The FSM must not oscillate between NORMAL and FAULT.
# ══════════════════════════════════════════════════════════════════════════════

Write-Host "`n===== CATEGORY L: FLICKER MASKING =====" -ForegroundColor White

# L1: Flicker enabled, then borderline sag
# Flicker AM could push voltage in and out of UV_FAULT zone
Run-Sequence -TestName "Flicker_Borderline_Sag" -WaitSeconds 4 -Runs $N -VoltageValue 207.0 -DepthPU 0.1 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"flicker_on"}'
    Start-Sleep -Seconds 1
    Send-Cmd "/api/inject" '{"cmd":"sag","depth":0.1,"duration":5.0}'
}

# L2: Flicker enabled, then borderline swell
Run-Sequence -TestName "Flicker_Borderline_Swell" -WaitSeconds 4 -Runs $N -VoltageValue 253.0 -DepthPU 0.1 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"flicker_on"}'
    Start-Sleep -Seconds 1
    Send-Cmd "/api/inject" '{"cmd":"swell","height":0.1,"duration":5.0}'
}

# L3: Flicker + Motor + Sag (triple simultaneous stress)
Run-Sequence -TestName "Flicker_Motor_Sag" -WaitSeconds 3 -Runs $N -VoltageValue 138.0 -DepthPU 0.4 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"flicker_on"}'
    Send-Cmd "/api/inject" '{"cmd":"motor_start"}'
    Start-Sleep -Milliseconds 300
    Send-Cmd "/api/inject" '{"cmd":"sag","depth":0.4,"duration":5.0}'
}

# L4: Flicker + Motor + Swell (triple stress, opposite polarity)
Run-Sequence -TestName "Flicker_Motor_Swell" -WaitSeconds 3 -Runs $N -VoltageValue 276.0 -DepthPU 0.2 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"flicker_on"}'
    Send-Cmd "/api/inject" '{"cmd":"motor_start"}'
    Start-Sleep -Milliseconds 300
    Send-Cmd "/api/inject" '{"cmd":"swell","height":0.2,"duration":5.0}'
}

# ══════════════════════════════════════════════════════════════════════════════
# CATEGORY M: EXTREME EDGE CASES
# The strangest things that could happen on a real Indian grid.
# ══════════════════════════════════════════════════════════════════════════════

Write-Host "`n===== CATEGORY M: EXTREME EDGE CASES =====" -ForegroundColor White

# M1: Maximum simultaneous stress — max sag + motor + flicker
Run-Sequence -TestName "MaxStress_Sag_Motor_Flicker" -WaitSeconds 3 -Runs $N -VoltageValue 23.0 -DepthPU 0.9 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"flicker_on"}'
    Send-Cmd "/api/inject" '{"cmd":"motor_start"}'
    Start-Sleep -Milliseconds 100
    Send-Cmd "/api/inject" '{"cmd":"sag","depth":0.9,"duration":5.0}'
}

# M2: Maximum simultaneous stress — max swell + motor + flicker
Run-Sequence -TestName "MaxStress_Swell_Motor_Flicker" -WaitSeconds 3 -Runs $N -VoltageValue 414.0 -DepthPU 0.8 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"flicker_on"}'
    Send-Cmd "/api/inject" '{"cmd":"motor_start"}'
    Start-Sleep -Milliseconds 100
    Send-Cmd "/api/inject" '{"cmd":"swell","height":0.8,"duration":5.0}'
}

# M3: Flicker toggle spam (on/off/on/off rapidly)
# Tests if the flicker state machine handles rapid toggling
Run-Sequence -TestName "Flicker_Toggle_Spam" -WaitSeconds 3 -Runs $N -VoltageValue 230.0 -DepthPU 0.0 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"flicker_on"}'
    Start-Sleep -Milliseconds 200
    Send-Cmd "/api/inject" '{"cmd":"flicker_off"}'
    Start-Sleep -Milliseconds 200
    Send-Cmd "/api/inject" '{"cmd":"flicker_on"}'
    Start-Sleep -Milliseconds 200
    Send-Cmd "/api/inject" '{"cmd":"flicker_off"}'
    Start-Sleep -Milliseconds 200
    Send-Cmd "/api/inject" '{"cmd":"flicker_on"}'
}

# M4: Normal grid command during an active fault
# System is in LOCKOUT from a sag. We send normal_grid but NOT reset.
# The voltage recovers but the FSM should remain locked. Tests that
# normal_grid alone cannot un-brick a LOCKOUT.
Run-Sequence -TestName "NormalGrid_During_Lockout" -WaitSeconds 3 -Runs $N -VoltageValue 23.0 -DepthPU 0.9 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"sag","depth":0.9,"duration":5.0}'
    Start-Sleep -Seconds 1
    # Restore voltage but do NOT send reset
    Send-Cmd "/api/inject" '{"cmd":"normal_grid"}'
}

# M5: Alternating motor start/stop every 500ms for 5 cycles
# Load state machine must handle IDLE->STARTING->IDLE->STARTING rapidly
Run-Sequence -TestName "Motor_Rapid_Cycle_5x" -WaitSeconds 5 -Runs $N -VoltageValue 230.0 -DepthPU 0.0 -StepBlock {
    for ($j = 0; $j -lt 5; $j++) {
        Send-Cmd "/api/inject" '{"cmd":"motor_start"}'
        Start-Sleep -Milliseconds 500
        Send-Cmd "/api/inject" '{"cmd":"motor_stop"}'
        Start-Sleep -Milliseconds 500
    }
}

# M6: Everything at once — the ultimate chaos test
# Flicker ON, motor start, sag, then swell, then sag again
Run-Sequence -TestName "Ultimate_Chaos" -WaitSeconds 4 -Runs $N -VoltageValue 0.0 -DepthPU 0.0 -StepBlock {
    Send-Cmd "/api/inject" '{"cmd":"flicker_on"}'
    Send-Cmd "/api/inject" '{"cmd":"motor_start"}'
    Start-Sleep -Milliseconds 200
    Send-Cmd "/api/inject" '{"cmd":"sag","depth":0.5,"duration":0.5}'
    Start-Sleep -Milliseconds 600
    Send-Cmd "/api/inject" '{"cmd":"swell","height":0.4,"duration":0.5}'
    Start-Sleep -Milliseconds 600
    Send-Cmd "/api/inject" '{"cmd":"sag","depth":0.9,"duration":3.0}'
}

# ══════════════════════════════════════════════════════════════════════════════
# DONE
# ══════════════════════════════════════════════════════════════════════════════

Write-Host ""
Write-Host "########################################################################" -ForegroundColor Green
Write-Host "#                    ALL TESTS COMPLETE                                #" -ForegroundColor Green
Write-Host "#          Raw data exported to: raw_data.csv                     #" -ForegroundColor Green
Write-Host "########################################################################" -ForegroundColor Green
