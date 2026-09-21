@echo off
rem Prod server: builds dist/ first, then runs the compiled server.
rem Transport comes from .env (ORCH_TRANSPORT).
cd /d "%~dp0"
where pnpm >nul 2>nul || (echo pnpm not found on PATH. Install Node.js 22+ and pnpm first. & pause & exit /b 1)
call pnpm build || (echo BUILD FAILED & pause & exit /b 1)
call pnpm start || (echo SERVER FAILED & pause & exit /b 1)
