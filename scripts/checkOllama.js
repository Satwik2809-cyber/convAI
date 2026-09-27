#!/usr/bin/env node
/**
 * ConvAI MVP — Ollama Pre-flight Check
 *
 * Verifies Ollama is running and the required model is available
 * before the backend starts. Exits with code 1 on failure.
 *
 * Usage:
 *   node scripts/checkOllama.js
 *   node scripts/checkOllama.js --no-fail   # warn only, don't exit
 */

const http = require('http');
require('dotenv').config();

const OLLAMA_URL  = process.env.OLLAMA_URL  || 'http://localhost:11434';
const MODEL_NAME  = process.env.OLLAMA_MODEL || 'llama3.2:1b';
const NO_FAIL     = process.argv.includes('--no-fail');
const MAX_RETRIES = 5;

// ── Helpers ─────────────────────────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 4000 }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fail(msg) {
  console.error('\n╔══════════════════════════════════════════════════════════╗');
  console.error('║  ❌  OLLAMA PRE-FLIGHT CHECK FAILED                      ║');
  console.error('╚══════════════════════════════════════════════════════════╝');
  console.error(`\n  ${msg}\n`);
  if (!NO_FAIL) process.exit(1);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   ConvAI MVP — Ollama Pre-flight Check                   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`\n  Ollama URL : ${OLLAMA_URL}`);
  console.log(`  Model     : ${MODEL_NAME}\n`);

  // ── Step 1: Connectivity with retries ────────────────────────────────────
  let connected = false;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    process.stdout.write(`  [${attempt}/${MAX_RETRIES}] Checking Ollama connectivity... `);
    try {
      const res = await get(`${OLLAMA_URL}/api/tags`);
      if (res.status === 200) {
        console.log('✅ Connected');
        connected = true;

        // ── Step 2: Model presence ─────────────────────────────────────────
        const models = res.body?.models || [];
        const found  = models.some(m => m.name.includes(MODEL_NAME.split(':')[0]));

        console.log(`\n  Model check: ${MODEL_NAME}`);
        if (found) {
          const match = models.find(m => m.name.includes(MODEL_NAME.split(':')[0]));
          const sizeGB = match?.size ? (match.size / 1e9).toFixed(2) + ' GB' : 'unknown size';
          console.log(`  ✅ Model found: ${match?.name} (${sizeGB})`);
        } else {
          const available = models.map(m => m.name).join(', ') || '(none)';
          fail(
            `Model "${MODEL_NAME}" is NOT installed in Ollama.\n\n` +
            `  Fix: ollama pull ${MODEL_NAME}\n\n` +
            `  Available models: ${available}`
          );
          return;
        }
        break;
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      const isLast = attempt === MAX_RETRIES;
      if (isLast) {
        console.log('❌');
        fail(
          `Cannot reach Ollama at ${OLLAMA_URL} after ${MAX_RETRIES} attempts.\n\n` +
          `  Error   : ${err.message}\n\n` +
          `  Fix 1   : Run "ollama serve" in a separate terminal\n` +
          `  Fix 2   : Verify OLLAMA_URL in your .env file\n` +
          `  Fix 3   : If running in Docker, OLLAMA_URL must be\n` +
          `            http://host.docker.internal:11434 (not localhost)`
        );
        return;
      }
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      console.log(`⏳ Retrying in ${delay / 1000}s...`);
      await sleep(delay);
    }
  }

  if (connected) {
    console.log('\n  ✅ All checks passed — Ollama is ready.\n');
  }
}

main().catch(err => {
  console.error('Fatal error in pre-flight check:', err.message);
  if (!NO_FAIL) process.exit(1);
});
