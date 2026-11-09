<#
  hub.ps1 - single entry point to call one swarm worker headlessly.

  Contract:
    -Worker    claude | opencode
    -Prompt    text to send (any quoting; passed safely)
    -WorkDir   folder the worker runs in (default: this repo root)
    -Transport acp | cli (default acp)
                 acp: Node client in acp\hub-acp.mjs (the verified path)
                 cli: per-worker CLI adapters, kept as fallback
    -Model     optional model override. ACP: passed to the selected worker
               as --model; CLI: opencode only (default opencode/beam-free)
    -Permission deny | allow-reads | allow-all (ACP only; default deny)
    -Timeout   seconds before the call is abandoned (default 180)
    -BudgetUsd per-run cost cap for the ACP path (default 0.50)
  Output:
    Prints the worker's answer to stdout and saves it to
    results\<yyyyMMdd-HHmmss>-<worker>.md.
    Exit code: 0 answered, 1 denied/rejected/failed/empty, 2 timed out.
  Run with:
    powershell -NoProfile -ExecutionPolicy Bypass -File hub.ps1 -Worker ... -Prompt ...
  Consent gate:
    Every call checks consent.json (enabled, overseerAck, not expired) before
    running. In ACP mode the inner hub-acp.mjs writes the audit line (session
    id, stop reason, reported cost), so this script logs only pre-run
    rejections and its own timeout; in CLI mode this script writes it.
  Notes:
    CLI workers are called with stdin closed; otherwise headless CLIs wait
    forever. ACP workers get the prompt as an argument instead.
    OpenCode CLI mode runs inside WSL Ubuntu via run-opencode.sh; ACP mode
    spawns it through the registry (wsl.exe when this runs on Windows).
#>
param(
  [Parameter(Mandatory)][ValidateSet('claude','opencode')][string]$Worker,
  [Parameter(Mandatory)][string]$Prompt,
  [string]$WorkDir = '',
  [ValidateSet('acp','cli')][string]$Transport = 'acp',
  [string]$Model = '',
  [ValidateSet('deny','allow-reads','allow-all')][string]$Permission = 'deny',
  [int]$Timeout = 180,
  [double]$BudgetUsd = 0.50
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $WorkDir) { $WorkDir = (Resolve-Path (Join-Path $here '..')).Path }
$resultsDir = Join-Path $here 'results'
$consentPath = Join-Path $here 'consent.json'
$logPath = Join-Path (Resolve-Path (Join-Path $here '..')).Path 'logs\runs.jsonl'
$MaxPromptChars = 4000
$MaxOutputChars = 20000

# CLI mode keeps the old default; ACP mode leaves the model to the registry's
# defaultConfig (or an explicit -Model).
if ($Transport -eq 'cli' -and -not $Model) { $Model = 'opencode/beam-free' }

function Now-Iso { (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ") }

function Test-Consent([string]$worker) {
  $all = Get-Content $consentPath -Raw | ConvertFrom-Json
  $entry = $all.$worker
  if (-not $entry -or $entry.enabled -ne $true) { return @{ ok = $false; reason = 'no consent recorded (enabled is not true)' } }
  if ($entry.overseerAck -ne $true) { return @{ ok = $false; reason = 'Overseer has not acknowledged this grant' } }
  if ($entry.expires -and ([datetime]$entry.expires) -lt (Get-Date).ToUniversalTime()) {
    return @{ ok = $false; reason = "consent expired on $($entry.expires)" }
  }
  return @{ ok = $true }
}

function Write-RunLog([hashtable]$record) {
  $logDir = Split-Path -Parent $logPath
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  ($record | ConvertTo-Json -Compress -Depth 5) | Add-Content -Path $logPath -Encoding UTF8
}

function Truncate([string]$text, [int]$max) {
  if ($null -eq $text) { return '' }
  if ($text.Length -gt $max) { return $text.Substring(0, $max) + '...[truncated]' }
  return $text
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$started = Now-Iso
$truncPrompt = Truncate $Prompt $MaxPromptChars

if (-not $Prompt -or -not $Prompt.Trim()) {
  Write-RunLog @{ time = $started; agent = $Worker; transport = $Transport; prompt = $truncPrompt; status = 'rejected'; reason = 'empty prompt' }
  Write-Error "[$Worker] rejected: empty prompt"
  exit 1
}
if ($Prompt.Length -gt $MaxPromptChars) {
  Write-RunLog @{ time = $started; agent = $Worker; transport = $Transport; prompt = $truncPrompt; status = 'rejected'; reason = 'prompt too long' }
  Write-Error "[$Worker] rejected: prompt too long"
  exit 1
}

$consent = Test-Consent $Worker
if (-not $consent.ok) {
  Write-RunLog @{ time = $started; agent = $Worker; transport = $Transport; prompt = $truncPrompt; status = 'denied'; reason = $consent.reason }
  Write-Error "[$Worker] denied: $($consent.reason)"
  exit 1
}

# ACP needs Node and the client script before it is worth starting a job.
$nodePath = ''
$acpHub = Join-Path $here 'acp\hub-acp.mjs'
if ($Transport -eq 'acp') {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    Write-RunLog @{ time = $started; agent = $Worker; transport = $Transport; prompt = $truncPrompt; status = 'failed'; reason = 'node is not on PATH' }
    Write-Error '[acp] node is not on PATH (the ACP transport needs Node 24+).'
    exit 1
  }
  $nodePath = $nodeCmd.Source
  if (-not (Test-Path $acpHub)) {
    Write-RunLog @{ time = $started; agent = $Worker; transport = $Transport; prompt = $truncPrompt; status = 'failed'; reason = "ACP client not found: $acpHub" }
    Write-Error "[acp] client not found: $acpHub"
    exit 1
  }
}
# Leave headroom so the ACP client reports its own timeout (exit 2) before
# this script abandons the job.
$acpTimeoutSec = [int][Math]::Max(10, $Timeout - 15)
$budgetInvariant = $BudgetUsd.ToString([Globalization.CultureInfo]::InvariantCulture)

New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null
$outFile = Join-Path $resultsDir "$stamp-$Worker.md"

# Prompt goes through a temp file so quotes and newlines survive every hop.
$promptFile = Join-Path ([IO.Path]::GetTempPath()) "hub-prompt-$stamp-$Worker.txt"
[IO.File]::WriteAllText($promptFile, $Prompt, (New-Object Text.UTF8Encoding($false)))

$job = Start-Job -ArgumentList $Worker, $promptFile, $WorkDir, $Model, $here, $budgetInvariant, `
    $Transport, $Permission, $nodePath, $acpHub, $acpTimeoutSec -ScriptBlock {
  param($Worker, $promptFile, $WorkDir, $Model, $here, $budgetInvariant, $Transport, $Permission, $nodePath, $acpHub, $acpTimeoutSec)
  Set-Location $WorkDir
  $p = [IO.File]::ReadAllText($promptFile)

  if ($Transport -eq 'acp') {
    $a = @(
      $acpHub, '--agent', $Worker, '--prompt', $p, '--cwd', $WorkDir,
      '--permission', $Permission, '--budget', $budgetInvariant,
      '--timeout', "$($acpTimeoutSec * 1000)", '--no-save'
    )
    if ($Model) { $a += @('--model', $Model) }

    $errFile = Join-Path ([IO.Path]::GetTempPath()) ("hub-acp-{0}-{1}.err" -f $Worker, [guid]::NewGuid().ToString('N'))
    $o = & $nodePath @a 2>$errFile | Out-String
    $code = $LASTEXITCODE
    $errText = if (Test-Path $errFile) { (Get-Content $errFile -Raw) } else { '' }
    Remove-Item $errFile -ErrorAction SilentlyContinue
    return [pscustomobject]@{ Out = $o; Err = $errText; Code = $code }
  }

  switch ($Worker) {
    'claude'   {
      $o = '' | & claude -p $p --permission-prompts none --no-session-persistence --max-budget-usd $budgetInvariant 2>&1 | Out-String
    }
    'opencode' {
      $wd = (& wsl -e wslpath -a $WorkDir).Trim()
      $pf = (& wsl -e wslpath -a $promptFile).Trim()
      $sh = (& wsl -e wslpath -a (Join-Path $here 'run-opencode.sh')).Trim()
      $o = & wsl -e bash $sh $wd $pf $Model 2>&1 | Out-String
    }
  }
  [pscustomobject]@{ Out = $o; Err = ''; Code = $LASTEXITCODE }
}

if (-not (Wait-Job $job -Timeout $Timeout)) {
  Stop-Job $job; Remove-Job $job -Force
  Remove-Item $promptFile -ErrorAction SilentlyContinue
  Write-RunLog @{ time = $started; agent = $Worker; transport = $Transport; prompt = $truncPrompt; status = 'timeout'; timedOut = $true; ended = (Now-Iso) }
  Write-Error "[$Worker] timed out after ${Timeout}s"
  exit 2
}
$res = Receive-Job $job | Select-Object -Last 1
Remove-Job $job -Force
Remove-Item $promptFile -ErrorAction SilentlyContinue

$answer = if ($res) { "$($res.Out)".Trim() } else { '' }
if ($res -and $res.Code -ne 0 -and $res.Err) {
  # Native-command stderr arrives wrapped in PowerShell error formatting;
  # keep the [acp] lines when there are any, otherwise the last raw lines.
  $acpLines = @(
    [regex]::Matches($res.Err, '\[acp\][^\r\n]*') |
      ForEach-Object { $_.Value } |
      Where-Object { $_ -notmatch 'RemoteException|CategoryInfo|FullyQualifiedErrorId' } |
      Select-Object -Unique
  )
  $errLines = if ($acpLines.Count -gt 0) {
    ($acpLines | Select-Object -Last 6) -join "`n"
  } else {
    ($res.Err.Trim() -split "`r?`n" | Select-Object -Last 8) -join "`n"
  }
  $answer = ($answer + "`n" + $errLines).Trim()
}
# Strip terminal color codes and OpenCode's "> agent · model" banner line.
$answer = [regex]::Replace($answer, '\x1b\[[0-9;]*[A-Za-z]', '')
$answer = ($answer -split "`r?`n" | Where-Object { $_ -notmatch '^\s*>\s+\w+\s+\S+\s+\S+\s*$' -and $_ -notmatch '^\S+\s+(Read|Write|Edit|List|Glob|Grep|Bash)\b' }) -join "`n"
$answer = $answer.Trim()

if ($res.Code -ne 0 -or -not $answer) {
  # In ACP mode the inner client already recorded this run (with session,
  # stop reason and cost), so only CLI mode logs here -- no double entries.
  if ($Transport -eq 'cli') {
    Write-RunLog @{
      time = $started; agent = $Worker; transport = $Transport; prompt = $truncPrompt
      exitCode = $res.Code; timedOut = $false
      output = (Truncate $answer $MaxOutputChars)
      ended = (Now-Iso); status = 'failed'
    }
  }
  Write-Host "[$Worker] FAILED (exit $($res.Code))`n$answer"
  exit 1
}

if ($Transport -eq 'cli') {
  Write-RunLog @{
    time = $started; agent = $Worker; transport = $Transport; prompt = $truncPrompt
    exitCode = $res.Code; timedOut = $false
    output = (Truncate $answer $MaxOutputChars)
    ended = (Now-Iso); status = 'ok'
  }
}

$header = "<!-- worker: $Worker | transport: $Transport | time: $stamp | workdir: $WorkDir -->`n`n"
Set-Content -Path $outFile -Value ($header + $answer) -Encoding UTF8
Write-Output $answer
Write-Host "[saved] $outFile" -ForegroundColor DarkGray
exit 0
