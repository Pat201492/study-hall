# Install study-hall as a logon-triggered Windows Scheduled Task, so the
# dashboard survives console close, logout, and the exit of whatever started it.
#
# This is THE durability path (decision 2026-09-14). On the v1 engine, WMI
# detached launch (Win32_Process.Create, parent WmiPrvSE) was tested twice and
# failed twice: a console signal still reached the whole process group. A task
# owned by the Task Scheduler service has no console to be signalled through,
# restarts on failure, and starts again at logon.
#
#   powershell -ExecutionPolicy Bypass -File install-scheduled-task.ps1
#   powershell -ExecutionPolicy Bypass -File install-scheduled-task.ps1 -StartPool
#   powershell -ExecutionPolicy Bypass -File install-scheduled-task.ps1 -Uninstall
#
# The pool does NOT auto-start unless -StartPool is given: starting it spends
# plan usage unattended and the plan window is account-wide.
param(
    [switch]$StartPool,
    [switch]$Uninstall,
    [int]$Port = 4800,
    [string]$TaskName = 'StudyHall'
)

$ErrorActionPreference = 'Stop'
$app = $PSScriptRoot
$launcher = Join-Path $app 'run.cmd'

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'."
    } else {
        Write-Host "No scheduled task named '$TaskName'."
    }
    return
}

if (-not (Test-Path $launcher)) { throw "Launcher not found: $launcher" }

$argument = "/c `"$launcher`""
if ($StartPool) { $argument = "/c `"$launcher`" --start-pool" }

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $argument -WorkingDirectory $app

# At LOGON, as the USER, not SYSTEM at boot: students spawn the Claude Code and
# Codex CLIs, which ride the user's own logins stored in the user profile. A
# SYSTEM-context task would have no such login and every student would fail.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

# ExecutionTimeLimit zero = no limit (the default 3 days would kill a long pool
# without explanation). MultipleInstances IgnoreNew stops the task stacking.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings `
    -Description 'study-hall dashboard (multi-provider warm pool). Survives logout; restarts on failure.' | Out-Null

Write-Host "Installed scheduled task '$TaskName'."
Write-Host "  runs:        cmd.exe $argument"
Write-Host "  trigger:     at logon ($env:USERNAME)"
Write-Host "  pool:        $(if ($StartPool) { 'auto-starts (spends plan usage unattended)' } else { 'does NOT auto-start' })"
Write-Host "  restarts:    up to 3, one minute apart"
Write-Host ""
Write-Host "Start it now:   Start-ScheduledTask -TaskName $TaskName"
Write-Host "Check it:       Get-ScheduledTaskInfo -TaskName $TaskName"
Write-Host "Dashboard:      http://localhost:$Port"
Write-Host "Remove it:      powershell -ExecutionPolicy Bypass -File install-scheduled-task.ps1 -Uninstall"
