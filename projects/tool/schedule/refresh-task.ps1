<#
.SYNOPSIS
  Hourly safety net for the Workspaces panel: runs `cli.mjs refresh` (costs --write
  + build) so token usage is stored before agent transcripts are cleaned up.

.EXAMPLE
  pwsh -NoProfile -File refresh-task.ps1 -Action install
  pwsh -NoProfile -File refresh-task.ps1 -Action uninstall
  pwsh -NoProfile -File refresh-task.ps1 -Action run      # what the task executes
#>
param(
  [Parameter(Mandatory)][ValidateSet('install', 'uninstall', 'run')][string]$Action
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName = 'Workspaces-Refresh'
$ToolDir = Split-Path -Parent $PSScriptRoot          # projects/tool
$ProjectsDir = Split-Path -Parent $ToolDir           # projects
$HubDir = Split-Path -Parent $ProjectsDir            # AgenticHub
$LogDir = Join-Path $ProjectsDir 'logs'
$LogFile = Join-Path $LogDir 'refresh.log'

switch ($Action) {
  'install' {
    $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
    $node = (Get-Command node -ErrorAction Stop).Source
    $script = Join-Path $PSScriptRoot 'refresh-task.ps1'
    # conhost --headless keeps the hourly run from flashing a console window.
    $actionArgs = "--headless `"$pwsh`" -NoProfile -ExecutionPolicy Bypass -File `"$script`" -Action run"
    $taskAction = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument $actionArgs -WorkingDirectory $HubDir
    $hourly = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Hours 1)
    $logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries `
      -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger @($hourly, $logon) `
      -Settings $settings -Description "Runs node projects/tool/cli.mjs refresh hourly (node: $node)." -Force | Out-Null
    Write-Output "installed $TaskName (hourly + at logon), log: $LogFile"
  }
  'uninstall' {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "removed $TaskName"
  }
  'run' {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    Push-Location $HubDir
    try {
      $output = @(& node 'projects/tool/cli.mjs' 'refresh' 2>&1 | ForEach-Object { "$_" })
      $code = $LASTEXITCODE
    } finally {
      Pop-Location
    }
    $tail = @($output | Select-Object -Last 5) -join ' | '
    Add-Content -Path $LogFile -Value ("{0} exit={1} {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $code, $tail)
    exit $code
  }
}
