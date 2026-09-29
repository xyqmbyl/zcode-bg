@echo off
rem ============================================================
rem  Remove the injected background style and restore the default look.
rem  This also stops the resident injector (--off), so the desktop
rem  shortcut will start a fresh one next time you click it.
rem  ASCII-only on purpose: Chinese output comes from zcode-bg.mjs.
rem ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto NONODE

node "%~dp0zcode-bg.mjs" --off %*
echo.
echo The resident injector has been stopped too.
echo To get the wallpaper back, double-click the ZCode desktop shortcut.
echo For a complete reset, just quit ZCode and start it normally.
echo.
pause
exit /b 0

:NONODE
echo.
echo [!] Node.js 22 or newer is required: https://nodejs.org/
echo.
pause
exit /b 1
