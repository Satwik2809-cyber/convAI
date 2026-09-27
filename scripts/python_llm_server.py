"""
ConvAI — Optimized Python LLM Proxy Server
===============================================
Port: 11435

This Python server acts as an orchestrator and optimizer for local Ollama.
It accepts OpenAI-compatible completions requests and forwards them to
local Ollama (http://localhost:11434) with highly optimized parameters
for speed on CPU systems.

Features:
  - Smart fallback: If the main model (llama3.2:1b) fails or times out,
    it automatically falls back to tinyllama:latest (much faster).
  - CPU Optimization: Sets thread count, predict limits, and temperature
    to optimize speed and CPU usage.
  - Keeps the Node.js connection happy by responding within deadlines.

Usage:
  python scripts/python_llm_server.py
"""

import asyncio
import json
import logging
import sys
import time
from datetime import datetime
from aiohttp import web, ClientSession, ClientTimeout

# ── Logging Setup ─────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
log = logging.getLogger("llm-proxy")

OLLAMA_URL = "http://localhost:11434"
PORT = 11435

async def call_ollama(model: str, messages: list, max_tokens: int, temperature: float, timeout_secs: int) -> str | None:
    """
    Call Ollama API with optimized parameters for CPU execution.
    """
    url = f"{OLLAMA_URL}/v1/chat/completions"
    
    # CPU optimizations:
    # - Limit num_predict (max output tokens) to prevent runaway generations.
    # - We configure options to optimize performance.
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": False,
        "options": {
            "num_predict": max_tokens,
            "num_thread": 4,          # Optimize thread count for typical host CPU
            "low_vram": True,         # Save memory
            "num_ctx": 2048,          # Reasonable context size
        }
    }
    
    log.info(f"🔮 Forwarding to Ollama -> model: {model}, timeout: {timeout_secs}s")
    
    timeout = ClientTimeout(total=timeout_secs)
    try:
        async with ClientSession(timeout=timeout) as session:
            async with session.post(url, json=payload) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
                    if content and content.strip():
                        return content.strip()
                else:
                    log.warning(f"Ollama returned HTTP status {resp.status}")
    except asyncio.TimeoutError:
        log.warning(f"Ollama timed out after {timeout_secs}s on model {model}")
    except Exception as e:
        log.error(f"Error calling Ollama: {type(e).__name__}: {e}")
        
    return None

# ── HTTP Route Handlers ───────────────────────────────────────────────────

async def handle_chat_completions(request: web.Request) -> web.Response:
    try:
        data = await request.json()
        messages = [m for m in data.get("messages", []) if m.get("content")]
        requested_model = data.get("model", "llama3.2:1b")
        max_tokens = int(data.get("max_tokens", 600))
        temperature = float(data.get("temperature", 0.3))

        if not messages:
            return web.json_response({"error": "No messages provided"}, status=400)

        log.info(f"📨 Incoming request for model: {requested_model}")
        start_time = time.time()
        
        # ── Step 1: Attempt generation with the requested model ───────────
        # We give the main model 15 seconds. If it takes longer, we cut it off
        # to ensure we don't trigger the axios client timeout.
        response_text = await call_ollama(requested_model, messages, max_tokens, temperature, timeout_secs=15)
        
        # ── Step 2: Fallback to tinyllama if main model failed/timed out ───
        if not response_text and requested_model != "tinyllama:latest":
            log.warning(f"⚠️ Primary model {requested_model} failed/timed out. Falling back to tinyllama:latest...")
            response_text = await call_ollama("tinyllama:latest", messages, max_tokens, temperature, timeout_secs=15)

        if not response_text:
            raise RuntimeError("Both primary and fallback models failed to generate response.")

        elapsed = round((time.time() - start_time) * 1000)
        log.info(f"✅ Success! Generated in {elapsed}ms")

        return web.json_response({
            "id": f"chatcmpl-{datetime.now().strftime('%Y%m%d%H%M%S%f')}",
            "object": "chat.completion",
            "model": requested_model,
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": response_text
                    },
                    "finish_reason": "stop"
                }
            ],
            "usage": {
                "prompt_tokens": sum(len((m.get("content") or "").split()) for m in messages),
                "completion_tokens": len(response_text.split()),
                "total_tokens": len(response_text.split()) + sum(len((m.get("content") or "").split()) for m in messages)
            }
        })

    except Exception as e:
        log.error(f"❌ Proxy error: {type(e).__name__}: {e}")
        return web.json_response({"error": str(e), "choices": []}, status=500)


async def handle_tags(request: web.Request) -> web.Response:
    """Ollama-compatible /api/tags handler."""
    return web.json_response({
        "models": [
            {"name": "llama3.2:1b"},
            {"name": "tinyllama:latest"}
        ]
    })


async def handle_health(request: web.Request) -> web.Response:
    return web.json_response({"status": "ok", "proxy_to": OLLAMA_URL})


# ── Server Setup ───────────────────────────────────────────────────────────

def make_app() -> web.Application:
    app = web.Application()
    app.router.add_post("/v1/chat/completions", handle_chat_completions)
    app.router.add_get("/api/tags", handle_tags)
    app.router.add_get("/health", handle_health)
    return app


if __name__ == "__main__":
    log.info("=" * 60)
    log.info("  ConvAI — CPU-Optimized LLM Proxy Server")
    log.info(f"  Listening on: http://127.0.0.1:{PORT}")
    log.info(f"  Target Ollama URL: {OLLAMA_URL}")
    log.info("=" * 60)
    web.run_app(make_app(), host="127.0.0.1", port=PORT, access_log=None)
