# ===========================================================================
#  ConvAI MVP — PowerShell Local Dev Startup
#  Run: .\start-dev.ps1
# ===========================================================================

$ErrorActionPreference = 'Stop'

function Write-Banner($msg) {
    Write-Host "`n  $msg" -ForegroundColor Cyan
}
function Write-Ok($msg)   { Write-Host "  ✅ $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  ⚠️  $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  ❌ $msg" -ForegroundColor Red }
function Write-Step($n, $total, $msg) {
    Write-Host "`n  [$n/$total] $msg" -ForegroundColor White
}

Write-Host ""
Write-Host "  ====================================================" -ForegroundColor Cyan
Write-Host "  |   ConvAI MVP - PowerShell Dev Startup            |" -ForegroundColor Cyan
Write-Host "  ====================================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Check Ollama ──────────────────────────────────────────────────
Write-Step 1 5 "Checking Ollama connectivity..."
$ollamaRunning = $false
try {
    $r = Invoke-WebRequest -Uri 'http://localhost:11434/api/tags' -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    if ($r.StatusCode -eq 200) {
        Write-Ok "Ollama is running on port 11434"
        $ollamaRunning = $true
    }
} catch {
    Write-Warn "Ollama not running - starting it now..."
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Minimized
    Write-Host "  ⏳ Waiting 6 seconds for Ollama to start..." -ForegroundColor DarkGray
    Start-Sleep -Seconds 6
    # Recheck
    try {
        $r = Invoke-WebRequest -Uri 'http://localhost:11434/api/tags' -UseBasicParsing -TimeoutSec 4
        if ($r.StatusCode -eq 200) {
            Write-Ok "Ollama started successfully"
            $ollamaRunning = $true
        }
    } catch {
        Write-Err "Could not start Ollama. Please run 'ollama serve' manually."
        Write-Host ""
        Read-Host "Press Enter to exit"
        exit 1
    }
}

# ── Step 2: Verify model ──────────────────────────────────────────────────
Write-Step 2 5 "Checking model: llama3.2:1b"
$modelList = ollama list 2>&1
if ($modelList -match "llama3.2") {
    Write-Ok "Model llama3.2:1b is available"
} else {
    Write-Warn "Model llama3.2:1b not found. Pulling now (may take several minutes)..."
    ollama pull llama3.2:1b
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Failed to pull model. Check your internet connection."
        exit 1
    }
    Write-Ok "Model pulled successfully"
}

# ── Step 3: Pre-flight check ──────────────────────────────────────────────
Write-Step 3 5 "Running Ollama pre-flight validation..."
node scripts/checkOllama.js --no-fail
if ($LASTEXITCODE -ne 0) {
    Write-Warn "Pre-flight had warnings but continuing..."
}

# ── Step 4: Docker services ───────────────────────────────────────────────
Write-Step 4 5 "Checking Docker services (OPA + ChromaDB)..."
try {
    $dockerRunning = (docker ps --filter "name=conversalx-opa" --format "{{.Names}}" 2>&1)
    if ($dockerRunning -match "conversalx-opa") {
        Write-Ok "Docker services already running"
    } else {
        Write-Warn "Docker services not running. Starting with docker compose..."
        docker compose up -d opa chromadb
        Start-Sleep -Seconds 3
        Write-Ok "Docker services started (OPA + ChromaDB)"
    }
} catch {
    Write-Warn "Docker not available or not running - skipping OPA/ChromaDB start"
    Write-Host "  - OPA URL  : http://localhost:8181" -ForegroundColor DarkGray
    Write-Host "  - Chroma   : http://localhost:8000" -ForegroundColor DarkGray
}

# ── Step 5: Start backend ─────────────────────────────────────────────────
Write-Step 5 5 "Starting ConvAI backend..."
Write-Host ""
Write-Host "  +-------------------------------------------------+" -ForegroundColor DarkGray
Write-Host "  |  Backend  ->  http://localhost:3000             |" -ForegroundColor DarkGray
Write-Host "  |  Health   ->  http://localhost:3000/health/full |" -ForegroundColor DarkGray
Write-Host "  |  Frontend ->  open client/index.html            |" -ForegroundColor DarkGray
Write-Host "  +-------------------------------------------------+" -ForegroundColor DarkGray
Write-Host ""

npm run dev
