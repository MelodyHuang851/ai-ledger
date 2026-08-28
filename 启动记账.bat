@echo off
title AI Ledger
cd /d D:\ai-ledger
echo ============================================
echo   AI Ledger starting...
echo   Browser will open http://localhost:3456
echo   Keep this window OPEN while using the app
echo ============================================
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3456"
node server.js
echo.
echo Server stopped. Press any key to close...
pause >nul
