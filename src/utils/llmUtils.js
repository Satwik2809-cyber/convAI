/**
 * ConvAI — LLM Utilities
 * 
 * Shared helpers for robust LLM interactions:
 * - JSON repair (markdown stripping, brace extraction, trailing comma removal)
 * - Schema validation (ensures required fields and type constraints)
 * - Structured output parsing with LLM retry ("Repair" pattern)
 * - Chain-of-Thought extraction (strips <thinking> tags from responses)
 */

const logger = require('./logger');

// ─── JSON Repair ────────────────────────────────────────────────────────────

/**
 * Attempt to repair and parse a string that should be JSON.
 * Addresses common LLM quirks:
 * - Markdown code blocks (```json ... ```)
 * - Leading/trailing non-JSON text
 * - Unescaped control characters
 * - Trailing commas
 * - Single quotes instead of double quotes
 * 
 * @param {string} text - Raw string from LLM
 * @returns {object|null} - Parsed JSON or null if irreparable
 */
function repairJson(text) {
  if (!text) return null;

  let cleaned = text.trim();

  // 1. Remove Markdown code blocks
  // Matches ```json { ... } ``` or ``` { ... } ```
  cleaned = cleaned.replace(/^```(?:json)?\s*|\s*```$/gi, '');

  // 2. Find the first '{' and last '}'
  // This discards any conversational "preamble" or "postscript" the LLM might include
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // 3. Fallback: Try a more aggressive repair for common syntax errors
    try {
      const aggressiveClean = cleaned
        .replace(/,\s*([}\]])/g, '$1')   // Remove trailing commas
        .replace(/\\n/g, ' ')             // Flatten newlines
        .replace(/'/g, '"')               // Single quotes → double quotes
        .replace(/\s+/g, ' ');            // Normalize whitespace
      
      return JSON.parse(aggressiveClean);
    } catch (AggressiveError) {
      logger.error('🛠️ JSON repair failed', { error: AggressiveError.message, text: cleaned.slice(0, 100) });
      return null;
    }
  }
}

// ─── Schema Validation ──────────────────────────────────────────────────────

/**
 * Validate a parsed JSON object against a lightweight schema definition.
 * 
 * Schema format:
 * {
 *   fieldName: { type: 'string'|'number'|'boolean', required: true|false, default: <value> }
 * }
 * 
 * @param {object} data - The parsed JSON object
 * @param {object} schema - The schema definition
 * @returns {{ valid: boolean, data: object|null, errors: string[] }}
 */
function validateSchema(data, schema) {
  if (!data || typeof data !== 'object') {
    return { valid: false, data: null, errors: ['Input is not an object'] };
  }

  const errors = [];
  const result = { ...data };

  for (const [field, rules] of Object.entries(schema)) {
    const value = result[field];

    // Check required fields
    if (rules.required && (value === undefined || value === null)) {
      if (rules.default !== undefined) {
        result[field] = rules.default;
      } else {
        errors.push(`Missing required field: "${field}"`);
      }
      continue;
    }

    // Apply defaults for missing optional fields
    if ((value === undefined || value === null) && rules.default !== undefined) {
      result[field] = rules.default;
      continue;
    }

    // Type checking (if value is present)
    if (value !== undefined && value !== null && rules.type) {
      if (rules.type === 'number' && typeof value === 'string') {
        // Attempt numeric coercion for LLM quirks like "0.8" instead of 0.8
        const parsed = parseFloat(value);
        if (!isNaN(parsed)) {
          result[field] = parsed;
        } else {
          errors.push(`Field "${field}" should be ${rules.type}, got "${typeof value}"`);
        }
      } else if (typeof value !== rules.type) {
        errors.push(`Field "${field}" should be ${rules.type}, got "${typeof value}"`);
      }
    }

    // Enum validation
    if (value !== undefined && rules.enum && !rules.enum.includes(result[field])) {
      errors.push(`Field "${field}" must be one of [${rules.enum.join(', ')}], got "${result[field]}"`);
    }

    // Range validation for numbers
    if (typeof result[field] === 'number') {
      if (rules.min !== undefined && result[field] < rules.min) result[field] = rules.min;
      if (rules.max !== undefined && result[field] > rules.max) result[field] = rules.max;
    }
  }

  return {
    valid: errors.length === 0,
    data: result,
    errors,
  };
}

// ─── Structured Output Parser with LLM Retry ───────────────────────────────

/**
 * Parse structured output from an LLM response. If parsing or validation fails,
 * re-prompts the LLM with the error to attempt a "repair" (1 retry).
 * 
 * @param {string} rawResponse - The raw LLM text response
 * @param {object} schema - Schema definition for validation
 * @param {object} [options] - { retryFn: async (repairPrompt) => string, maxRetries: number }
 * @returns {Promise<{ success: boolean, data: object|null, errors: string[], retried: boolean }>}
 */
async function parseStructuredOutput(rawResponse, schema, options = {}) {
  const { retryFn = null, maxRetries = 1 } = options;

  // Attempt 1: Parse + Validate
  let parsed = repairJson(rawResponse);
  if (parsed) {
    const validation = validateSchema(parsed, schema);
    if (validation.valid) {
      return { success: true, data: validation.data, errors: [], retried: false };
    }

    // If we have data but it failed validation, try to use it with defaults applied
    if (validation.data && validation.errors.length > 0) {
      logger.warn('🛠️ Structured output had validation warnings, applying defaults', {
        errors: validation.errors,
      });
      // Re-validate after defaults were applied — if no hard errors remain, accept it
      const softErrors = validation.errors.filter(e => !e.startsWith('Missing required'));
      if (softErrors.length === 0) {
        return { success: true, data: validation.data, errors: validation.errors, retried: false };
      }
    }
  }

  // Attempt 2: LLM Retry (Repair Pattern)
  if (retryFn && maxRetries > 0) {
    logger.info('🛠️ Attempting LLM repair for malformed structured output');

    const repairPrompt = `Your previous response was not valid JSON or failed validation.
Raw response received: "${(rawResponse || '').substring(0, 300)}"
${parsed ? `Validation errors: ${JSON.stringify(validateSchema(parsed, schema).errors)}` : 'Could not parse as JSON at all.'}

Please respond ONLY with valid JSON matching this exact schema:
${JSON.stringify(
  Object.fromEntries(
    Object.entries(schema).map(([k, v]) => [k, `<${v.type}>${v.required ? ' (REQUIRED)' : ''}`])
  ),
  null,
  2
)}

Respond with ONLY the JSON object, no explanation or markdown.`;

    try {
      const retryResponse = await retryFn(repairPrompt);
      const retryParsed = repairJson(retryResponse);

      if (retryParsed) {
        const retryValidation = validateSchema(retryParsed, schema);
        if (retryValidation.valid || retryValidation.data) {
          logger.info('🛠️ LLM repair succeeded');
          return { success: true, data: retryValidation.data, errors: retryValidation.errors, retried: true };
        }
      }
    } catch (retryError) {
      logger.error('🛠️ LLM repair attempt failed', { error: retryError.message });
    }
  }

  // All attempts failed
  return {
    success: false,
    data: parsed ? validateSchema(parsed, schema).data : null,
    errors: parsed ? validateSchema(parsed, schema).errors : ['Failed to parse JSON from LLM response'],
    retried: !!retryFn,
  };
}

// ─── Chain-of-Thought Extraction ────────────────────────────────────────────

/**
 * Extract and strip <thinking>...</thinking> blocks from an LLM response.
 * 
 * The LLM is instructed to wrap its internal reasoning in <thinking> tags.
 * This function:
 * 1. Extracts the reasoning text for observability logging.
 * 2. Returns the cleaned response with <thinking> blocks removed.
 * 
 * @param {string} response - Raw LLM response
 * @returns {{ cleanResponse: string, reasoning: string|null }}
 */
function extractThinking(response) {
  if (!response) return { cleanResponse: '', reasoning: null };

  const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/gi;
  const matches = [];
  let match;

  while ((match = thinkingRegex.exec(response)) !== null) {
    matches.push(match[1].trim());
  }

  const reasoning = matches.length > 0 ? matches.join('\n') : null;
  const cleanResponse = response.replace(thinkingRegex, '').trim();

  return { cleanResponse, reasoning };
}

module.exports = {
  repairJson,
  validateSchema,
  parseStructuredOutput,
  extractThinking,
};
