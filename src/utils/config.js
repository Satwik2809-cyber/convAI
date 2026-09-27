/**
 * ConvAI MVP — Centralized Configuration
 * 
 * Loads and validates all environment variables at startup.
 * Exports a frozen (immutable) config object.
 * Follows fail-fast: crashes if required vars are missing.
 */

require('dotenv').config();

const REQUIRED_VARS = [
  'PORT',
  'WHATSAPP_VERIFY_TOKEN',
  'LLM_PROVIDER',
  'OPA_URL',
  'ADMIN_API_KEY',
];

// Only require provider-specific keys when that provider is selected
const PROVIDER_REQUIRED_VARS = {
  groq: ['GROQ_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY'],
  claude: ['CLAUDE_API_KEY'],
  fallback: ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'CLAUDE_API_KEY'],
};

function validateConfig() {
  const missing = [];

  for (const key of REQUIRED_VARS) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  const provider = process.env.LLM_PROVIDER || 'groq';
  const providerVars = PROVIDER_REQUIRED_VARS[provider] || [];
  for (const key of providerVars) {
    if (!process.env[key]) {
      missing.push(`${key} (required for provider: ${provider})`);
    }
  }

  // In mock mode, WhatsApp tokens aren't required
  if (process.env.WHATSAPP_MOCK_MODE !== 'true') {
    if (!process.env.WHATSAPP_ACCESS_TOKEN) missing.push('WHATSAPP_ACCESS_TOKEN');
    if (!process.env.WHATSAPP_PHONE_NUMBER_ID) missing.push('WHATSAPP_PHONE_NUMBER_ID');
  }

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(v => console.error(`   - ${v}`));
    console.error('\nCopy .env.example to .env and fill in your values.');
    process.exit(1);
  }
}

validateConfig();

const config = Object.freeze({
  // Server
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',
  devMode: process.env.DEV_MODE === 'true',

  // WhatsApp
  whatsapp: Object.freeze({
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
    mockMode: process.env.WHATSAPP_MOCK_MODE === 'true',
  }),

  // Telegram
  telegram: Object.freeze({
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    mockMode: process.env.TELEGRAM_MOCK_MODE === 'true',
  }),

  // LLM
  llm: Object.freeze({
    provider: process.env.LLM_PROVIDER || 'groq',
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2:1b',
    groqApiKey: process.env.GROQ_API_KEY || '',
    groqModel: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    claudeApiKey: process.env.CLAUDE_API_KEY || '',
    claudeModel: process.env.CLAUDE_MODEL || 'claude-3-haiku-20240307',
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS, 10) || 500,
    temperature: parseFloat(process.env.LLM_TEMPERATURE) || 0.3,
  }),

  // OPA
  opa: Object.freeze({
    url: process.env.OPA_URL || 'http://localhost:8181',
    policyPath: process.env.OPA_POLICY_PATH || '/v1/data/conversalx',
    timeoutMs: parseInt(process.env.OPA_TIMEOUT_MS, 10) || 2000,
  }),

  // Industry
  industry: Object.freeze({
    default: process.env.DEFAULT_INDUSTRY || 'education',
    allowed: (process.env.ALLOWED_INDUSTRIES || 'education').split(',').map(s => s.trim()),
  }),

  // Admin
  admin: Object.freeze({
    apiKey: process.env.ADMIN_API_KEY,
  }),

  // Logging
  logging: Object.freeze({
    level: process.env.LOG_LEVEL || 'debug',
    dir: process.env.LOG_DIR || 'logs',
  }),

  // RAG
  knowledgeDir: process.env.KNOWLEDGE_DIR || 'data/knowledge',
  chromaUrl: process.env.CHROMA_URL || 'http://localhost:8000',
  embeddingModel: process.env.EMBEDDING_MODEL || 'all-MiniLM-L6-v2',
  ragCacheTtlMin: parseInt(process.env.RAG_CACHE_TTL_MIN, 10) || 10,
  ragRelevanceThreshold: parseFloat(process.env.RAG_RELEVANCE_THRESHOLD) || 1.2,

  // Session & Token Management
  sessionCompactionTurns: parseInt(process.env.SESSION_COMPACTION_TURNS, 10) || 5,
  sessionIdleCompactionMs: parseInt(process.env.SESSION_IDLE_COMPACTION_MS, 10) || 120000,
  compactionModel: process.env.COMPACTION_MODEL || 'llama-3.1-8b-instant',

  // Retention
  retentionDays: Math.min(Math.max(parseInt(process.env.RETENTION_DAYS, 10) || 7, 1), 30),
});

module.exports = config;
