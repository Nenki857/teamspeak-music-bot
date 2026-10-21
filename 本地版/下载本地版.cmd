@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
echo Music Bot - Windows download
echo.
echo Download the complete Windows ZIP from GitHub Releases:
echo https://github.com/Nenki857/teamspeak-music-bot/releases
echo.
echo Extract the entire ZIP, then run "TS Music Bot.exe".
echo Do not use GitHub's "Source code" downloads to run the local app.
echo No Node.js, npm or component installer is needed.
if /i "%~1"=="--check" exit /b 0
if /i "%~1"=="--no-open" exit /b 0
start "" "https://github.com/Nenki857/teamspeak-music-bot/releases"
if errorlevel 1 echo Open the Releases URL above in your browser.
pause
exit /b 0
