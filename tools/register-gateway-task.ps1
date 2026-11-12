# register-gateway-task.ps1 -- keep the AHP gateway (VS Code's Agents window host) running.
#
# YOU run this, once, in a normal (non-elevated) PowerShell:
#   powershell -ExecutionPolicy Bypass -File agent-hub\tools\register-gateway-task.ps1
#   powershell -ExecutionPolicy Bypass -File agent-hub\tools\register-gateway-task.ps1 -Remove
#
# It registers one per-user Task Scheduler task, "AgentHub gateway":
#   - triggers: at your logon, and every 5 minutes after that
#   - action: run-ahp-gateway.ps1 through `conhost --headless` (no window flashes);
#     the launcher exits at once when the gateway already answers /healthz, so the
#     5-minute repeat is a self-healing check, not a restart loop
#   - runs only while you are logged on, as you, without elevation
# Nothing here widens a consent grant: the gateway listens on loopback only and every
# agent it starts goes through consent-proxy.mjs.
param([switch]$Remove)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$name = "AgentHub gateway"

if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "removed task '$name' (a running gateway keeps running until you stop it)"
  return
}

$launcher = Join-Path $PSScriptRoot "run-ahp-gateway.ps1"
$action = New-ScheduledTaskAction -Execute "conhost.exe" `
  -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$launcher`""
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger @($logon, $repeat) `
  -Settings $settings -Principal $principal -Force | Out-Null
Write-Output "registered '$name': at logon and every 5 min. Remove with -Remove."
