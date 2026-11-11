# run-bridge.ps1 -- idempotent launcher for the VS Code Custom Endpoint bridge.
#
# Safe to run as often as you like (Task Scheduler runs it every few minutes):
#   - bridge already answering on /health  -> exit 0 and do nothing
#   - otherwise start `node bridge/server.mjs` detached, wait for /health
# It never kills anything and never reads or prints the bridge token. The
# bridge is the same loopback-only, token-protected process you would start by
# hand; this only saves you from having to remember to.
param(
  [int]$Port = 3010,
  [string]$Config = ""
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$hub = Split-Path -Parent $PSScriptRoot                       # ...\agent-hub
if (-not $Config) { $Config = Join-Path $hub "bridge\config.json" }
$logDir = Join-Path (Split-Path -Parent $hub) "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "bridge-run.log"

function Write-Log([string]$msg) {
  "$(Get-Date -Format s)  $msg" | Out-File -FilePath $log -Append -Encoding utf8
}

function Test-Bridge {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
    return [bool]$r.ok
  } catch { return $false }
}

if (Test-Bridge) { exit 0 }

if (-not (Test-Path -LiteralPath $Config)) {
  Write-Log "not started: no config at $Config (copy bridge\config.example.json)"
  exit 1
}

$node = (Get-Command node -ErrorAction Stop).Source
$server = Join-Path $hub "bridge\server.mjs"
Start-Process -FilePath $node `
  -ArgumentList @("`"$server`"", "--config", "`"$Config`"", "--port", "$Port") `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir "bridge-stdout.log") `
  -RedirectStandardError (Join-Path $logDir "bridge-stderr.log")

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Bridge) { Write-Log "started on port $Port"; exit 0 }
}
Write-Log "started a process but /health did not answer within 10s (see bridge-stderr.log)"
exit 1
