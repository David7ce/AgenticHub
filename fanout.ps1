<#
  fanout.ps1 - send one prompt to several workers in parallel and collect results.

  Contract:
    -Prompt    text sent to every selected worker
    -Workers   list of workers (default: claude, opencode)
    -WorkDir   folder the workers run in (default: repo root)
    -Transport acp | cli, passed to hub.ps1 (default acp; cli is fallback)
    -Permission deny | allow-reads | allow-all, passed to hub.ps1 (default deny)
  Output:
    Prints each worker's answer under a heading and saves a merged file to
    results\<stamp>-fanout.md. Exit code 0 if at least one worker answered.
#>
param(
  [Parameter(Mandatory)][string]$Prompt,
  [string[]]$Workers = @('claude','opencode'),
  [string]$WorkDir = '',
  [ValidateSet('acp','cli')][string]$Transport = 'acp',
  [ValidateSet('deny','allow-reads','allow-all')][string]$Permission = 'deny'
)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $WorkDir) { $WorkDir = (Resolve-Path (Join-Path $here '..')).Path }
$hub = Join-Path $here 'hub.ps1'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

$jobs = foreach ($w in $Workers) {
  Start-Job -Name $w -ArgumentList $hub, $w, $Prompt, $WorkDir, $Transport, $Permission -ScriptBlock {
    param($hub, $w, $Prompt, $WorkDir, $Transport, $Permission)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $hub -Worker $w -Prompt $Prompt -WorkDir $WorkDir -Transport $Transport -Permission $Permission 2>&1 | Out-String
    [pscustomobject]@{ Worker = $w; Exit = $LASTEXITCODE; Seconds = [math]::Round($sw.Elapsed.TotalSeconds,1); Text = $out.Trim() }
  }
}

$null = Wait-Job $jobs
$rows = $jobs | Receive-Job
$jobs | Remove-Job -Force

$merged = "# Fan-out $stamp`n`nPrompt: $Prompt`n`n"
foreach ($r in $rows) {
  $status = if ($r.Exit -eq 0) { 'ok' } else { "FAILED (exit $($r.Exit))" }
  $merged += "## $($r.Worker) - $status - $($r.Seconds)s`n`n$($r.Text)`n`n"
}
$mergedFile = Join-Path $here "results\$stamp-fanout.md"
New-Item -ItemType Directory -Force -Path (Split-Path $mergedFile) | Out-Null
Set-Content -Path $mergedFile -Value $merged -Encoding UTF8
Write-Output $merged
Write-Host "[saved] $mergedFile" -ForegroundColor DarkGray

# @(...) matters: with exactly one worker the pipeline returns a scalar,
# which has no .Count in PowerShell 5.1, making a successful run look failed.
if (@($rows | Where-Object { $_.Exit -eq 0 }).Count -ge 1) { exit 0 } else { exit 1 }
