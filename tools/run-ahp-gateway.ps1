# run-ahp-gateway.ps1 -- idempotent launcher for the AHP-ACP gateway behind VS Code's Agents window.
#
# Safe to run as often as you like (Task Scheduler can run it every few minutes):
#   - gateway already answering on /healthz -> exit 0 and do nothing
#   - otherwise regenerate logs\ahp-gateway.json from the hub's registry and
#     consent file, then start the pinned gateway detached and wait for /healthz
# Every provider the gateway starts goes through ahp\consent-proxy.mjs, so
# consent.json, the audit log and the spend caps still apply. Never kills
# anything and never prints a token.
param(
  [int]$Port = 8765,
  [string]$Version = "0.2.2"
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$hub = Split-Path -Parent $PSScriptRoot                       # ...\agent-hub
$root = Split-Path -Parent $hub
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "ahp-gateway-run.log"
$config = Join-Path $logDir "ahp-gateway.json"

function Write-Log([string]$msg) {
  "$(Get-Date -Format s)  $msg" | Out-File -FilePath $log -Append -Encoding utf8
}

function Test-Gateway {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2
    return [bool]$r.ok
  } catch { return $false }
}

if (Test-Gateway) { exit 0 }

$node = (Get-Command node -ErrorAction Stop).Source
& $node (Join-Path $hub "ahp\gen-config.mjs") --out $config --port $Port | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Log "not started: gen-config failed"; exit 1 }

$npx = (Get-Command npx.cmd -ErrorAction Stop).Source
Start-Process -FilePath $npx `
  -ArgumentList @("--yes", "ahp-acp-gateway@$Version", "--config", "`"$config`"") `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir "ahp-gateway-stdout.log") `
  -RedirectStandardError (Join-Path $logDir "ahp-gateway-stderr.log")

for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Gateway) { Write-Log "started gateway $Version on port $Port"; exit 0 }
}
Write-Log "started a process but /healthz did not answer within 30s (see ahp-gateway-stderr.log)"
exit 1
