@echo off
setlocal
set "PROJECT_ROOT=%~dp0.."
set "LOG_DIR=%PROJECT_ROOT%\logs"
set "LOG_FILE=%LOG_DIR%\hermes-local-worker.log"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:LOG_FILE; if ((Test-Path -LiteralPath $p) -and (Get-Item -LiteralPath $p).Length -gt 5MB) { Move-Item -LiteralPath $p -Destination ($p + '.1') -Force }"

cd /d "%PROJECT_ROOT%"
echo [%date% %time%] Starting Hermes Local Worker.>>"%LOG_FILE%"
call npm run worker:local >>"%LOG_FILE%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"
echo [%date% %time%] Hermes Local Worker exited with code %EXIT_CODE%.>>"%LOG_FILE%"
exit /b %EXIT_CODE%
