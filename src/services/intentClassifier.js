/**
 * ConvAI MVP — Intent Classifier
 * 
 * Dual-strategy classification:
 * 1. Deterministic: keyword/regex matching (fast, zero cost)
 * 2. LLM-based: falls back to LLM for ambiguous input
 * 
 * Returns: { industry, intent, confidence, ambiguity_flag, entities }
 */

const path = require('path');
const fs = require('fs');
const config = require('../utils/config');
const logger = require('../utils/logger');

// Load intent patterns dynamically from data/config
const INTENT_PATTERNS_PATH = path.resolve(process.cwd(), 'data/config/intentPatterns.json');

class IntentClassifier {
  constructor() {
    this.allowedIndustries = config.industry.allowed;
    this.defaultIndustry = config.industry.default;
    this._loadPatterns();
  }

  /**
   * Load intent patterns from JSON file.
   */
  _loadPatterns() {
    try {
      if (fs.existsSync(INTENT_PATTERNS_PATH)) {
        this.patterns = JSON.parse(fs.readFileSync(INTENT_PATTERNS_PATH, 'utf-8'));
        logger.info('🎯 Intent patterns loaded from dynamic config');
      } else {
        logger.warn('🎯 Intent patterns JSON missing, falling back to empty patterns');
        this.patterns = {};
      }
    } catch (e) {
      logger.error('🎯 Failed to load intent patterns JSON', { error: e.message });
      this.patterns = {};
    }
  }

  /**
   * Classify user input to determine industry and intent.
   * @param {string} text — Raw user message text
   * @param {object} [context] — Optional session context (e.g., previous industry)
   * @returns {object} — { industry, intent, confidence, ambiguity_flag, entities, method }
   */
  async classify(text, context = {}) {
    const normalizedText = text.toLowerCase().trim();

    // Step 1: Try deterministic classification
    const deterministicResult = this._deterministicClassify(normalizedText);

    if (deterministicResult.confidence >= 0.7) {
      logger.info('🎯 Intent classified (deterministic)', deterministicResult);
      return { ...deterministicResult, method: 'deterministic' };
    }

    // Step 2: Fall back to LLM-based classification for ambiguous input
    try {
      const llmResult = await this._llmClassify(text, context);
      logger.info('🎯 Intent classified (LLM)', llmResult);
      return { ...llmResult, method: 'llm' };
    } catch (error) {
      logger.warn('🎯 LLM classification failed, using deterministic fallback', {
        error: error.message,
      });
      // Return deterministic result even if low confidence
      return { ...deterministicResult, method: 'deterministic_fallback' };
    }
  }

  /**
   * Deterministic intent classification using keyword matching.
   */
  _deterministicClassify(normalizedText) {
    let bestMatch = {
      industry: this.defaultIndustry,
      intent: 'general_query',
      confidence: 0.3,
      ambiguity_flag: true,
      entities: {},
    };

    let highestScore = 0;

    for (const industry of this.allowedIndustries) {
      const patterns = this.patterns[industry];
      if (!patterns) continue;

      for (const [intent, config] of Object.entries(patterns)) {
        if (intent === 'general_query') continue;

        const score = this._calculateMatchScore(normalizedText, config.keywords, config.priority);

        if (score > highestScore) {
          highestScore = score;
          bestMatch = {
            industry,
            intent,
            confidence: Math.min(score, 0.95), // Cap deterministic at 0.95
            ambiguity_flag: score < 0.7,
            entities: this._extractEntities(normalizedText, intent),
          };
        }
      }
    }

    return bestMatch;
  }

  /**
   * Calculate match score based on keyword hits and priority.
   * Scoring strategy:
   * - Any single keyword hit gets a strong base (0.55)
   * - Additional hits add incremental confidence
   * - Priority 0 (emergency) gets the highest bonus
   * - Cap at 0.95 (leave room for LLM-level certainty)
   */
  _calculateMatchScore(text, keywords, priority) {
    if (!keywords.length) return 0;

    let hits = 0;
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        hits++;
      }
    }

    if (hits === 0) return 0;

    // Base confidence for any match + bonus for additional matches
    const baseScore = 0.55;
    const multiMatchBonus = Math.min((hits - 1) * 0.1, 0.25);
    // Priority bonus (lower priority number = higher bonus)
    const priorityBonus = priority === 0 ? 0.3 : (priority === 1 ? 0.15 : 0.05);

    return Math.min(baseScore + multiMatchBonus + priorityBonus, 0.95);
  }

  /**
   * Extract simple entities from the text based on intent.
   */
  _extractEntities(text, intent) {
    const entities = {};

    // Extract grade/class numbers
    const gradeMatch = text.match(/(?:grade|class|standard)\s*(\d+)/i);
    if (gradeMatch) entities.grade = parseInt(gradeMatch[1], 10);

    // Extract day references
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    for (const day of days) {
      if (text.includes(day)) {
        entities.day = day;
        break;
      }
    }

    // Extract subject references
    const subjects = ['math', 'science', 'english', 'history', 'geography', 'physics', 'chemistry', 'biology'];
    for (const subject of subjects) {
      if (text.includes(subject)) {
        entities.subject = subject;
        break;
      }
    }

    return entities;
  }

  /**
   * LLM-based classification for ambiguous inputs.
   * Uses the LLM to determine industry and intent.
   * Implements the "Repair Pattern": if JSON parsing fails, re-prompts the LLM.
   */
  async _llmClassify(text, context) {
    // Lazy-load to avoid circular dependencies
    const llmService = require('./llmService');
    const { parseStructuredOutput } = require('../utils/llmUtils');

    const industriesSummary = Object.entries(this.patterns)
      .map(([ind, intents]) => `- ${ind}: ${Object.keys(intents).join(', ')}`)
      .join('\n');

    const systemPrompt = `You are an intent classifier for a governed AI platform. 
Classify the user message into EXACTLY one industry and one intent.

Available industries and their intents:
${industriesSummary}

Respond ONLY with valid JSON (no markdown, no explanation):
{"industry": "...", "intent": "...", "confidence": 0.0-1.0, "ambiguity_flag": true/false}

Rules:
- If genuinely ambiguous, set ambiguity_flag to true and confidence below 0.6.
- confidence should reflect how certain you are about the classification.`;

    const response = await llmService.generateResponse(systemPrompt, text, {
      maxTokens: 150,
      temperature: 0.1,
      fast: true, // Use the fast python g4f server
    });

    // Schema for intent classification output
    const intentSchema = {
      industry: { type: 'string', required: true, default: this.defaultIndustry },
      intent: { type: 'string', required: true, default: 'general_query' },
      confidence: { type: 'number', required: true, default: 0.5, min: 0, max: 1 },
      ambiguity_flag: { type: 'boolean', required: false, default: true },
    };

    // Parse with retry — if JSON is malformed, the LLM gets a second chance
    const result = await parseStructuredOutput(response, intentSchema, {
      retryFn: async (repairPrompt) => {
        return await llmService.generateResponse(
          'You are a JSON repair assistant. Fix the malformed JSON output.',
          repairPrompt,
          { maxTokens: 150, temperature: 0, fast: true }
        );
      },
    });

    if (result.success && result.data) {
      // Post-validation: ensure industry is in allowedIndustries
      if (!this.allowedIndustries.includes(result.data.industry)) {
        result.data.industry = this.defaultIndustry;
        result.data.confidence = Math.min(result.data.confidence, 0.5);
      }

      if (result.retried) {
        logger.info('🎯 Intent classified via LLM repair (retry succeeded)');
      }

      return {
        industry: result.data.industry,
        intent: result.data.intent,
        confidence: result.data.confidence,
        ambiguity_flag: result.data.ambiguity_flag !== false,
        entities: {},
      };
    }

    // All parsing attempts failed — graceful degradation
    logger.warn('🎯 Failed to parse LLM classification (repair exhausted)', {
      errors: result.errors,
    });
    return {
      industry: this.defaultIndustry,
      intent: 'general_query',
      confidence: 0.4,
      ambiguity_flag: true,
      entities: {},
    };
  }
}

module.exports = new IntentClassifier();
