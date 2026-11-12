Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($w in $wins) {
  $n = $w.Current.Name
  if ($n -and $w.Current.ProcessId) {
    $p = (Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName
    "{0,-12} {1}" -f $p, $n.Substring(0,[Math]::Min(90,$n.Length))
  }
}
