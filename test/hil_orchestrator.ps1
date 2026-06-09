param(
    [string]$ComPort = "AUTO",
    [int]$BaudRate = 115200,
    [string]$JsonFile = "hil_test_suite_comprehensive.json",
    [string]$CsvFile = "certification_data.csv",
    [int]$TimeoutMs = 8000
)

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " SMART GRID SENTINEL - BULLETPROOF ORCHESTRATOR" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 1. COM Port Auto-Discovery Safeback
if ($ComPort -eq "AUTO") {
    $espPort = Get-PnpDevice -Class Ports -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match "CP210|CH340|FTDI|USB to UART|USB Serial" }
    
    if (-not $espPort) {
        Write-Host "[!] FATAL: No ESP32 Silicon (CP210x, CH340, FTDI) detected. Is it plugged in?" -ForegroundColor Red
        exit
    }
    
    # Grab the first valid silicon hardware port matched
    $ComPort = [regex]::Match($espPort[0].FriendlyName, '(COM\d+)').Groups[1].Value
    Write-Host "[*] Auto-detected ESP32 explicitly on $ComPort (Bypassing Bluetooth/Phantom ports)" -ForegroundColor DarkCyan
}

# 2. Open the COM Port (Standard Protocol)
try {
    $port = New-Object System.IO.Ports.SerialPort $ComPort, $BaudRate, None, 8, One
    
    # Standard terminal programs hold DTR and RTS HIGH. Dropping them on Windows
    # often freezes the CH340/CP2102 hardware buffers, causing "write timed out".
    $port.DtrEnable = $true
    $port.RtsEnable = $true
    
    $port.ReadTimeout = $TimeoutMs
    $port.WriteTimeout = $TimeoutMs
    $port.Open()
    
    # Allow RTOS and hardware to boot/settle if opening the port triggered an auto-reset
    Start-Sleep -Seconds 3
    Write-Host "[+] Connected securely to $ComPort." -ForegroundColor Green
} catch {
    Write-Host "[!] FATAL: Failed to open $ComPort." -ForegroundColor Red
    Write-Host "    -> CLOSE PlatformIO Serial Monitor or Arduino IDE." -ForegroundColor Yellow
    exit
}

# 3. Safeback JSON Checker
if (-not (Test-Path $JsonFile)) {
    Write-Host "[!] FATAL: Could not find schema $JsonFile" -ForegroundColor Red
    $port.Close()
    exit
}

$jsonBody = ""
try {
    $jsonBody = Get-Content $JsonFile -Raw
    $tests = ($jsonBody | ConvertFrom-Json).test_cases
} catch {
    Write-Host "[!] FATAL: $JsonFile is corrupted or improperly formatted JSON." -ForegroundColor Red
    $port.Close()
    exit
}

$resultsArray = @()

$global:serialBuffer = ""

# Custom Bulletproof ReadLine Function avoiding inherent .NET Thread lockups
function Read-SerialSafe {
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    while ($stopwatch.ElapsedMilliseconds -lt $TimeoutMs) {
        if ($global:serialBuffer.Contains("`n")) {
            $idx = $global:serialBuffer.IndexOf("`n")
            $completeLine = $global:serialBuffer.Substring(0, $idx).Trim()
            $global:serialBuffer = $global:serialBuffer.Substring($idx + 1)
            return $completeLine
        }

        if ($port.BytesToRead -gt 0) {
            $global:serialBuffer += $port.ReadExisting()
        } else {
            Start-Sleep -Milliseconds 10
        }
    }
    return "TIMEOUT_ERROR"
}

# Clear any garbage boot buffers
while ($port.BytesToRead -gt 0) { $null = $port.ReadExisting() }

# 4. Master Execution Sweep
foreach ($test in $tests) {
    Write-Host ""
    Write-Host "=> RUNNING TEST: $($test.id) [$($test.category)]" -ForegroundColor Yellow
    Write-Host "   Objective: $($test.description)"
    
    # Safeback: Hard flush the ESP32 state
    $port.WriteLine("RESET")
    $ack = ""
    $syncStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    
    while ($syncStopwatch.ElapsedMilliseconds -lt 3000) {
        $line = Read-SerialSafe
        if ($line -match "TIMEOUT_ERROR") { break }
        if ($line -match "RESET_ACK") { $ack = "OK"; break }
    }
    
    if ($ack -ne "OK") {
        Write-Host "   [!] CRITICAL WARNING: Did not verify RESET_ACK. ESP32 might be out of sync or crashed." -ForegroundColor Red
        Write-Host "   -> Skipping test to prevent corrupted certification data." -ForegroundColor Red
        continue
    }
    
    $finalOutput = $null
    $total_sim_ms = 0
    $total_cpu_ms = 0.0
    $sequence_aborted = $false

    # Execute Time-Chained Sequences
    foreach ($step in $test.sequence) {
        if ($sequence_aborted) { break }
        
        $mFlag = if ($step.motor_starting) { 1 } else { 0 }
        $payload = "{0:N1},{1:N1},{2},{3}" -f $step.v, $step.i, $mFlag, $step.ticks
        
        Write-Host "   -> TX: $payload" -ForegroundColor DarkCyan
        $port.WriteLine($payload)
        
        $matchedJson = $false
        $stepStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
        
        while (-not $matchedJson -and ($stepStopwatch.ElapsedMilliseconds -lt $TimeoutMs)) {
            $respStr = Read-SerialSafe
            
            if ($respStr -eq "TIMEOUT_ERROR") {
                Write-Host "   [!] SILICON TIMEOUT: Target locked up or took longer than $($TimeoutMs)ms." -ForegroundColor Red
                $sequence_aborted = $true
                break
            }
            
            if ([string]::IsNullOrWhiteSpace($respStr)) { continue }
            
            # Smart Safeback: Trap ESP32 debug logs vs raw JSON responses
            if ($respStr.StartsWith("{") -and $respStr.EndsWith("}")) {
                Write-Host "   <- RX: $respStr" -ForegroundColor DarkGreen
                try {
                    $finalOutput = $respStr | ConvertFrom-Json
                    $total_sim_ms = $finalOutput.sim_time_ms
                    $total_cpu_ms += $finalOutput.cpu_math_ms
                    $matchedJson = $true
                } catch {
                    Write-Host "   [!] WARNING: Malformed JSON fragment crashed parser: $respStr" -ForegroundColor Red
                }
            } else {
                # Raw C++ organic prints are captured dynamically
                Write-Host "      [SILICON] $respStr" -ForegroundColor DarkGray
            }
        }
        
        if ($finalOutput -ne $null -and $finalOutput.status -eq "TRIPPED") {
            Write-Host "   [!] Target protection threw FAULT trigger, aborting future steps." -ForegroundColor DarkYellow
            $sequence_aborted = $true
        }
    }
    
    # 5. Certification Safeback Analytics 
    $pass = $true
    $failReason = ""
    
    if ($finalOutput -eq $null) {
        $pass = $false
        $failReason = "Hardware lockup, no response from ESP32."
    } else {
        $actual_result = if ($finalOutput.status -eq "TRIPPED") { "TRIP" } else { "NO_TRIP" }
        
        if ($actual_result -ne $test.expected_result) {
            $pass = $false
            $failReason = "Expected $($test.expected_result), got $actual_result"
        } elseif ($actual_result -eq "TRIP") {
            # Bounded Rule Mathematical Checks
            if ($null -ne $test.expected_time_max_ms -and $total_sim_ms -gt $test.expected_time_max_ms) {
                $pass = $false
                $failReason = "Sluggish relay: tripped at $($total_sim_ms)ms (Max limit: $($test.expected_time_max_ms)ms)"
            }
            if ($null -ne $test.expected_time_min_ms -and $total_sim_ms -lt $test.expected_time_min_ms) {
                $pass = $false
                $failReason = "Premature trip: tripped at $($total_sim_ms)ms (Min limit: $($test.expected_time_min_ms)ms)"
            }
        }
    }
    
    if ($pass) {
        Write-Host "   [CERTIFIED] Evaluation Passed" -ForegroundColor Green
    } else {
        Write-Host "   [FAILED] $failReason" -ForegroundColor Red
    }
    
    $resultsArray += [PSCustomObject]@{
        TestID = $test.id
        Category = $test.category
        Result = if($pass) {"PASS"} else {"FAIL"}
        ExpectedResult = $test.expected_result
        SimTime_ms = $total_sim_ms
        CPUTime_ms = "{0:N4}" -f $total_cpu_ms
        FailureReason = $failReason
    }
}

# 6. Safe System Cleanup
if ($port -ne $null -and $port.IsOpen) {
    $port.Close()
}
$resultsArray | Export-Csv -Path $CsvFile -NoTypeInformation

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " EXECUTION COMPLETE" -ForegroundColor Cyan
Write-Host " Total Analytics logged to: $CsvFile" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
