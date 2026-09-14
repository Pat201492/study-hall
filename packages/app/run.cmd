@echo off
setlocal EnableDelayedExpansion
REM === study-hall - Windows launcher ==========================================
REM Double-click target (create-desktop-shortcut.ps1) and the command the logon
REM Scheduled Task runs (install-scheduled-task.ps1). Boots the dashboard and
REM opens it in the browser once the server is actually listening.
REM
REM Durability: a console-launched copy dies with its console. Only the logon
REM Scheduled Task survives console teardown (WMI detached launch was tested
REM twice on the v1 engine and failed both times). This script's job is to
REM restart the dashboard if it crashes, capped so a boot loop cannot spin hot,
REM and to STAND DOWN on a Windows session teardown.
REM
REM The pool does NOT auto-start. Starting it spends plan usage unattended and
REM the plan window is account-wide. Opt in:  run.cmd --start-pool
REM or set SH_AUTOSTART_POOL=1 in the environment.
title study-hall
cd /d "%~dp0..\.."

if not defined STUDY_HALL_PORT set "STUDY_HALL_PORT=4800"
if not defined STUDY_HALL_CONFIG set "STUDY_HALL_CONFIG=config.json"
set "LOG=dashboard.task.log"
set "MAX_RESTARTS=10"

REM Re-entrant helper modes, spawned by this same script.
if "%~1"=="openbrowser" goto openbrowser
if "%~1"=="poolstart" goto poolstart
if /i "%~1"=="--start-pool" set "SH_AUTOSTART_POOL=1"

REM ---- Node ------------------------------------------------------------------
REM PATH first; a GUI or Task Scheduler launch carries a thinner PATH than a
REM shell, so fall back to the standard install location before giving up.
set "NODE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE set "NODE=%%N"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE (
  echo Node.js was not found on PATH or in Program Files.
  echo Install Node 22.5+ from https://nodejs.org, then run this again.
  echo [%date% %time%] launcher aborted - node not found >> "%LOG%"
  pause
  exit /b 1
)

REM ---- First run -------------------------------------------------------------
if not exist node_modules (
  echo Installing dependencies ^(first run^)...
  call npm install
  if errorlevel 1 (
    echo npm install failed - see the output above.
    pause
    exit /b 1
  )
)

REM ---- Single-instance guard -------------------------------------------------
netstat -ano | findstr ":%STUDY_HALL_PORT% " | findstr LISTENING >nul && (
  echo study-hall already running - opening http://localhost:%STUDY_HALL_PORT%
  echo [%date% %time%] launcher exiting - already running on %STUDY_HALL_PORT% >> "%LOG%"
  start "" http://localhost:%STUDY_HALL_PORT%
  exit /b
)

REM Detached watchers, started ONCE - not inside the restart loop, or every
REM crash would re-open the browser and re-post pool/start.
start "" /b cmd /c ""%~f0" openbrowser"
if "%SH_AUTOSTART_POOL%"=="1" start "" /b cmd /c ""%~f0" poolstart"

echo Starting study-hall -^> http://localhost:%STUDY_HALL_PORT%
if "%SH_AUTOSTART_POOL%"=="1" echo Pool will auto-start once the server is up.
echo Close this window to stop.

set /a RESTARTS=0
:loop
echo [%date% %time%] launching dashboard >> "%LOG%"
REM Vendored tsx, never npx: the Task Scheduler PATH is thinner than a shell's.
"%NODE%" "node_modules\tsx\dist\cli.mjs" packages\dashboard\src\server.ts >> "%LOG%" 2>&1
set "CODE=%errorlevel%"

REM A clean exit is the user stopping it deliberately - do not resurrect it.
if "%CODE%"=="0" (
  echo [%date% %time%] dashboard exited cleanly - not restarting >> "%LOG%"
  echo study-hall stopped.
  exit /b 0
)

REM A Windows session teardown is not an application crash:
REM   -1073741205  0xC000026B  window station is shutting down  - logoff/shutdown
REM   -1073741502  0xC0000142  DLL init failed                  - same teardown
REM    1073807364  0x40010004  DBG_TERMINATE_PROCESS            - Ctrl+C / console closed
REM Restarting into a dying session cannot succeed - every child dies the same
REM way, INCLUDING the ping this script sleeps with, so the 5s backoff collapses
REM to ~30ms and the whole restart budget burns in a third of a second. Stand
REM down; the Scheduled Task brings it back at next logon.
if "%CODE%"=="-1073741205" goto teardown
if "%CODE%"=="-1073741502" goto teardown
if "%CODE%"=="1073807364" goto teardown

set /a RESTARTS+=1
if !RESTARTS! GEQ %MAX_RESTARTS% (
  echo [%date% %time%] dashboard died %MAX_RESTARTS%x - giving up >> "%LOG%"
  echo study-hall kept crashing ^(%MAX_RESTARTS% attempts^). See %LOG%.
  pause
  exit /b 1
)
echo [%date% %time%] dashboard exited code !CODE! - restart !RESTARTS!/%MAX_RESTARTS% in 5s >> "%LOG%"
call :sleep 5
goto loop

:teardown
echo [%date% %time%] dashboard exited code %CODE% - Windows session teardown, not restarting >> "%LOG%"
echo study-hall stopped - Windows session ended.
exit /b 0

:openbrowser
for /l %%i in (1,1,60) do (
  curl -s -o nul http://localhost:%STUDY_HALL_PORT%/api/health && (
    start "" http://localhost:%STUDY_HALL_PORT%
    exit /b
  )
  call :sleep 1
)
echo [%date% %time%] browser watcher gave up - server never bound >> "%LOG%"
exit /b

:poolstart
for /l %%i in (1,1,30) do (
  curl -s -o nul http://localhost:%STUDY_HALL_PORT%/api/health && (
    curl -s -X POST http://localhost:%STUDY_HALL_PORT%/api/pool/start -d "{}" >> "%LOG%" 2>&1
    echo [%date% %time%] pool/start posted >> "%LOG%"
    exit /b
  )
  call :sleep 2
)
echo [%date% %time%] poolstart gave up - dashboard never bound >> "%LOG%"
exit /b

:sleep
REM Portable sleep. timeout.exe refuses to run when stdin is redirected ("Input
REM redirection is not supported") - exactly how a shortcut, a Task Scheduler
REM launch, or any tool-spawned run invokes this script - and returns INSTANTLY,
REM turning every backoff into a hot spin. ping is the sleep that works headless.
set /a "_naps=%~1+1"
ping -n !_naps! 127.0.0.1 >nul 2>&1
exit /b 0
