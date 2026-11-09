# run-consent-reminder.ps1 — Task Scheduler entry point for consent-reminder.mjs.
#
# No external service: this pops a native Windows balloon notification when
# a consent grant is close to expiring, using .NET's NotifyIcon -- no module
# install, no account, no token to store anywhere. consent-reminder.mjs's
# exit code is the signal: 2 means something is due, 0 means nothing is,
# anything else is an error. Both are logged either way.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $here "..\results\consent-reminder.log"
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

$output = & node (Join-Path $here "consent-reminder.mjs") 2>&1 | Out-String
$exitCode = $LASTEXITCODE
"$(Get-Date -Format s)  exit=$exitCode`n$($output.Trim())`n" | Out-File -FilePath $log -Append -Encoding utf8

if ($exitCode -eq 2) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $icon = New-Object System.Windows.Forms.NotifyIcon
  try {
    $icon.Icon = [System.Drawing.SystemIcons]::Warning
    $icon.Visible = $true
    $icon.ShowBalloonTip(15000, "AgentHub consent renewal needed", $output.Trim(), [System.Windows.Forms.ToolTipIcon]::Warning)
    Start-Sleep -Seconds 16
  } finally {
    $icon.Dispose()
  }
}
