@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
echo Music Desk - 本地版
echo [1] 安装、更新并启动  [M] 管理菜单  [0] 退出
choice /c 1M0 /n /t 5 /d 1 /m "5 秒后自动执行，按 M 打开管理菜单："
if errorlevel 3 exit /b 0
set "TSMD_ACTION=default"
if errorlevel 2 set "TSMD_ACTION=menu"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\manage.ps1" -Edition local -Action %TSMD_ACTION%
if errorlevel 1 goto failed
exit /b 0
:failed
echo 操作未完成。请保留上方错误，修复后重新运行同一入口。
pause
exit /b 1
