param([string]$Like,[switch]$Left)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace M -Name N -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,System.UIntPtr e); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);'
$A=[System.Windows.Automation.AutomationElement]; $TS=[System.Windows.Automation.TreeScope]
$win=$A::RootElement.FindFirst($TS::Children,(New-Object System.Windows.Automation.PropertyCondition($A::NameProperty,"Agents")))
[M.N]::SetForegroundWindow([System.IntPtr]$win.Current.NativeWindowHandle)|Out-Null; Start-Sleep -Milliseconds 400
$all=$win.FindAll($TS::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
foreach($e in $all){ if($e.Current.Name -like $Like){ $r=$e.Current.BoundingRectangle; $x=[int]($r.X+$r.Width/2); $y=[int]($r.Y+$r.Height/2)
  [M.N]::SetCursorPos($x,$y)|Out-Null; Start-Sleep -Milliseconds 300
  if($Left){ [M.N]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [M.N]::mouse_event(4,0,0,0,[UIntPtr]::Zero) } else { [M.N]::mouse_event(8,0,0,0,[UIntPtr]::Zero); [M.N]::mouse_event(16,0,0,0,[UIntPtr]::Zero) }
  Start-Sleep -Milliseconds 800; "clicked at $x,$y"; break } }
$all=$win.FindAll($TS::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
foreach($e in $all){ if($e.Current.ControlType.ProgrammaticName -match "MenuItem"){ "menu: " + $e.Current.Name } }
