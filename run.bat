@echo off
REM ===== Overlay Sentinel - one-click launcher (Windows) =====
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed.
  echo  Install it from https://nodejs.org  (pick the LTS version), then run this again.
  echo.
  pause
  exit /b 1
)

echo.
echo  [1/3] Installing dependencies... (first run only, ~2-3 minutes)
call npm install
if errorlevel 1 ( echo  npm install failed. & pause & exit /b 1 )

echo.
echo  [2/3] Building the app...
call npm run build
if errorlevel 1 ( echo  Build failed. & pause & exit /b 1 )

echo.
echo  [3/3] Starting the server at http://localhost:3000
echo  Leave this window OPEN while using the app. Close it to stop.
echo.
start "" http://localhost:3000
call npx next start -p 3000

pause
