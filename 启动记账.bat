@echo off
title AI Ledger
cd /d D:\ai-ledger
echo ============================================
echo   AI Ledger starting...
echo   Browser will open http://localhost:3456
echo   Keep this window OPEN while using the app
echo ============================================

rem --- check node exists ---
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found! Please install Node.js first.
  pause
  exit /b 1
)
echo   Node version:
node --version

rem --- kill any OLD server process still listening on port 3456 ---
rem (prevents "new page + old backend" version mismatch after code updates)
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3456 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ('  Cleaning old server process (PID ' + $_.OwningProcess + ')'); Stop-Process -Id $_.OwningProcess -Force }" 2>nul

rem --- wait a moment for the port to be released ---
timeout /t 1 /nobreak >nul

start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3456"
node server.js
echo.
echo Server stopped. Press any key to close...
pause >nul
