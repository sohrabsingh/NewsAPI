# Shuts down every Veritas server process for this folder, and only those
# (your other Node.js programs are left alone).
$root = Split-Path -Parent $PSScriptRoot
$run  = Join-Path $root 'data\server.json'
$pids = @()

# 1) The process recorded by the server itself (started via start.bat or npm start).
if (Test-Path $run) {
    try {
        $info = Get-Content $run -Raw | ConvertFrom-Json
        $p = Get-Process -Id $info.pid -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -eq 'node') { $pids += [int]$info.pid }
    } catch {}
}

# 2) Fallback: a node process still listening on the app's port (PORT from .env, default 3000).
$port = 3000
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
    $m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
    if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
}
if ($info -and $info.port) { $port = [int]$info.port }
foreach ($c in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'node') { $pids += [int]$c.OwningProcess }
}

$pids = $pids | Sort-Object -Unique
if (-not $pids) {
    Write-Host 'Veritas is not running.'
} else {
    foreach ($id in $pids) {
        taskkill /PID $id /T /F | Out-Null   # /T also ends any child processes
        Write-Host "Stopped Veritas (process $id)."
    }
}
Remove-Item $run -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
