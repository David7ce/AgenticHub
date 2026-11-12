param([string]$Text)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);'
$A=[System.Windows.Automation.AutomationElement]; $TS=[System.Windows.Automation.TreeScope]
$win=$A::RootElement.FindFirst($TS::Children,(New-Object System.Windows.Automation.PropertyCondition($A::NameProperty,"Agents")))
[W.U]::SetForegroundWindow([System.IntPtr]$win.Current.NativeWindowHandle) | Out-Null
Start-Sleep -Milliseconds 500
$edit=$win.FindFirst($TS::Descendants,(New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit)))
$edit.SetFocus(); Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait($Text); Start-Sleep -Milliseconds 400
$send=$win.FindFirst($TS::Descendants,(New-Object System.Windows.Automation.PropertyCondition($A::NameProperty,"Send [Alt] Send to New Chat (Ctrl+Shift+Enter)")))
$send.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
"sent"
