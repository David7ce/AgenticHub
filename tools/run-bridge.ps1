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

# Housekeeping, at most every 30 minutes: every bridge turn leaves one session
# in the agent's own store (cwd logs\hub-bridge). Conversations are disposable,
# so delete the ones idle for over an hour, without a backup. chatmgr never
# deletes a running or current session, and --project-match keeps this away from
# anything a person opened.
function Invoke-SessionPrune {
  $stamp = Join-Path $logDir "bridge-prune.stamp"
  if ((Test-Path -LiteralPath $stamp) -and (((Get-Date) - (Get-Item -LiteralPath $stamp).LastWriteTime).TotalMinutes -lt 30)) { return }
  try {
    New-Item -ItemType File -Force -Path $stamp | Out-Null
    (Get-Item -LiteralPath $stamp).LastWriteTime = Get-Date
    $cli = Join-Path $hub "chatmgr\src\cli.mjs"
    $out = & node $cli prune-automated --project-match hub-bridge --older-than 1h --yes 2>$null | Out-String
    $r = $out | ConvertFrom-Json
    if ($r.okCount -gt 0 -or $r.failedCount -gt 0) { Write-Log "pruned bridge sessions: ok=$($r.okCount) failed=$($r.failedCount) blocked=$($r.blockedCount)" }
  } catch {
    Write-Log "session prune skipped: $($_.Exception.Message)"
  }
}

function Test-Bridge {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
    return [bool]$r.ok
  } catch { return $false }
}

Invoke-SessionPrune
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
