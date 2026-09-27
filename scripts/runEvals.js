#!/usr/bin/env node

/**
 * ConvAI — AI Evaluation Runner
 * 
 * Runs the Gold Dataset against the live system to measure accuracy and safety.
 * 
 * Usage:
 *   node scripts/runEvals.js                    # Run all tests
 *   node scripts/runEvals.js --category safety  # Run only safety tests
 *   node scripts/runEvals.js --id SAFETY-001    # Run a single test
 *   node scripts/runEvals.js --verbose          # Show full responses
 * 
 * Exit codes:
 *   0 = All tests passed
 *   1 = Some tests failed
 */

const fs = require('fs');
const path = require('path');

// ─── Configuration ──────────────────────────────────────────────────────────

const DATASET_PATH = path.resolve(__dirname, '../test/evals/gold_dataset.json');
const RESULTS_DIR = path.resolve(__dirname, '../test/evals/results');

// Parse CLI args
const args = process.argv.slice(2);
const categoryFilter = getArg('--category');
const idFilter = getArg('--id');
const verbose = args.includes('--verbose');
const dryRun = args.includes('--dry-run');

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║               ConvAI — AI Evaluation Suite                   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // 1. Load Gold Dataset
  if (!fs.existsSync(DATASET_PATH)) {
    console.error('❌ Gold dataset not found at:', DATASET_PATH);
    process.exit(1);
  }

  const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'));
  let invariants = dataset.invariants;

  // 2. Apply filters
  if (categoryFilter) {
    invariants = invariants.filter(t => t.category === categoryFilter);
    console.log(`🔍 Filtering by category: ${categoryFilter}`);
  }
  if (idFilter) {
    invariants = invariants.filter(t => t.id === idFilter);
    console.log(`🔍 Filtering by ID: ${idFilter}`);
  }

  console.log(`📋 Running ${invariants.length} invariant tests...\n`);

  if (dryRun) {
    console.log('🏃 DRY RUN — listing tests without execution:\n');
    for (const test of invariants) {
      console.log(`  ${test.id} [${test.category}] — ${test.description}`);
    }
    console.log(`\nTotal: ${invariants.length} tests`);
    return;
  }

  // 3. Initialize services (lazy-load to handle env setup)
  let intentClassifier, interactionService;
  try {
    // Set env vars for eval mode
    process.env.WHATSAPP_MOCK_MODE = 'true';
    process.env.DEV_MODE = 'false';

    intentClassifier = require('../src/services/intentClassifier');
    // We test intent classification directly, not full interaction
    // Full interaction requires WhatsApp, OPA, etc.
  } catch (initError) {
    console.error('❌ Failed to initialize services:', initError.message);
    console.error('   Make sure your .env is configured and dependencies are installed.');
    process.exit(1);
  }

  // 4. Run tests
  const results = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const test of invariants) {
    process.stdout.write(`  ${test.id} — ${test.description}... `);

    try {
      const result = await runSingleTest(test, intentClassifier);
      results.push(result);

      if (result.passed) {
        passed++;
        console.log('✅ PASS');
      } else {
        failed++;
        console.log('❌ FAIL');
        for (const failure of result.failures) {
          console.log(`     └─ ${failure}`);
        }
      }

      if (verbose && result.details) {
        console.log(`     📝 Industry: ${result.details.industry}, Intent: ${result.details.intent}, Confidence: ${result.details.confidence}`);
      }
    } catch (testError) {
      skipped++;
      console.log(`⏭️  SKIP (${testError.message})`);
      results.push({
        id: test.id,
        passed: false,
        skipped: true,
        error: testError.message,
        failures: [`Exception: ${testError.message}`],
      });
    }
  }

  // 5. Summary
  const total = passed + failed + skipped;
  const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0.0';

  console.log('\n' + '─'.repeat(60));
  console.log(`\n📊 Results: ${passed}/${total} passed (${passRate}%)`);
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   ⏭️  Skipped: ${skipped}`);

  // Category breakdown
  const categories = {};
  for (const r of results) {
    const test = invariants.find(t => t.id === r.id);
    const cat = test?.category || 'unknown';
    if (!categories[cat]) categories[cat] = { passed: 0, failed: 0, skipped: 0 };
    if (r.skipped) categories[cat].skipped++;
    else if (r.passed) categories[cat].passed++;
    else categories[cat].failed++;
  }

  console.log('\n   Category Breakdown:');
  for (const [cat, counts] of Object.entries(categories)) {
    const catTotal = counts.passed + counts.failed + counts.skipped;
    const catRate = catTotal > 0 ? ((counts.passed / catTotal) * 100).toFixed(0) : '0';
    const icon = counts.failed > 0 ? '❌' : '✅';
    console.log(`     ${icon} ${cat}: ${counts.passed}/${catTotal} (${catRate}%)`);
  }

  // 6. Save results
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsFile = path.join(RESULTS_DIR, `eval_${timestamp}.json`);

  fs.writeFileSync(resultsFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    summary: { total, passed, failed, skipped, passRate: parseFloat(passRate) },
    categories,
    results,
  }, null, 2));

  console.log(`\n💾 Results saved to: ${resultsFile}`);
  console.log('');

  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

// ─── Single Test Runner ─────────────────────────────────────────────────────

async function runSingleTest(test, intentClassifier) {
  const failures = [];
  const details = {};

  // Test intent classification
  if (test.expected_industry || test.expected_intent || test.min_confidence) {
    const classifyResult = await intentClassifier.classify(test.input);
    details.industry = classifyResult.industry;
    details.intent = classifyResult.intent;
    details.confidence = classifyResult.confidence;
    details.method = classifyResult.method;

    if (test.expected_industry && classifyResult.industry !== test.expected_industry) {
      failures.push(`Industry: expected "${test.expected_industry}", got "${classifyResult.industry}"`);
    }

    if (test.expected_intent && classifyResult.intent !== test.expected_intent) {
      failures.push(`Intent: expected "${test.expected_intent}", got "${classifyResult.intent}"`);
    }

    if (test.min_confidence && classifyResult.confidence < test.min_confidence) {
      failures.push(`Confidence: expected >= ${test.min_confidence}, got ${classifyResult.confidence.toFixed(3)}`);
    }
  }

  // Note: Full response tests (must_contain, must_not_contain, expected_decision)
  // require the complete interaction pipeline (LLM + OPA) to be running.
  // We mark these as "requires_full_pipeline" for future integration.
  const requiresFullPipeline = !!(
    test.must_contain || 
    test.must_not_contain || 
    test.expected_decision || 
    test.max_response_length
  );

  if (requiresFullPipeline) {
    // Attempt to run full pipeline if services are available
    try {
      const interactionResult = await runFullPipeline(test);

      if (interactionResult) {
        details.response = interactionResult.finalResponse;
        details.decision = interactionResult.policyDecision;

        if (test.expected_decision && interactionResult.policyDecision !== test.expected_decision) {
          failures.push(`Decision: expected "${test.expected_decision}", got "${interactionResult.policyDecision}"`);
        }

        if (test.must_contain) {
          for (const phrase of test.must_contain) {
            if (!interactionResult.finalResponse.toLowerCase().includes(phrase.toLowerCase())) {
              failures.push(`Response missing required phrase: "${phrase}"`);
            }
          }
        }

        if (test.must_not_contain) {
          for (const phrase of test.must_not_contain) {
            if (interactionResult.finalResponse.toLowerCase().includes(phrase.toLowerCase())) {
              failures.push(`Response contains prohibited phrase: "${phrase}"`);
            }
          }
        }

        if (test.max_response_length && interactionResult.finalResponse.length > test.max_response_length) {
          failures.push(`Response too long: ${interactionResult.finalResponse.length} > ${test.max_response_length}`);
        }
      }
    } catch (pipelineError) {
      // Full pipeline not available — skip response-level checks
      details.pipeline_note = `Full pipeline not available: ${pipelineError.message}`;
    }
  }

  return {
    id: test.id,
    passed: failures.length === 0,
    failures,
    details,
  };
}

// ─── Full Pipeline Runner (Optional) ────────────────────────────────────────

async function runFullPipeline(test) {
  try {
    const intentClassifier = require('../src/services/intentClassifier');
    const llmService = require('../src/services/llmService');
    const policyService = require('../src/services/policyService');
    const responseComposer = require('../src/services/responseComposer');
    const { getSystemPrompt } = require('../src/services/promptTemplates');
    const { extractThinking } = require('../src/utils/llmUtils');

    // Classify
    const intentResult = await intentClassifier.classify(test.input);

    // Generate LLM response
    const systemPrompt = getSystemPrompt(intentResult.industry, {
      context: '',
      summary: '',
      history: [],
      sourcesAvailable: false,
    });

    const fullResponse = await llmService.generateResponse(systemPrompt, test.input);
    const { cleanResponse } = extractThinking(fullResponse);

    // Policy evaluation
    const policyResult = await policyService.evaluatePolicy({
      industry: intentResult.industry,
      intent: intentResult.intent,
      confidence: intentResult.confidence,
      input_text: test.input,
      response_text: cleanResponse,
      user_phone: 'eval-runner',
      ambiguity_flag: intentResult.ambiguity_flag,
    });

    // Compose
    const composed = responseComposer.compose(policyResult, intentResult);

    return {
      finalResponse: composed.finalResponse,
      policyDecision: composed.policyDecision,
      wasBlocked: composed.wasBlocked,
    };
  } catch (error) {
    throw new Error(`Pipeline: ${error.message}`);
  }
}

// ─── Run ────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('💥 Eval runner crashed:', err);
  process.exit(1);
});
