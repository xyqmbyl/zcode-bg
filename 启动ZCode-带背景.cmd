@echo off
rem ============================================================
rem  ZCode custom wallpaper launcher.
rem  Starts ZCode with a debug port and injects the background CSS.
rem  NOTE: this file is intentionally ASCII-only. Non-ASCII text in
rem  a .cmd file breaks cmd.exe parsing on some code pages; all
rem  Chinese messages are printed by zcode-bg.mjs instead.
rem ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto NONODE

node "%~dp0zcode-bg.mjs" %*
set RC=%ERRORLEVEL%
if not "%RC%"=="0" goto FAILED

echo.
echo Injector stopped (usually because ZCode was closed).
pause
exit /b 0

:NONODE
echo.
echo [!] Node.js 22 or newer is required: https://nodejs.org/
echo.
pause
exit /b 1

:FAILED
echo.
echo [!] Finished with error code %RC% - see the messages above.
echo.
pause
exit /b %RC%
