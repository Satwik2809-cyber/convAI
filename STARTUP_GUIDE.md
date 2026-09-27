# ConvAI MVP — Startup Guide

> **Quick answer to the most common error:**
> `ECONNREFUSED 127.0.0.1:11434` → Ollama is not running. Run `ollama serve` first.

---

## Prerequisites

| Tool | Install | Check |
|------|---------|-------|
| Node.js ≥ 20 | [nodejs.org](https://nodejs.org) | `node --version` |
| Docker Desktop | [docker.com](https://www.docker.com) | `docker --version` |
| Ollama | [ollama.com](https://ollama.com) | `ollama --version` |

---

## ⚡ Quickstart (Windows — Recommended)

### Option A — PowerShell (auto-handles everything)
```powershell
# 1. Open PowerShell in the Conv-mvp folder
cd "C:\Users\Satwik\Documents\AI governace enterprise\Conv-mvp"

# 2. Run the safe startup script
.\start-dev.ps1
```
This script automatically:
- Checks if Ollama is running (starts it if not)
- Verifies the model is installed (pulls if missing)
- Starts Docker OPA + ChromaDB sidecars
- Starts the Node.js backend with `npm run dev`

### Option B — Batch File
```cmd
cd "C:\Users\Satwik\Documents\AI governace enterprise\Conv-mvp"
start-dev.bat
```

---

## 🔧 Manual Startup (Step-by-Step)

### Step 1 — Start Ollama
```powershell
# Start the Ollama inference server
ollama serve
```
> Leave this terminal open. Ollama listens on `http://localhost:11434`.

### Step 2 — Verify / pull the model
```powershell
# Check installed models
ollama list

# Pull llama3.2:1b if not listed (1.3 GB download)
ollama pull llama3.2:1b
```

### Step 3 — Start Docker services (OPA + ChromaDB)
```powershell
cd "C:\Users\Satwik\Documents\AI governace enterprise\Conv-mvp"
docker compose up -d opa chromadb
```
> The `app` and `client` services are optional if running locally.

### Step 4 — Run Ollama pre-flight check
```powershell
npm run check:ollama
```
Expected output:
```
✅ Connected
✅ Model llama3.2:1b found (1.32 GB)
✅ All checks passed — Ollama is ready.
```

### Step 5 — Start the backend
```powershell
npm run dev
# OR safe-start (runs pre-flight automatically):
npm run start:safe
```

### Step 6 — Open the frontend
Open `client/index.html` directly in your browser, or if using Docker:
```
http://localhost:4000
```

---

## 🏥 Health Check

Once the backend is running, verify all services:

```powershell
# Quick CLI check
npm run health:check

# Or via browser / curl
curl http://localhost:3000/health/full
```

Expected response:
```json
{
  "backend": "ok",
  "ollama":  "ok",
  "opa":     "ok",
  "chroma":  "ok"
}
```

The frontend also shows a **live health bar** at the top of the chat — green pills = healthy, red pills = problem.

---

## 🐳 Full Docker Mode

```powershell
# Make sure Ollama is running on HOST first (not inside Docker)
ollama serve

# Then start all services
docker compose up -d

# Access
# Frontend : http://localhost:4000
# Backend  : http://localhost:3000
# Health   : http://localhost:3000/health/full
```

> **Docker + Ollama note:** The backend container connects to Ollama via
> `host.docker.internal:11434` (set in `docker-compose.yml`). Ollama must
> run on your **host machine**, not inside Docker.

---

## 🧪 Running Education Role Tests

```powershell
# Run all teacher + parent tests
npm run test:education

# Teacher only
npm run test:education:teacher

# Parent only
npm run test:education:parent
```

**Teacher prompts tested:**
- Show students with low attendance
- Generate health risk summary
- Which students need counseling?
- Summarize recent academic concerns

**Parent prompts tested:**
- How is my child performing?
- Show attendance summary
- Any health concerns?
- Generate progress report

---

## 🔍 Troubleshooting

### `ECONNREFUSED 127.0.0.1:11434`
Ollama is not running.
```powershell
ollama serve          # start the server
ollama list           # verify model is present
ollama pull llama3.2:1b  # pull if missing
```

### `[DEV MODE DIAGNOSTIC] 🔴 LLM SERVICE UNAVAILABLE`
Same as above — Ollama stopped after the backend started. Restart Ollama,
then the backend will reconnect on the next request (no restart needed).

### `401 Unauthorized`
API key mismatch. Ensure `ADMIN_API_KEY=admin123` in `.env` matches what
the frontend sends (check `client/config.js`).

### OPA / ChromaDB not healthy
```powershell
docker compose up -d opa chromadb
docker compose ps     # check container status
docker compose logs opa
```

### Model slow on first request
The model loads into RAM on first use. Wait 15–30 seconds. Subsequent
requests are fast. Keep `ollama serve` running between sessions.

---

## 📁 Key Files Modified (This Session)

| File | Change |
|------|--------|
| `src/services/llmService.js` | Axios v1.x error-code fix (`ERR_NETWORK` detection) |
| `src/services/interactionService.js` | Structured DEV MODE DIAGNOSTIC block |
| `src/routes/admin.js` | Typed error response (`error_type` field) |
| `client/script.js` | Rich error cards + health poller |
| `client/index.html` | Service health bar |
| `client/style.css` | Error card + health pill CSS |
| `scripts/checkOllama.js` | Pre-flight validator (NEW) |
| `start-dev.ps1` | PowerShell startup script (NEW) |
| `start-dev.bat` | Windows batch startup script (NEW) |
| `package.json` | Added `check:ollama`, `start:safe`, `health:check` |
