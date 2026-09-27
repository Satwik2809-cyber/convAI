/**
 * ConvAI MVP — Admin Routes
 * 
 * Dev-mode management and trace inspection endpoints.
 * Protected by API key (ADMIN_API_KEY).
 */

const express = require('express');
const router = express.Router();
const config = require('../utils/config');
const logger = require('../utils/logger');
const traceService = require('../services/traceService');
const interactionService = require('../services/interactionService');
const policyService = require('../services/policyService');
const dataIngestionService = require('../services/dataIngestionService');

/**
 * Admin API key authentication middleware.
 */
function adminAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;

  if (!apiKey || apiKey !== config.admin.apiKey) {
    logger.warn('🔑 Admin auth failed', { ip: req.ip });
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
  }

  next();
}

// Apply auth to all admin routes
router.use(adminAuth);

/**
 * GET /admin/traces — List recent trace records.
 */
router.get('/traces', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const traces = traceService.listTraces(limit);
  res.json({ count: traces.length, traces });
});

/**
 * GET /admin/traces/:id — Get a specific trace by interaction ID.
 */
router.get('/traces/:id', (req, res) => {
  const trace = traceService.getTrace(req.params.id);

  if (!trace) {
    return res.status(404).json({ error: 'Trace not found' });
  }

  res.json(trace);
});

/**
 * POST /admin/dev-mode — Toggle dev mode on/off at runtime.
 * Body: { "enabled": true/false }
 */
router.post('/dev-mode', (req, res) => {
  const { enabled } = req.body;

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'Body must contain { "enabled": true/false }' });
  }

  interactionService.setDevMode(enabled);
  res.json({ dev_mode: enabled, message: `Dev mode ${enabled ? 'ENABLED' : 'DISABLED'}` });
});

/**
 * GET /admin/config — View current configuration (sanitized — no secrets).
 */
router.get('/config', (req, res) => {
  res.json({
    server: {
      port: config.port,
      node_env: config.nodeEnv,
      dev_mode: interactionService.isDevMode(),
    },
    whatsapp: {
      mock_mode: config.whatsapp.mockMode,
      api_version: config.whatsapp.apiVersion,
      phone_number_id: config.whatsapp.phoneNumberId ? '***configured***' : '***missing***',
    },
    llm: {
      provider: config.llm.provider,
      model: config.llm[`${config.llm.provider}Model`] || 'unknown',
      max_tokens: config.llm.maxTokens,
      temperature: config.llm.temperature,
    },
    opa: {
      url: config.opa.url,
      policy_path: config.opa.policyPath,
      timeout_ms: config.opa.timeoutMs,
    },
    industry: {
      default: config.industry.default,
      allowed: config.industry.allowed,
    },
  });
});

/**
 * GET /admin/health — Detailed health check including OPA status.
 */
router.get('/health', async (req, res) => {
  const opaHealth = await policyService.healthCheck();

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      app: { status: 'healthy' },
      opa: opaHealth,
      llm: { provider: config.llm.provider, status: 'configured' },
      whatsapp: { mock_mode: config.whatsapp.mockMode, status: 'configured' },
    },
  });
});

/**
 * POST /admin/test-message — Simulate processing a message (without WhatsApp).
 * Useful for testing the full pipeline without a real WhatsApp connection.
 * Body: { "text": "What are the admission requirements?", "from": "+1234567890" }
 */
router.post('/test-message', async (req, res) => {
  const { text, from = '+0000000000', role, sessionId } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'Body must contain { "text": "..." }' });
  }

  try {
    const trace = await interactionService.processMessage(from, text, 'test-' + Date.now(), 'web', role, sessionId);
    res.json({
      success: true,
      trace: {
        interaction_id: trace.interaction_id,
        intent: trace.intent,
        policy: trace.policy,
        response: trace.response,
        performance: trace.performance,
        llm_response: trace.llm_response,
      },
    });
  } catch (error) {
    const rawCode = error.code || error.cause?.code || '';
    const isConnRefused = rawCode === 'ECONNREFUSED' || rawCode === 'ERR_NETWORK';
    const isTimeout     = rawCode === 'ETIMEDOUT' || rawCode === 'ECONNABORTED';

    let errorType = 'server_error';
    let userMessage = error.message;

    if (isConnRefused) {
      errorType = 'ollama_unavailable';
      userMessage =
        'Ollama LLM service is not running. ' +
        'Run "ollama serve" on your host machine, then retry.';
    } else if (isTimeout) {
      errorType = 'ollama_timeout';
      userMessage = 'Ollama timed out. The model may still be loading — please wait and retry.';
    } else if (error.isLLMError) {
      errorType = 'llm_error';
    }

    logger.error('Admin test-message failed', {
      error: error.message,
      code: rawCode,
      errorType,
    });

    res.status(500).json({
      success: false,
      error_type: errorType,
      error: userMessage,
    });
  }
});

/**
 * POST /admin/ingest-data — Ingest raw unstructured or semi-structured data,
 * map it using the LLM, merge into the JSON dataset, and automatically reload relationships.
 * Body: { "rawData": "..." }
 */
router.post('/ingest-data', async (req, res) => {
  const { rawData } = req.body;

  if (!rawData || typeof rawData !== 'string') {
    return res.status(400).json({ error: 'Body must contain { "rawData": "..." } with unstructured text data.' });
  }

  try {
    const result = await dataIngestionService.ingestData(rawData);
    res.json(result);
  } catch (error) {
    logger.error('Failed to ingest data', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
