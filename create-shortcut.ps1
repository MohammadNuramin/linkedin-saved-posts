$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcut = $ws.CreateShortcut("$desktop\LinkedIn Saved Posts.lnk")
$shortcut.TargetPath = "$PSScriptRoot\start.bat"
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = "Start LinkedIn Saved Posts Viewer"
$shortcut.Save()
Write-Host "Shortcut created on Desktop"
