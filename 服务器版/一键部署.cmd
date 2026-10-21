@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0.."
if errorlevel 1 goto failed
echo Music Desk - Server edition
set "TSMD_ACTION=default"
set "TSMD_CHECK="
if /i "%~1"=="--check" goto check
if /i "%~1"=="--start" goto launch
if /i "%~1"=="--menu" goto menu
echo [1] Install or update and start   [M] Management menu   [0] Exit
"%SystemRoot%\System32\choice.exe" /c 1M0 /n /t 5 /d 1 /m "Starting in 5 seconds. Press M for the menu: "
if errorlevel 4 goto failed
if errorlevel 3 exit /b 0
if errorlevel 2 goto menu
if not errorlevel 1 exit /b 0
goto launch
:menu
set "TSMD_ACTION=menu"
goto launch
:check
set "TSMD_CHECK=-CheckOnly"
:launch
if not exist "%~dp0..\scripts\manage.ps1" (
  echo Missing scripts/manage.ps1. Extract the complete project before starting.
  goto failed
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\manage.ps1" -Edition server -Action %TSMD_ACTION% %TSMD_CHECK%
if errorlevel 1 goto failed
if defined TSMD_CHECK exit /b 0
pause
exit /b 0
:failed
echo.
echo Startup failed. Keep this window and report the error above.
if not defined TSMD_CHECK pause
exit /b 1
