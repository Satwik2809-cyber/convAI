@echo off
REM ============================================================
REM  ConvAI MVP — Windows Local Dev Startup
REM  Starts Ollama (if needed) then the Node.js backend.
REM ============================================================
title ConvAI MVP - Local Dev

echo  ================================================
echo  |   ConvAI MVP — Local Dev Startup              |
echo  ================================================
echo.

REM ── Step 1: Check if Ollama is reachable ─────────────────────────────────
echo  [1/4] Checking Ollama service...
curl -s --max-time 3 http://localhost:11434/api/tags >nul 2>&1
if %errorlevel% neq 0 (
    echo        Ollama not running. Starting ollama serve in background...
    start "Ollama Server" /min cmd /c "ollama serve"
    echo        Waiting 5 seconds for Ollama to initialise...
    timeout /t 5 /nobreak >nul
) else (
    echo        Ollama already running ✓
)

REM ── Step 2: Verify model ─────────────────────────────────────────────────
echo.
echo  [2/4] Verifying model llama3.2:1b...
ollama list 2>&1 | findstr "llama3.2" >nul
if %errorlevel% neq 0 (
    echo        Model not found. Pulling llama3.2:1b (this may take several minutes)...
    ollama pull llama3.2:1b
    if %errorlevel% neq 0 (
        echo  [ERROR] Failed to pull model. Check your internet connection.
        pause
        exit /b 1
    )
) else (
    echo        Model llama3.2:1b found ✓
)

REM ── Step 3: Run pre-flight check ─────────────────────────────────────────
echo.
echo  [3/4] Running pre-flight validation...
node scripts\checkOllama.js --no-fail
if %errorlevel% neq 0 (
    echo  [WARNING] Pre-flight check had issues. Backend will start anyway.
)

REM ── Step 4: Start backend ────────────────────────────────────────────────
echo.
echo  [4/4] Starting ConvAI backend (npm run dev)...
echo.
echo  Access points:
echo    Frontend : http://localhost:4000   (if using Docker)
echo    Backend  : http://localhost:3000
echo    Health   : http://localhost:3000/health/full
echo.
npm run dev
