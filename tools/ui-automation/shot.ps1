Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
$A=[System.Windows.Automation.AutomationElement]; $TS=[System.Windows.Automation.TreeScope]
$win=$A::RootElement.FindFirst($TS::Children,(New-Object System.Windows.Automation.PropertyCondition($A::NameProperty,"Agents")))
$r=$win.Current.BoundingRectangle
$bmp=New-Object System.Drawing.Bitmap ([int]$r.Width),([int]$r.Height)
$g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen([int]$r.X,[int]$r.Y,0,0,$bmp.Size)
$bmp.Save($args[0],[System.Drawing.Imaging.ImageFormat]::Png); "saved"
