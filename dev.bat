@echo off
rem Start Stash in dev mode (hot reload for renderer). Press Ctrl+C to stop.
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
call npm run dev
