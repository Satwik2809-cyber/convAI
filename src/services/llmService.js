/**
 * ConvAI MVP — LLM Service (Pluggable)
 *
 * Factory pattern: creates the right LLM client based on LLM_PROVIDER env var.
 *
 * Providers:
 *   - groq     : Cloud free-tier (rate-limited) — ultra-fast, for POC deployment
 *   - openai   : Cloud paid — most reliable, for production
 *   - gemini   : Cloud free-tier — large context window
 *   - claude   : Anthropic Claude
 *   - fallback : Sequential fallback (OpenAI -> Gemini -> Claude)
 *
 * All providers implement: generateResponse(systemPrompt, userMessage, options)
 */

const config = require('../utils/config');
const logger = require('../utils/logger');
const axios = require('axios');

class LLMService {
  constructor() {
    this.provider = config.llm.provider;
    this.client = null;
    this._initClient();
  }

  /**
   * Initialize the appropriate LLM client based on the configured provider.
   */
  _initClient() {
    switch (this.provider) {
      case 'ollama':
        this._initOllama();
        break;
      case 'groq':
        this._initGroq();
        break;
      case 'openai':
        this._initOpenAI();
        break;
      case 'gemini':
        this._initGemini();
        break;
      case 'claude':
        this._initClaude();
        break;
      case 'fallback':
        // Fallback uses all clients
        this._initOpenAI();
        this._initGemini();
        this._initClaude();
        break;
      default:
        throw new Error(`Unsupported LLM provider: ${this.provider}`);
    }
    logger.info(`🤖 LLM Service initialized with provider: ${this.provider}`);
  }

  /**
   * Health check: test connectivity and return status.
   * Used by /health/full endpoint.
   */
  async healthCheck() {
    if (this.provider === 'ollama') {
      try {
        const ollamaUrl = config.llm.ollamaUrl || 'http://localhost:11434';
        const res = await axios.get(`${ollamaUrl}/api/tags`, { timeout: 3000 });
        const models = res.data?.models || [];
        const modelName = (config.llm.ollamaModel || 'llama3.2:1b').split(':')[0];
        const found = models.some(m => m.name.includes(modelName));
        return {
          status: res.status === 200 && found ? 'ok' : 'degraded',
          provider: 'ollama',
          model: config.llm.ollamaModel || 'llama3.2:1b',
          modelFound: found,
        };
      } catch (e) {
        return { status: 'error', provider: 'ollama', error: e.message };
      }
    }
    return { status: 'ok', provider: this.provider, note: 'cloud provider — no local check needed' };
  }

  _initOllama() {
    const OpenAI = require('openai');
    this.client = new OpenAI({
      baseURL: `${config.llm.ollamaUrl || 'http://localhost:11434'}/v1`,
      apiKey: 'ollama',
    });
    this.model = config.llm.ollamaModel || 'llama3.2:1b';
  }

  _initGroq() {
    const Groq = require('groq-sdk');
    this.client = new Groq({ apiKey: config.llm.groqApiKey });
    this.model = config.llm.groqModel;
  }

  _initOpenAI() {
    const OpenAI = require('openai');
    this.openaiClient = new OpenAI({ apiKey: config.llm.openaiApiKey });
    this.openaiModel = config.llm.openaiModel;
    if (this.provider === 'openai') {
        this.client = this.openaiClient;
        this.model = this.openaiModel;
    }
  }

  _initGemini() {
    this.geminiModel = config.llm.geminiModel;
    this.geminiApiKey = config.llm.geminiApiKey;
    if (this.provider === 'gemini') {
        this.model = this.geminiModel;
    }
  }

  _initClaude() {
    this.claudeModel = config.llm.claudeModel;
    this.claudeApiKey = config.llm.claudeApiKey;
    if (this.provider === 'claude') {
        this.model = this.claudeModel;
    }
  }

  /**
   * Generate a response from the LLM.
   * @param {string} systemPrompt — The system/instruction prompt
   * @param {string} userMessage — The user's message
   * @param {object} [options] — Optional overrides: { maxTokens, temperature }
   * @returns {string} — The LLM's text response
   */
  async generateResponse(systemPrompt, userMessage, options = {}) {
    const maxTokens = options.maxTokens || config.llm.maxTokens;
    const temperature = options.temperature ?? config.llm.temperature;
    const startTime = Date.now();

    try {
      let response;

      switch (this.provider) {
        case 'ollama':
        case 'groq':
        case 'openai':
          response = await this._chatCompletion(systemPrompt, userMessage, maxTokens, temperature);
          break;
        case 'gemini':
          response = await this._geminiCompletion(systemPrompt, userMessage, maxTokens, temperature);
          break;
        case 'claude':
          response = await this._claudeCompletion(systemPrompt, userMessage, maxTokens, temperature);
          break;
        case 'fallback':
          response = await this._fallbackCompletion(systemPrompt, userMessage, maxTokens, temperature);
          break;
        default:
          throw new Error(`Unsupported provider: ${this.provider}`);
      }

      const latencyMs = Date.now() - startTime;
      logger.info('🤖 LLM response generated', {
        provider: this.provider,
        latencyMs,
        responseLength: response.length,
      });

      return response;
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const rawCode = error.code || error.cause?.code || (error.response ? null : 'ERR_NETWORK');
      const isTimeout = rawCode === 'ETIMEDOUT' || rawCode === 'ECONNABORTED';

      let friendlyMessage = error.message;
      if (isTimeout) {
        friendlyMessage = `⚠️ LLM source timed out after ${latencyMs}ms. Please retry.`;
      }

      logger.error('🤖 LLM generation failed', {
        provider: this.provider, latencyMs, rawCode, error: friendlyMessage,
      });

      const friendlyError = new Error(friendlyMessage);
      friendlyError.code = rawCode;
      friendlyError.isLLMError = true;
      throw friendlyError;
    }
  }

  /**
   * Sequential fallback: OpenAI -> Gemini -> Claude
   */
  async _fallbackCompletion(systemPrompt, userMessage, maxTokens, temperature) {
    try {
      logger.info('🤖 Fallback: Attempting OpenAI...');
      const response = await this._chatCompletion(systemPrompt, userMessage, maxTokens, temperature, this.openaiClient, this.openaiModel);
      if (response) return response;
    } catch (e) {
      logger.warn(`🤖 Fallback: OpenAI failed (${e.message}). Trying Gemini...`);
    }

    try {
      logger.info('🤖 Fallback: Attempting Gemini...');
      const response = await this._geminiCompletion(systemPrompt, userMessage, maxTokens, temperature);
      if (response) return response;
    } catch (e) {
      logger.warn(`🤖 Fallback: Gemini failed (${e.message}). Trying Claude...`);
    }

    try {
      logger.info('🤖 Fallback: Attempting Claude...');
      const response = await this._claudeCompletion(systemPrompt, userMessage, maxTokens, temperature);
      if (response) return response;
    } catch (e) {
      logger.error(`🤖 Fallback: Claude failed (${e.message}). All fallback providers exhausted.`);
      throw new Error('All fallback LLM providers failed.');
    }
  }

  /**
   * OpenAI-compatible chat completion (works for both OpenAI and Groq SDKs).
   */
  async _chatCompletion(systemPrompt, userMessage, maxTokens, temperature, customClient = null, customModel = null) {
    const client = customClient || this.client;
    const model = customModel || this.model;

    const completion = await client.chat.completions.create({
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: maxTokens,
      temperature,
    });

    return completion.choices[0]?.message?.content || '';
  }

  /**
   * Google Gemini REST API completion.
   */
  async _geminiCompletion(systemPrompt, userMessage, maxTokens, temperature) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.geminiModel}:generateContent?key=${this.geminiApiKey}`;

    const response = await axios.post(url, {
      system_instruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        {
          parts: [{ text: userMessage }],
        },
      ],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature,
      },
    }, { timeout: 30000 });

    return response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  /**
   * Anthropic Claude REST API completion.
   */
  async _claudeCompletion(systemPrompt, userMessage, maxTokens, temperature) {
    const url = 'https://api.anthropic.com/v1/messages';

    const response = await axios.post(url, {
      model: this.claudeModel,
      max_tokens: maxTokens,
      temperature: temperature,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userMessage }
      ]
    }, {
      headers: {
        'x-api-key': this.claudeApiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      timeout: 30000
    });

    return response.data?.content?.[0]?.text || '';
  }
}

module.exports = new LLMService();
