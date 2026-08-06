@echo off
echo ========================================
echo Antigravity2API Setup Script
echo ========================================
echo.

echo [1/6] Cloning repository...
if exist "antigravity2api-nodejs" (
    echo Directory already exists, exiting...
    pause
    exit /b 1
)
git clone https://github.com/4kercc/antigravity2api-nodejs.git
if errorlevel 1 (
    echo Failed to clone repository
    pause
    exit /b 1
)

echo.
echo [2/6] Entering project directory...
cd antigravity2api-nodejs

echo.
echo [3/6] Installing dependencies...
call npm install
if errorlevel 1 (
    echo Failed to install dependencies
    pause
    exit /b 1
)

echo.
echo [4/6] Copying config file...
copy .env.example .env >nul

echo.
echo [5/6] Configure admin credentials...
echo.
set /p ADMIN_USER="Enter admin username (default: admin): "
if "%ADMIN_USER%"=="" set ADMIN_USER=admin

set /p ADMIN_PASS="Enter admin password (default: admin123): "
if "%ADMIN_PASS%"=="" set ADMIN_PASS=admin123

set /p API_KEY="Enter API key (default: sk-text): "
if "%API_KEY%"=="" set API_KEY=sk-text

powershell -NoProfile -ExecutionPolicy Bypass -Command "$content = Get-Content .env -Raw -Encoding UTF8; $content = $content -replace '(?m)^# API_KEY=.*', ('API_KEY=' + '%API_KEY%'); $content = $content -replace '(?m)^# ADMIN_USERNAME=.*', ('ADMIN_USERNAME=' + '%ADMIN_USER%'); $content = $content -replace '(?m)^# ADMIN_PASSWORD=.*', ('ADMIN_PASSWORD=' + '%ADMIN_PASS%'); $content = $content -replace '(?m)^# JWT_SECRET=.*', 'JWT_SECRET=change-this-secret-key'; [System.IO.File]::WriteAllText((Resolve-Path .env), $content, (New-Object System.Text.UTF8Encoding $false))"

echo.
echo ========================================
echo Configuration complete! Starting service...
echo ========================================
echo.
echo Available services:
echo.
echo 1. Web UI: http://127.0.0.1:8045
echo    - Username: %ADMIN_USER%
echo    - Password: %ADMIN_PASS%
echo    - Login first to configure Antigravity or Gemini CLI credentials
echo.
echo 2. Antigravity API endpoints:
echo    - OpenAI format: http://127.0.0.1:8045/v1
echo    - Gemini format: http://127.0.0.1:8045/v1beta
echo    - Claude format: http://127.0.0.1:8045/v1
echo.
echo 3. Gemini CLI API endpoints:
echo    - OpenAI format: http://127.0.0.1:8045/cli/v1
echo    - Gemini format: http://127.0.0.1:8045/cli/v1beta
echo.
echo ========================================
echo.

echo [6/6] Starting service...
call npm start
