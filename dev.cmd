@echo off
rem Dev server: MCP over stdio, from source with auto-reload.
cd /d "%~dp0"
where pnpm >nul 2>nul || (echo pnpm not found on PATH. Install Node.js 22+ and pnpm first. & pause & exit /b 1)
call pnpm dev || (echo DEV SERVER FAILED & pause & exit /b 1)
