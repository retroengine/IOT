param (
    [Parameter(Mandatory=$true)]
    [float]$v,
    
    [Parameter(Mandatory=$true)]
    [float]$i
)

$IP = "192.168.1.100"        # ← Your ESP32 IP
$KEY = "YOUR_API_KEY"        # ← From ESP32 serial monitor at boot

$body = @{
    active = $true
    voltage = $v
    current = $i
} | ConvertTo-Json -Compress

$headers = @{
    "X-API-Key" = $KEY
    "Content-Type" = "application/json"
}

Write-Host "Injecting V=$v, I=$i ... " -NoNewline -ForegroundColor Cyan

try {
    $response = Invoke-RestMethod -Uri "http://$IP/api/inject" -Method Post -Headers $headers -Body $body -TimeoutSec 5
    Write-Host "SUCCESS: " -ForegroundColor Green -NoNewline
    Write-Host ($response | ConvertTo-Json -Compress) -ForegroundColor DarkGray
} catch {
    Write-Host "FAILED: $_" -ForegroundColor Red
}
