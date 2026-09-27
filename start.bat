@echo off
rem Start Stash (production build). Double-click or run from any terminal.
cd /d "%~dp0"

rem Clear the variable that turns electron.exe into pure-node mode (injected by some hosts)
set ELECTRON_RUN_AS_NODE=

rem Always rebuild: the old script built only when out\main\main.js was missing,
rem so source edits were never picked up and the app kept running a stale bundle.
echo Building Stash...
call npx electron-vite build
if errorlevel 1 (
  echo.
  echo Build failed. Launch aborted.
  pause
  exit /b 1
)
echo.
echo Launching Stash...

"node_modules\electron\dist\electron.exe" . %*
