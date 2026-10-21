# start-ai-bridge.ps1 - AI Bridge startup script (called by AIBridgeHub scheduled task at logon)
# Flow: stop any old server instance on port 9800 -> start watchdog.js (watchdog spawns
#       server.js, auto-restarts it 10s after a crash, resets crash counter after 10min
#       stable uptime; watchdog logs to ~\.ai-bridge\watchdog.log)
# NOTE: ASCII-only on purpose (PS 5.1 reads BOM-less .ps1 as ANSI; UTF-8 Chinese would mojibake).

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

# 1) Stop existing server instance listening on port 9800 (if any).
#    If watchdog is already running, its child server.js gets killed here and the
#    watchdog itself will respawn it ~10s later - self-healing, no duplicate instances.
$conns = Get-NetTCPConnection -LocalPort 9800 -State Listen -ErrorAction SilentlyContinue
if ($conns) {
    $procIds = $conns | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $procIds) {
        try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch {}
    }
    Start-Sleep -Seconds 2
}

# 2) Start watchdog if it is not already running (avoid duplicates at repeated logons).
$wdRunning = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*watchdog.js*' }
if (-not $wdRunning) {
    Start-Process -FilePath 'node.exe' -ArgumentList 'watchdog.js' -WorkingDirectory $dir -WindowStyle Hidden
}

# 3) Wait briefly and report state (helps debugging from watchdog.log / manual runs).
Start-Sleep -Seconds 5
$listen = Get-NetTCPConnection -LocalPort 9800 -State Listen -ErrorAction SilentlyContinue
if ($listen) {
    Write-Host '[start-ai-bridge] OK: ai-bridge HTTP service is listening on 127.0.0.1:9800'
} else {
    Write-Warning '[start-ai-bridge] port 9800 not listening yet (watchdog may still be starting up)'
}
