param([string]$Path)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type -Namespace W -Name U2 -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);'
$A=[System.Windows.Automation.AutomationElement]; $TS=[System.Windows.Automation.TreeScope]
$win=$A::RootElement.FindFirst($TS::Children,(New-Object System.Windows.Automation.PropertyCondition($A::NameProperty,"Agents")))
[W.U2]::SetForegroundWindow([System.IntPtr]$win.Current.NativeWindowHandle)|Out-Null; Start-Sleep -Milliseconds 400
$all=$win.FindAll($TS::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
foreach($e in $all){ if($e.Current.Name -like "Folder path*"){ $e.SetFocus(); Start-Sleep -Milliseconds 300
  [System.Windows.Forms.SendKeys]::SendWait("{END}"); [System.Windows.Forms.SendKeys]::SendWait("{ENTER}"); Start-Sleep -Milliseconds 700; "typed"; break } }
