/**
 * ConvAI MVP — Application Entry Point
 * 
 * Express server with security middleware, route registration,
 * health check, and graceful shutdown.
 */

const config = require('./utils/config');
const logger = require('./utils/logger');
const whatsappService = require('./services/whatsappService');
const retentionWorker = require('./utils/retentionWorker');
const knowledgeService = require('./services/knowledgeService');
const ragService = require('./services/ragService');

const dataQueryService = require('./services/dataQueryService');

// Start backend workers
retentionWorker.start();

// Pre-warm DataQueryService (loads dataset into memory for fast responses)
dataQueryService.ensureLoaded().then(() => {
    logger.info('✅ DataQueryService pre-warmed and ready.');
}).catch(err => {
    logger.error('❌ DataQueryService pre-warm failed', { error: err.message });
});

// Start Knowledge Watcher for Dynamic Updates
knowledgeService.initWatcher((industry) => {
    ragService.sync(industry).catch(err => {
        logger.error(`❌ Background knowledge sync failed for ${industry}`, { error: err.message });
    });
});

const express = require('express');
const path = require('path');
const axios = require('axios');
const helmet = require('helmet');
const cors = require('cors');

const webhookRoutes = require('./routes/webhook');
const telegramRoutes = require('./routes/telegram');
const adminRoutes = require('./routes/admin');
const chatRoutes = require('./routes/chat');
const llmService = require('./services/llmService');
const policyService = require('./services/policyService');

const app = express();

// ── Security & CORS Middleware ──────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline scripts for client
}));
app.use(cors({
  origin: '*',
  methods: '*',
  allowedHeaders: '*'
}));

// ── Serve Client Static Files ────────────────────────────────────────────
const clientDir = path.join(__dirname, '..', 'client');
app.use('/client', express.static(clientDir));

// Redirect root to client UI
app.get('/', (req, res) => res.redirect('/client/index.html'));

// ── Body Parsing ─────────────────────────────────────────────────────────
app.use(express.json());

// ── Request Logging ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    // Don't log health checks to reduce noise
    if (req.path !== '/health') {
      logger.debug(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
});

// ── Routes ───────────────────────────────────────────────────────────────

// Health check — basic (public)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    uptime: process.uptime(),
  });
});

// Health check — full (public): checks all dependent services
app.get('/health/full', async (req, res) => {
  const start = Date.now();

  const [ollamaHealth, opaHealth, chromaHealth] = await Promise.all([
    // Ollama
    llmService.healthCheck().catch(e => ({ status: 'error', error: e.message })),
    // OPA
    policyService.healthCheck().catch(e => ({ status: 'error', error: e.message })),
    // ChromaDB
    axios.get(`${config.chromaUrl}/api/v1/heartbeat`, { timeout: 2000 })
      .then(() => ({ status: 'ok', url: config.chromaUrl }))
      .catch(e => ({ status: 'error', url: config.chromaUrl, error: e.message })),
  ]);

  const overallOk =
    ollamaHealth.status === 'ok' &&
    opaHealth.healthy === true &&
    chromaHealth.status === 'ok';

  res.status(overallOk ? 200 : 207).json({
    backend: 'ok',
    ollama: ollamaHealth.status === 'ok' ? 'ok' : ollamaHealth.status,
    opa: opaHealth.healthy ? 'ok' : 'error',
    chroma: chromaHealth.status,
    details: {
      ollama: ollamaHealth,
      opa: opaHealth,
      chroma: chromaHealth,
    },
    timestamp: new Date().toISOString(),
    latencyMs: Date.now() - start,
  });
});

// WhatsApp webhook
app.use('/webhook', webhookRoutes);

// Telegram webhook
app.use('/telegram', telegramRoutes);

// Web UI chat endpoint
app.use('/api/chat', chatRoutes);

// Admin endpoints (protected by API key)
app.use('/admin', adminRoutes);

// ── 404 Handler ──────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Error Handler ────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start Server ─────────────────────────────────────────────────────────
const server = app.listen(config.port, () => {
  logger.info('🚀 ConvAI MVP started', {
    port: config.port,
    env: config.nodeEnv,
    devMode: config.devMode,
    llmProvider: config.llm.provider,
    whatsappMock: config.whatsapp.mockMode,
    opaUrl: config.opa.url,
  });

  logger.info('📝 Endpoints:');
  logger.info(`   Health:   http://localhost:${config.port}/health`);
  logger.info(`   Webhook:  http://localhost:${config.port}/webhook`);
  logger.info(`   Admin:    http://localhost:${config.port}/admin/*`);
  logger.info(`   Test:     POST http://localhost:${config.port}/admin/test-message`);
});

// ── Graceful Shutdown ───────────────────────────────────────────────────
function shutdown(signal) {
  logger.info(`${signal} received. Shutting down gracefully...`);
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
