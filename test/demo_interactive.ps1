param(
    [string]$ComPort = "AUTO",
    [int]$BaudRate = 115200,
    [int]$TimeoutMs = 8000
)

# --- UI Functions ---
function Show-Header {
    Clear-Host
    Write-Host "=========================================================" -ForegroundColor Cyan
    Write-Host "         SMART GRID SENTINEL - PRESENTATION TOOL         " -ForegroundColor Cyan
    Write-Host "=========================================================" -ForegroundColor Cyan
}

# --- COM Port Setup ---
if ($ComPort -eq "AUTO") {
    $espPort = Get-PnpDevice -Class Ports -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match "CP210|CH340|FTDI|USB to UART|USB Serial" }
    if (-not $espPort) {
        Write-Host "[!] ERROR: No ESP32 detected. Is it plugged in?" -ForegroundColor Red
        return
    }
    $ComPort = [regex]::Match($espPort[0].FriendlyName, '(COM\d+)').Groups[1].Value
    Write-Host "[*] Auto-detected ESP32 on $ComPort" -ForegroundColor DarkCyan
}

try {
    $port = New-Object System.IO.Ports.SerialPort $ComPort, $BaudRate, None, 8, One
    $port.DtrEnable = $true
    $port.RtsEnable = $true
    $port.ReadTimeout = $TimeoutMs
    $port.WriteTimeout = $TimeoutMs
    $port.Open()
    Start-Sleep -Seconds 2 # Wait for boot
    Write-Host "[+] Connection Secure." -ForegroundColor Green
} catch {
    Write-Host "[!] FATAL: Could not open $ComPort. Close other Serial Monitors first!" -ForegroundColor Red
    return
}

# --- Serial Reader ---
$global:serialBuffer = ""
function Read-SerialSafe {
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    while ($stopwatch.ElapsedMilliseconds -lt $TimeoutMs) {
        if ($global:serialBuffer.Contains("`n")) {
            $idx = $global:serialBuffer.IndexOf("`n")
            $line = $global:serialBuffer.Substring(0, $idx).Trim()
            $global:serialBuffer = $global:serialBuffer.Substring($idx + 1)
            return $line
        }
        if ($port.BytesToRead -gt 0) { $global:serialBuffer += $port.ReadExisting() }
        Start-Sleep -Milliseconds 10
    }
    return "TIMEOUT"
}

# --- Execution Core ---
function Invoke-Demo {
    param($v, $i, $m = 0, $desc = "Demo Event")
    Show-Header
    Write-Host ">>> SCENARIO: $desc" -ForegroundColor Yellow
    Write-Host "    Settings: $v Volts | $i Amps" -ForegroundColor Gray
    Write-Host ""
    
    # This is the "Wait for Reaction" part
    Read-Host "--- READY? PRESS ENTER TO INJECT FAULT ---"
    
    $payload = "{0:N1},{1:N1},{2},250" -f $v, $i, $m
    $port.WriteLine($payload)
    
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    while ($stopwatch.ElapsedMilliseconds -lt 5000) {
        $resp = Read-SerialSafe
        if ($resp -eq "TIMEOUT") { break }
        if ($resp.StartsWith("{")) {
            $data = $resp | ConvertFrom-Json
            if ($data.status -eq "TRIPPED") {
                Write-Host "`n[!!!] SYSTEM TRIPPED [!!!]" -ForegroundColor Red -BackgroundColor Black
                Write-Host "   Reaction: $($data.sim_time_ms) ms" -ForegroundColor White
                Write-Host "   Reason  : $($data.fault_bit)" -ForegroundColor White
            } else {
                Write-Host "`n[OK] SYSTEM STABLE" -ForegroundColor Green
                Write-Host "   Reading: $($data.v_rms)V, $($data.i_rms)A" -ForegroundColor Gray
            }
            break
        }
    }
    Write-Host ""
    Read-Host "Press Enter for Menu..."
}

# --- Main Menu ---
try {
    do {
        Show-Header
        Write-Host "Select Scenario for Mam:"
        Write-Host " [1] Normal Grid (230V, 5A)"
        Write-Host " [2] Voltage Sag (180V) - Shows Warning"
        Write-Host " [3] Supply Collapse (100V) - Instant Trip"
        Write-Host " [4] Overcurrent (22A) - Show Slow Accumulation"
        Write-Host " [5] Short Circuit (100A) - Show Instant Hardware Protection"
        Write-Host " [6] Motor Inrush (30A) - Show Smart Inrush Filtering"
        Write-Host " [7] CUSTOM INPUT (Build your own test)" -ForegroundColor Cyan
        Write-Host " [R] Reset Controller"
        Write-Host " [Q] Quit"
        Write-Host ""
        $choice = Read-Host "Choice"
        
        switch ($choice) {
            "1" { Invoke-Demo 230 5 0 "Baseline" }
            "2" { Invoke-Demo 180 8 0 "Voltage Sag" }
            "3" { Invoke-Demo 100 5 0 "Total Supply Collapse" }
            "4" { Invoke-Demo 230 22 0 "Sustained Overload" }
            "5" { Invoke-Demo 230 100 0 "Deadly Short Circuit" }
            "6" { Invoke-Demo 230 30 1 "High-Power Motor Starting" }
            "7" {
                $v = Read-Host "Enter Voltage"
                $i = Read-Host "Enter Current"
                $mChoice = Read-Host "Motor Start? (y/n)"
                $m = if($mChoice -eq "y"){1}else{0}
                Invoke-Demo $v $i $m "Manual User Input"
            }
            "R" { $port.WriteLine("RESET"); Start-Sleep -Seconds 1 }
        }
    } while ($choice -ne "Q")
} finally {
    if ($null -ne $port) { $port.Close(); Write-Host "Port Closed." }
}
