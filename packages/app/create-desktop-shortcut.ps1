# Creates a "study-hall" shortcut on the Desktop that runs packages/app/run.cmd
# (-> http://localhost:4800). Pass -StartPool to bake --start-pool into it.
#   powershell -ExecutionPolicy Bypass -File create-desktop-shortcut.ps1
param(
  [switch]$StartPool,
  [int]$Port = 4800
)

$app = $PSScriptRoot
$desktop = [Environment]::GetFolderPath("Desktop")
$target = Join-Path $app "run.cmd"
if (-not (Test-Path $target)) { throw "Launcher not found: $target" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$ws = New-Object -ComObject WScript.Shell

$lnk = Join-Path $desktop "study-hall.lnk"
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = $target
if ($StartPool) { $sc.Arguments = "--start-pool" }
$sc.WorkingDirectory = $app
$sc.Description = "study-hall dashboard - multi-provider warm pool, planner, run history"
if ($node) { $sc.IconLocation = "$node,0" } else { $sc.IconLocation = "$env:SystemRoot\System32\shell32.dll,23" }
$sc.Save()

Write-Host "Created shortcut: $lnk"
Write-Host "  target: $target$(if ($StartPool) { ' --start-pool' })"
if (-not $StartPool) { Write-Host "  pool auto-start: off (re-run with -StartPool to enable)" }
