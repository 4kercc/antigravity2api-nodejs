@echo off
echo ========================================
echo Antigravity2API Update Script
echo ========================================
echo.

echo [1/3] Stashing local changes...
git stash push -m "Auto stash before update"
if errorlevel 1 (
    echo Failed to stash changes
    pause
    exit /b 1
)

echo.
echo [2/3] Pulling latest code (branch: antigravity2api)...
git pull origin antigravity2api
if errorlevel 1 (
    echo Failed to pull updates
    pause
    exit /b 1
)

echo.
echo [3/3] Installing dependencies...
call npm install

echo.
echo ========================================
echo Update completed!
echo ========================================
echo.
echo To restore your local changes:
echo   git stash pop
echo.
echo To discard your local changes:
echo   git stash drop
echo.
pause
