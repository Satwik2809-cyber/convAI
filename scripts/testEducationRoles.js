#!/usr/bin/env node
/**
 * ConvAI MVP — Education Role Test Script
 *
 * Runs automated test prompts for Teacher and Parent roles
 * against the local backend (/admin/test-message).
 *
 * Usage:
 *   node scripts/testEducationRoles.js
 *   node scripts/testEducationRoles.js --role teacher
 *   node scripts/testEducationRoles.js --role parent
 */

const http = require('http');

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const API_KEY = process.env.ADMIN_API_KEY || 'admin123';

// ── Test Prompts ─────────────────────────────────────────────────────────────

const TEACHER_ACTOR = 'Siya Lata'; // Must match a name in your knowledge data

const TEACHER_PROMPTS = [
  'Show students with low attendance',
  'Generate health risk summary',
  'Which students need counseling?',
  'Summarize recent academic concerns',
];

const PARENT_ACTOR = 'Samiha Rastogi'; // Must match a parent name in your knowledge data

const PARENT_PROMPTS = [
  'How is my child performing?',
  'Show attendance summary',
  'Any health concerns?',
  'Generate progress report',
];

const ADMIN_ACTOR = 'Dr. Sharma'; // Example admin

const ADMIN_PROMPTS = [
  'Show attendance and health trends across students',
];

// ── HTTP Helper ──────────────────────────────────────────────────────────────

function postMessage(text, from, role) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text, from, role });
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/admin/test-message',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': API_KEY,
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy(new Error('Request timed out after 120s — Ollama may be loading the model'));
    });

    req.write(body);
    req.end();
  });
}

// ── Test Runner ──────────────────────────────────────────────────────────────

async function runTests(role, actor, prompts) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  🎭 ROLE: ${role.toUpperCase()}  (actor: "${actor}")`);
  console.log(`${'═'.repeat(60)}\n`);

  let passed = 0;
  let failed = 0;

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    process.stdout.write(`  [${i + 1}/${prompts.length}] "${prompt}" ... `);

    try {
      const result = await postMessage(prompt, actor, role);

      if (result.status === 401) {
        console.log('❌ FAIL (401 Unauthorized — check ADMIN_API_KEY)');
        failed++;
        continue;
      }

      if (result.status !== 200 || !result.body.success) {
        console.log(`❌ FAIL (HTTP ${result.status}: ${result.body.error || 'unknown error'})`);
        failed++;
        continue;
      }

      const trace = result.body.trace;
      const decision = trace?.policy?.decision || 'UNKNOWN';
      const text = trace?.response?.final_text || '(empty)';
      const latency = trace?.performance?.total_latency_ms || 0;

      console.log(`✅ PASS [${decision}] ${latency}ms`);
      console.log(`     → ${text.slice(0, 120).replace(/\n/g, ' ')}${text.length > 120 ? '...' : ''}`);
      passed++;
    } catch (err) {
      console.log(`❌ ERROR: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
  return { passed, failed };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const roleIndex = process.argv.indexOf('--role');
  const roleArg = process.argv.find(a => a.startsWith('--role='))?.split('=')[1]
    || (roleIndex !== -1 ? process.argv[roleIndex + 1] : null);

  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║   ConvAI MVP — Education Role Automated Tests             ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log(`\n  Backend : ${BACKEND_URL}`);
  console.log(`  API Key : ${API_KEY.substring(0, 4)}****\n`);

  // Pre-check: is backend alive?
  try {
    await postMessage('ping', 'system');
  } catch (err) {
    console.error(`\n❌ Cannot reach backend at ${BACKEND_URL}`);
    console.error('   Make sure the backend is running: npm run dev');
    process.exit(1);
  }

  let totalPassed = 0;
  let totalFailed = 0;

  if (!roleArg || roleArg === 'teacher') {
    const r = await runTests('teacher', TEACHER_ACTOR, TEACHER_PROMPTS);
    totalPassed += r.passed;
    totalFailed += r.failed;
  }

  if (!roleArg || roleArg === 'parent') {
    const r = await runTests('parent', PARENT_ACTOR, PARENT_PROMPTS);
    totalPassed += r.passed;
    totalFailed += r.failed;
  }

  if (!roleArg || roleArg === 'admin') {
    const r = await runTests('admin', ADMIN_ACTOR, ADMIN_PROMPTS);
    totalPassed += r.passed;
    totalFailed += r.failed;
  }

  console.log(`${'═'.repeat(60)}`);
  console.log(`  TOTAL: ${totalPassed} passed, ${totalFailed} failed`);
  console.log(`${'═'.repeat(60)}\n`);

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
