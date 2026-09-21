@echo off
rem Prod server: builds dist/ first, then runs the compiled server over
rem Streamable HTTP (http://127.0.0.1:3333/mcp, health at /health).
cd /d "%~dp0"
where pnpm >nul 2>nul || (echo pnpm not found on PATH. Install Node.js 22+ and pnpm first. & pause & exit /b 1)
call pnpm build || (echo BUILD FAILED & pause & exit /b 1)
call pnpm start:http || (echo SERVER FAILED & pause & exit /b 1)
