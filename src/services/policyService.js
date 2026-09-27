/**
 * ConvAI MVP — OPA Policy Service
 *
 * Queries OPA REST API for policy decisions on LLM responses.
 * Fail behaviour:
 *   - Production (NODE_ENV=production): fail-closed (BLOCK on OPA error)
 *   - Development (NODE_ENV=development): fail-open  (ALLOW on OPA error)
 * Supports per-industry policy evaluation including grievance.
 */

const axios = require('axios');
const config = require('../utils/config');
const logger = require('../utils/logger');

// In dev mode allow responses even when OPA is down
const FAIL_OPEN_IN_DEV = config.isDev;

class PolicyService {
  constructor() {
    this.opaUrl = config.opa.url;
    this.basePath = config.opa.policyPath;
    this.timeoutMs = config.opa.timeoutMs;
  }

  /**
   * Push relationship data to OPA for internal lookup.
   * 
   * @param {Array} records - The raw CSV/Excel records.
   */
  async syncRelationshipData(dataset) {
    const dataEndpoint = `${this.opaUrl}/v1/data/conversalx/relationships`;
    
    try {
      const relationships = {
        actors: {}
      };

      const students = dataset.Students || [];
      const parents = dataset.Parents || [];
      const teachers = dataset.Teachers || [];
      const admins = dataset.Admins || [];
      const mappings = dataset.Mappings || [];

      // 1. Sync Students
      students.forEach(s => {
        relationships.actors[s.StudentName] = { 
          type: 'student', 
          studentId: s.StudentId, 
          relations: { has_student: [s.StudentName] } 
        };
      });

      // 2. Sync Parents
      parents.forEach(p => {
        const student = students.find(s => s.StudentId === p.StudentId);
        if (student) {
          if (!relationships.actors[p.ParentName]) {
            relationships.actors[p.ParentName] = { type: 'parent', relations: { has_student: [] } };
          }
          relationships.actors[p.ParentName].relations.has_student.push(student.StudentName);
        }
      });

      // 3. Sync Teachers
      teachers.forEach(t => {
        if (!relationships.actors[t.TeacherName]) {
          relationships.actors[t.TeacherName] = { type: 'teacher', relations: { has_student: [] } };
        }
        const studentIds = mappings.filter(m => m.TeacherId === t.TeacherId).map(m => m.StudentId);
        studentIds.forEach(sid => {
          const student = students.find(s => s.StudentId === sid);
          if (student) {
            relationships.actors[t.TeacherName].relations.has_student.push(student.StudentName);
          }
        });
      });

      // 4. Sync Admins
      admins.forEach(a => {
        if (!relationships.actors[a.Name]) {
          relationships.actors[a.Name] = { type: 'admin', relations: { has_student: [] } };
        }
        mappings.forEach(m => {
          if (m.AdminIds && m.AdminIds.split(',').includes(a.AdminId)) {
            const student = students.find(s => s.StudentId === m.StudentId);
            if (student) {
              relationships.actors[a.Name].relations.has_student.push(student.StudentName);
            }
          }
        });
      });

      await axios.put(dataEndpoint, relationships, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000 // Increased timeout for large dataset
      });

      logger.info('🛡️ Relationship data synced to OPA', { actorCount: Object.keys(relationships.actors).length });
    } catch (error) {
      logger.error('🛡️ Failed to sync relationship data to OPA', { error: error.message });
    }
  }

  /**
   * Evaluate user input safety before processing.
   * 
   * @param {string} text — The raw user input
   * @returns {object} — { decision, reason }
   */
  async evaluateInput(text) {
    const policyEndpoint = `${this.opaUrl}/v1/data/conversalx/input`;
    const startTime = Date.now();

    try {
      const response = await axios.post(
        policyEndpoint,
        { input: { text } },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000, // Increased timeout for evaluation
        }
      );

      const latencyMs = Date.now() - startTime;
      const result = response.data?.result || {};

      logger.info('🛡️ Input policy evaluation complete', {
        decision: result.decision,
        latencyMs,
      });

      return {
        decision: result.decision || 'ALLOW',
        reason: result.reason || 'No specific reason provided',
        latencyMs,
      };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      if (FAIL_OPEN_IN_DEV) {
        logger.warn('🛡️ OPA input evaluation failed — FAIL OPEN (dev mode)', { error: error.message });
        return { decision: 'ALLOW', reason: 'OPA unavailable — dev mode fail-open', latencyMs };
      }
      logger.error('🛡️ OPA input evaluation failed — FAIL CLOSED', { error: error.message });
      return {
        decision: 'DENY',
        reason: `Input policy engine unavailable (${error.message})`,
        latencyMs,
      };
    }
  }

  /**
   * Evaluate a policy against the OPA engine.
   * 
   * @param {object} policyInput — The input to evaluate
   * @param {string} policyInput.industry — "education"
   * @param {string} policyInput.intent — The classified intent
   * @param {number} policyInput.confidence — Classification confidence (0-1)
   * @param {string} policyInput.response_text — The raw LLM response to evaluate
   * @param {string} policyInput.user_phone — The user's phone number
   * @param {boolean} policyInput.ambiguity_flag — Whether intent was ambiguous
   * @returns {object} — { decision, reason, original_text, redacted_text? }
   */
  async evaluatePolicy(policyInput) {
    const { industry } = policyInput;
    const policyEndpoint = `${this.opaUrl}${this.basePath}/${industry}`;

    const startTime = Date.now();

    try {
      const response = await axios.post(
        policyEndpoint,
        { input: policyInput },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000, // Increased timeout for evaluation
        }
      );

      const latencyMs = Date.now() - startTime;
      const result = response.data?.result || {};

      const decision = {
        decision: result.decision || 'BLOCK',
        reason: result.reason || 'No policy decision returned — default BLOCK',
        conditions: result.conditions || [],
        rationale_code: result.rationale_code || null,
        original_text: policyInput.response_text,
        policy_endpoint: policyEndpoint,
        latencyMs,
      };

      // If redacted, generate a safe version
      if (decision.decision === 'REDACT') {
        decision.redacted_text = this._redactResponse(policyInput.response_text, industry);
      }

      logger.info('🛡️ Policy evaluation complete', {
        industry,
        intent: policyInput.intent,
        confidence: policyInput.confidence,
        decision: decision.decision,
        latencyMs,
      });

      return decision;
    } catch (error) {
      const latencyMs = Date.now() - startTime;

      if (FAIL_OPEN_IN_DEV) {
        logger.warn('🛡️ OPA evaluation failed — FAIL OPEN (dev mode). Proceeding.', {
          endpoint: policyEndpoint, latencyMs, error: error.message,
        });
        return {
          decision: 'PROCEED',
          reason: 'OPA unavailable — dev mode fail-open. Response allowed.',
          conditions: [],
          rationale_code: 'DEV_FAIL_OPEN',
          original_text: policyInput.response_text,
          policy_endpoint: policyEndpoint,
          latencyMs,
        };
      }

      // FAIL-CLOSED in production
      logger.error('🛡️ OPA evaluation failed — FAIL CLOSED (blocking)', {
        endpoint: policyEndpoint, latencyMs, error: error.message,
      });
      return {
        decision: 'BLOCK',
        reason: `Policy engine unavailable (${error.message}). Response blocked for safety.`,
        original_text: policyInput.response_text,
        policy_endpoint: policyEndpoint,
        latencyMs,
      };
    }
  }

  /**
   * Add safety disclaimers to a redacted response.
   */
  _redactResponse(text, industry) {
    const disclaimers = {
      education: '\n\n⚠️ Note: This response has not been fully verified. Please confirm with your institution for accurate information.',
    };

    return text + (disclaimers[industry] || '\n\n⚠️ This response requires additional verification.');
  }

  /**
   * Health check: verify OPA is reachable.
   */
  async healthCheck() {
    try {
      const response = await axios.get(`${this.opaUrl}/health`, {
        timeout: 2000,
      });
      return { healthy: true, status: response.status };
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  }
}

module.exports = new PolicyService();
