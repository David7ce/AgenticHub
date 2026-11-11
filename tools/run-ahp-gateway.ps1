# run-ahp-gateway.ps1 -- idempotent launcher for the AHP-ACP gateway behind VS Code's Agents window.
#
# Safe to run as often as you like (run-bridge.ps1 and Task Scheduler call it every few minutes):
#   - gateway already answering on /healthz -> exit 0 and do nothing
#   - otherwise: make sure the pinned gateway is installed under logs\ahp-gateway-pkg
#     (exact version, --ignore-scripts), regenerate logs\ahp-gateway.json from the hub's
#     registry and consent file, start ahp\gateway-run.mjs detached and wait for /healthz
# gateway-run.mjs starts that installed package with the two local changes in
# ahp\gateway-patch.mjs (idempotent createSession, request log). Every provider the gateway
# starts goes through ahp\consent-proxy.mjs, so consent.json, the audit log, the spend caps
# and the permission clamp still apply. Never kills anything and never prints a token.
param(
  [int]$Port = 8765,
  [string]$Version = "0.2.3-next.202611110657.0d297c2"
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$hub = Split-Path -Parent $PSScriptRoot                       # ...\agent-hub
$root = Split-Path -Parent $hub
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "ahp-gateway-run.log"
$config = Join-Path $logDir "ahp-gateway.json"
$pkgDir = Join-Path $logDir "ahp-gateway-pkg"
$pkgJson = Join-Path $pkgDir "node_modules\ahp-acp-gateway\package.json"

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

# The pinned package, installed once. A different version on disk is reinstalled.
$installed = $null
if (Test-Path -LiteralPath $pkgJson) { $installed = (Get-Content -Raw -LiteralPath $pkgJson | ConvertFrom-Json).version }
if ($installed -ne $Version) {
  New-Item -ItemType Directory -Force -Path $pkgDir | Out-Null
  if (-not (Test-Path -LiteralPath (Join-Path $pkgDir "package.json"))) {
    '{"name":"ahp-gateway-pkg","private":true}' | Out-File -FilePath (Join-Path $pkgDir "package.json") -Encoding ascii
  }
  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & $npm install "ahp-acp-gateway@$Version" --prefix $pkgDir --ignore-scripts --no-audit --no-fund --silent 2>&1 | Out-Null
  $ErrorActionPreference = $previous
  if (-not (Test-Path -LiteralPath $pkgJson)) { Write-Log "not started: could not install ahp-acp-gateway@$Version"; exit 1 }
  Write-Log "installed ahp-acp-gateway@$Version under logs\ahp-gateway-pkg"
}

& $node (Join-Path $hub "ahp\gen-config.mjs") --out $config --port $Port | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Log "not started: gen-config failed"; exit 1 }

Start-Process -FilePath $node `
  -ArgumentList @("`"$(Join-Path $hub 'ahp\gateway-run.mjs')`"", "--config", "`"$config`"") `
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
