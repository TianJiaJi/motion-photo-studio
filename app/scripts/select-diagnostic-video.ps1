param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Select the video for read-only codec diagnostics (no upload)'
$dialog.Filter = 'Video files|*.mp4;*.mov;*.mkv;*.m4v;*.avi;*.webm;*.ts|All files|*.*'
$dialog.Multiselect = $false
$dialog.CheckFileExists = $true
try {
  $result = $dialog.ShowDialog($owner)
  $value = @{ canceled = ($result -ne [System.Windows.Forms.DialogResult]::OK); path = $null }
  if (-not $value.canceled) { $value.path = $dialog.FileName }
  $json = $value | ConvertTo-Json -Compress
  $stream = [System.IO.File]::Open($OutputPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  $writer = New-Object System.IO.StreamWriter($stream, (New-Object System.Text.UTF8Encoding($false)))
  try { $writer.Write($json) } finally { $writer.Dispose() }
  Write-Output 'Read-only diagnostic selection recorded locally. No media copied or uploaded.'
} finally { $dialog.Dispose(); $owner.Dispose() }
