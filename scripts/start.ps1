# Starts Veritas in the background (no console window) and opens it in the browser.
# If it is already running, it just opens the browser.
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root 'data'
$run  = Join-Path $data 'server.json'
$log  = Join-Path $data 'server.log'
$err  = Join-Path $data 'server-error.log'

function Get-Running {
    if (-not (Test-Path $run)) { return $null }
    try { $info = Get-Content $run -Raw | ConvertFrom-Json } catch { return $null }
    $p = Get-Process -Id $info.pid -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'node') { return $info }
    Remove-Item $run -ErrorAction SilentlyContinue   # left over from a crash or reboot
    return $null
}

function Fail($msg) {
    Write-Host $msg -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail 'Node.js is not installed. Install version 18 or newer from https://nodejs.org and try again.'
}

$info = Get-Running
if ($info) {
    Write-Host 'Veritas is already running.'
} else {
    New-Item -ItemType Directory -Force $data | Out-Null
    Write-Host 'Starting Veritas...'
    # Logs are overwritten on every start, so they never pile up.
    $p = Start-Process node -ArgumentList 'server.js' -WorkingDirectory $root -WindowStyle Hidden `
        -RedirectStandardOutput $log -RedirectStandardError $err -PassThru
    $deadline = (Get-Date).AddSeconds(30)
    while (-not ($info = Get-Running)) {
        if ($p.HasExited) { Get-Content $err -Tail 15 -ErrorAction SilentlyContinue; Fail 'Veritas could not start (details above).' }
        if ((Get-Date) -gt $deadline) { Fail "Veritas did not start within 30 seconds. See $err" }
        Start-Sleep -Milliseconds 300
    }
}

$url = "http://localhost:$($info.port)"
Start-Process $url
Write-Host "Veritas is running at $url"
Write-Host 'To shut it down completely, double-click stop.bat.'
Start-Sleep -Seconds 3
