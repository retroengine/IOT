param(
    [string]$ComPort = "AUTO",
    [int]$BaudRate = 115200
)

# 1. Detect ESP32
if ($ComPort -eq "AUTO") {
    $espPort = Get-PnpDevice -Class Ports -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match "CP210|CH340|FTDI|USB to UART|USB Serial" }
    if (-not $espPort) { Write-Host "No ESP32 found!" -ForegroundColor Red; return }
    $ComPort = [regex]::Match($espPort[0].FriendlyName, '(COM\d+)').Groups[1].Value
}

# 2. Open Port
$port = New-Object System.IO.Ports.SerialPort $ComPort, $BaudRate, None, 8, One
$port.DtrEnable = $false
$port.RtsEnable = $false
$port.Open()
Write-Host "Connected to $ComPort. Ready for Manual Injection." -ForegroundColor Green

try {
    Write-Host "`n--- CUSTOM INJECTION SETUP ---" -ForegroundColor Cyan
    $v = Read-Host "Enter Target Voltage (e.g. 230)"
    $i = Read-Host "Enter Target Current (e.g. 10)"

    # Hardcode long duration (10 minutes simulated time) so user doesn't have to guess
    $m = 0
    $ticks = 60000

    Write-Host "`nSetup: $v V, $i A" -ForegroundColor Yellow
    Read-Host "--- PRESS ENTER TO INJECT NOW ---"

    # 4. Fire
    $payload = "{0:N1},{1:N1},{2},{3}" -f $v, $i, $m, $ticks
    $port.WriteLine($payload)
    Write-Host "[TX] Sent: $payload" -ForegroundColor Blue

    # 5. Wait for Response (Robust Timeout Loop)
    Write-Host "Waiting for reaction..." -ForegroundColor Gray
    $StartWait = Get-Date

    while ($true) {
        if ($port.BytesToRead -gt 0) {
            $line = $port.ReadLine().Trim()
            if ([string]::IsNullOrWhiteSpace($line)) { continue }

            if ($line.StartsWith("{")) {
                $data = $line | ConvertFrom-Json
                Write-Host "`nRESULT: $($data.status)" -ForegroundColor $(if($data.status -eq "TRIPPED"){"Red"}else{"Green"})
                if($data.status -eq "TRIPPED") { Write-Host "Tripped in $($data.sim_time_ms) ms" -ForegroundColor White }
                if($data.status -eq "DONE") { Write-Host "Finished Simulation: No FAULT generated." -ForegroundColor Green }
                break
            } else {
                # PRINT ALL RAW ESP32 LOGS / CRASH DUMPS
                Write-Host "[ESP32] $line" -ForegroundColor Yellow
            }
        }

        # 10 second timeout for deep simulations
        if ((Get-Date) - $StartWait -gt [System.TimeSpan]::FromSeconds(10)) {
            Write-Host "`nTimeout waiting for response from ESP32." -ForegroundColor Red
            break
        }
        Start-Sleep -Milliseconds 10
    }
} finally {
    $port.Close()
    Write-Host "`nDone. Port Closed."
}
