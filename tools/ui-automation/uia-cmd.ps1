param([string]$Title,[string]$Cmd)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type -Namespace W -Name U3 -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);'
$A=[System.Windows.Automation.AutomationElement]; $TS=[System.Windows.Automation.TreeScope]
$win=$A::RootElement.FindFirst($TS::Children,(New-Object System.Windows.Automation.PropertyCondition($A::NameProperty,$Title)))
[W.U3]::SetForegroundWindow([System.IntPtr]$win.Current.NativeWindowHandle)|Out-Null; Start-Sleep -Milliseconds 500
[System.Windows.Forms.SendKeys]::SendWait("^+p"); Start-Sleep -Milliseconds 700
[System.Windows.Forms.SendKeys]::SendWait($Cmd); Start-Sleep -Milliseconds 900
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}"); "ok"
