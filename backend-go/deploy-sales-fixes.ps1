# Deploys the Sales & CRM fixes. Run from an ELEVATED (Administrator) PowerShell —
# the backend runs as SYSTEM, so a normal shell cannot stop it.
#
# Frontend and backend must land together: the new UI calls endpoints that only exist
# in the new binary (GET /api/crm/tasks/{id}), and the old UI calls an endpoint that
# 500s in the old one (/api/sales/targets/actuals). Deploying either half alone leaves
# the app in a state that is broken in a different way, so this stops the server first
# and brings everything up at once.
#
# The keep-alive scheduled task fires every minute and restarts the server, so there
# is no start step here — expect it back within ~60 seconds.

$ErrorActionPreference = 'Stop'
$be   = 'C:\Users\tbabatunde\o3c-reports\backend-go'
$fe   = 'C:\Users\tbabatunde\o3c-reports\frontend'
$new  = Join-Path $be 'o3c-backend-new.exe'
$live = Join-Path $be 'o3c-backend.exe'

if (-not (Test-Path $new)) { throw "Not staged: $new. Run 'go build -o o3c-backend-new.exe .' in $be first." }

Write-Host '1/4  Building the frontend...' -ForegroundColor Cyan
Push-Location $fe
try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "frontend build failed (exit $LASTEXITCODE) — nothing has been changed yet" }
} finally { Pop-Location }

Write-Host '2/4  Stopping the backend...' -ForegroundColor Cyan
# The flag makes the next wrapper instance kill any survivor and skip its health
# self-guard. Harmless if the process is already gone.
New-Item -ItemType File -Path (Join-Path $be 'RESTART.flag') -Force | Out-Null
taskkill /IM o3c-backend.exe /F 2>$null | Out-Null
Start-Sleep -Seconds 3

Write-Host '3/4  Swapping in the new binary...' -ForegroundColor Cyan
$backup = Join-Path $be ("o3c-backend.exe.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
if (Test-Path $live) { Copy-Item $live $backup -Force }
Move-Item $new $live -Force
Write-Host "     previous binary kept at $backup"

Write-Host '4/4  Waiting for the keep-alive task to restart it...' -ForegroundColor Cyan
$up = $false
foreach ($i in 1..24) {
    Start-Sleep -Seconds 5
    try {
        if ((Invoke-WebRequest 'http://localhost:8000/api/health' -UseBasicParsing -TimeoutSec 4).StatusCode -eq 200) {
            $up = $true; break
        }
    } catch { }
    Write-Host "     still down ($($i*5)s)..."
}

if ($up) {
    Write-Host 'Backend is up.' -ForegroundColor Green
    Write-Host "Roll back with:  taskkill /IM o3c-backend.exe /F; Move-Item -Force '$backup' '$live'"
} else {
    Write-Warning "Backend did not come back within 2 minutes. Check the log:"
    Write-Warning ("  " + (Join-Path $be ('logs\backend-' + (Get-Date -Format 'yyyyMMdd') + '.log')))
    Write-Warning "Roll back with:  Move-Item -Force '$backup' '$live'"
}
