@echo off
echo ============================================================
echo  ConvAI MVP - Full Startup
echo ============================================================

echo.
echo [1/3] IMPORTANT: Close any 'ollama run' terminal windows!
echo       They block Ollama's API from serving requests.
echo       The Ollama API should be available at http://localhost:11434
echo.
pause

echo.
echo [2/3] Starting Fast Python LLM Server (port 11435)...
start "ConvAI Python LLM" cmd /k "python scripts/python_llm_server.py"
timeout /t 3 /nobreak > nul

echo.
echo [3/3] Starting Node.js Backend...
start "ConvAI Node Backend" cmd /k "npm run dev"
timeout /t 5 /nobreak > nul

echo.
echo ============================================================
echo  All services started!
echo  - Python LLM Server: http://localhost:11435
echo  - Node Backend:      http://localhost:3000
echo  - Web UI:            http://localhost:3000/client/index.html
echo ============================================================
echo.
pause
