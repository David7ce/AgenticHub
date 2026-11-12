param([string]$Title="Agents",[string]$Name,[string]$Like)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A=[System.Windows.Automation.AutomationElement]; $TS=[System.Windows.Automation.TreeScope]
$win=$A::RootElement.FindFirst($TS::Children,(New-Object System.Windows.Automation.PropertyCondition($A::NameProperty,$Title)))
$all=$win.FindAll($TS::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
foreach($e in $all){ $n=$e.Current.Name; if($n -and (($Name -and $n -eq $Name) -or ($Like -and $n -like $Like))){
  $p=$null; if($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$p)){ $p.Invoke(); "invoked: $n"; exit }
  if($e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$p)){ $p.Select(); "selected: $n"; exit }
  if($e.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$p)){ $p.Expand(); "expanded: $n"; exit }
  "no pattern: $n"; exit } }
"not found"
