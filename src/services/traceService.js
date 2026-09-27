/**
 * ConvAI MVP — Trace Service
 * 
 * Creates TraceRecords for every interaction (aligns with ConvAI trace-first design).
 * Stores traces to local JSON files for auditability and replay.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../utils/config');
const logger = require('../utils/logger');

class TraceService {
  constructor() {
    this.traceDir = path.resolve(process.cwd(), config.logging.dir, 'traces');
    this._ensureTraceDir();
  }

  _ensureTraceDir() {
    if (!fs.existsSync(this.traceDir)) {
      fs.mkdirSync(this.traceDir, { recursive: true });
    }
  }

  /**
   * Create a complete trace record for an interaction.
   * 
   * @param {object} params
   * @param {string} params.from — User phone number
   * @param {string} params.messageId — WhatsApp message ID
   * @param {string} params.inputText — Raw user input
   * @param {object} params.intentResult — Intent classification result
   * @param {string} params.rawLlmResponse — Raw LLM response before policy
   * @param {object} params.policyResult — OPA policy evaluation result
   * @param {string} params.finalResponse — Final response sent to user
   * @param {boolean} params.wasBlocked — Whether the response was blocked
   * @param {number} params.totalLatencyMs — Total processing time
   * @param {number} params.score — The final score assigned to the interaction
   * @param {string} params.finalRationale — The final rationale for the policy decision
   * @returns {object} — The trace record
   */
  createTrace({
    from,
    messageId,
    inputText,
    intentResult,
    rawLlmResponse,
    policyResult,
    finalResponse,
    wasBlocked,
    totalLatencyMs,
    score,
    finalRationale,
    ragMetadata = {},
    sessionState = {},
    final_prompt = null,
    authContext = {},
    policyInputDebug = {},
  }) {
    const trace = {
      interaction_id: uuidv4(),
      timestamp: new Date().toISOString(),
      metadata: {
        version: '1.0.0',
        dev_mode: config.devMode,
        llm_provider: config.llm.provider,
        llm_model: config.llm[`${config.llm.provider}Model`] || 'unknown',
      },
      input: {
        from: this._maskPhone(from),
        message_id: messageId,
        raw_text: inputText,
      },
      intent: {
        industry: intentResult.industry,
        intent: intentResult.intent,
        confidence: intentResult.confidence,
        ambiguity_flag: intentResult.ambiguity_flag,
        method: intentResult.method,
        entities: intentResult.entities,
      },
      rag_metadata: ragMetadata,
      session_state: sessionState,
      auth_context: authContext,
      policy_input_debug: policyInputDebug,
      llm_response: {
        final_prompt: final_prompt,
        raw_text: rawLlmResponse,
        length: rawLlmResponse?.length || 0,
      },
      policy: {
        decision: policyResult.decision,
        reason: policyResult.reason,
        final_rationale: finalRationale,
        score: score,
        endpoint: policyResult.policy_endpoint,
        latency_ms: policyResult.latencyMs,
      },
      response: {
        final_text: finalResponse,
        was_blocked: wasBlocked,
      },
      performance: {
        total_latency_ms: totalLatencyMs,
      },
    };

    // Write trace to file asynchronously (non-blocking)
    this._writeTrace(trace);

    return trace;
  }

  /**
   * Write trace to a JSON file.
   */
  _writeTrace(trace) {
    const filename = `${trace.timestamp.replace(/[:.]/g, '-')}_${trace.interaction_id.substring(0, 8)}.json`;
    const filepath = path.join(this.traceDir, filename);

    fs.writeFile(filepath, JSON.stringify(trace, null, 2), (err) => {
      if (err) {
        logger.error('📋 Failed to write trace', { error: err.message, traceId: trace.interaction_id });
      } else {
        logger.debug('📋 Trace written', { traceId: trace.interaction_id, file: filename });
      }
    });
  }

  /**
   * Mask phone number for privacy in traces.
   * Shows only last 4 digits: +1234567890 → ***7890
   */
  _maskPhone(phone) {
    if (!phone || phone.length < 4) return '****';
    return '***' + phone.slice(-4);
  }

  /**
   * List recent traces (for admin endpoint).
   * @param {number} limit — Number of traces to return
   * @returns {Array} — List of trace summaries
   */
  listTraces(limit = 20) {
    try {
      const files = fs.readdirSync(this.traceDir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, limit);

      return files.map(file => {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(this.traceDir, file), 'utf-8'));
          return {
            interaction_id: content.interaction_id,
            timestamp: content.timestamp,
            industry: content.intent?.industry,
            intent: content.intent?.intent,
            decision: content.policy?.decision,
            latency_ms: content.performance?.total_latency_ms,
          };
        } catch {
          return { file, error: 'Failed to parse' };
        }
      });
    } catch (error) {
      logger.error('📋 Failed to list traces', { error: error.message });
      return [];
    }
  }

  /**
   * Get a specific trace by ID.
   * @param {string} traceId
   * @returns {object|null}
   */
  getTrace(traceId) {
    try {
      const files = fs.readdirSync(this.traceDir).filter(f => f.includes(traceId.substring(0, 8)));
      if (files.length === 0) return null;

      return JSON.parse(fs.readFileSync(path.join(this.traceDir, files[0]), 'utf-8'));
    } catch (error) {
      logger.error('📋 Failed to read trace', { traceId, error: error.message });
      return null;
    }
  }
}

module.exports = new TraceService();
