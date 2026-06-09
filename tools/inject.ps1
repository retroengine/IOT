param (
    [Parameter(Mandatory=$true)]
    [float]$v,
    
    [Parameter(Mandatory=$true)]
    [float]$i
)

$IP = "10.117.3.199"
$KEY = "aec158f34ad787c"

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
