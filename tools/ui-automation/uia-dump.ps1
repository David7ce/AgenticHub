param([string]$Title="Agents",[int]$Max=120)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A=[System.Windows.Automation.AutomationElement]; $TS=[System.Windows.Automation.TreeScope]
$win=$A::RootElement.FindFirst($TS::Children,(New-Object System.Windows.Automation.PropertyCondition($A::NameProperty,$Title)))
for($i=0;$i -lt 5;$i++){ $all=$win.FindAll($TS::Descendants,[System.Windows.Automation.Condition]::TrueCondition); if($all.Count -gt 50){break}; Start-Sleep 2 }
"elements: $($all.Count)"
$n=0
foreach($e in $all){ $t=$e.Current.ControlType.ProgrammaticName.Replace("ControlType.",""); $nm=$e.Current.Name
  if($nm -and $t -match "Button|Edit|MenuItem|TabItem|ListItem|ComboBox|Hyperlink|CheckBox|RadioButton|Document"){ "{0}: {1}" -f $t,$nm.Substring(0,[Math]::Min(80,$nm.Length)); $n++; if($n -ge $Max){break} } }
