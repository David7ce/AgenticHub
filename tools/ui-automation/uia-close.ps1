Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A=[System.Windows.Automation.AutomationElement]; $TS=[System.Windows.Automation.TreeScope]
$win=$A::RootElement.FindFirst($TS::Children,(New-Object System.Windows.Automation.PropertyCondition($A::NameProperty,"Agents")))
$win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close(); "closed"
