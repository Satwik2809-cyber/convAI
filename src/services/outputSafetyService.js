/**
 * ConvAI MVP — Output Safety Service
 *
 * MECHANICAL post-generation safety scan.
 * This service does NOT evaluate role permissions — that is OPA's job.
 * It only blocks content that is STRUCTURALLY dangerous regardless of role:
 *   - Harmful instructions (weapons, hacking)
 *   - Financial advice
 *   - Exposed phone numbers or SSNs (unless OPA explicitly allowed via conditions)
 *
 * The `opaConditions` array from the Policy Engine determines PII exemptions.
 */

const logger = require('../utils/logger');

class OutputSafetyService {
  /**
   * Scans LLM response text for safety violations.
   *
   * @param {string} responseText - The generated text from the LLM.
   * @param {object} context - { userRole, actorId, targetActorId, intent, opaConditions }
   * @returns {{ decision: 'ALLOW'|'BLOCK', reason: string|null }}
   */
  evaluateResponse(responseText, context) {
    if (!responseText) {
      return { decision: 'ALLOW', reason: null };
    }

    const { actorId, intent, opaConditions = [] } = context;
    const lowerText = responseText.toLowerCase();

    // ── 1. Harmful Content (always blocked, no exemptions) ──────────────────
    if (lowerText.includes('how to hack') || lowerText.includes('make a weapon')) {
      logger.warn('🛡️ Output Safety: Blocked harmful content', { actorId, intent });
      return { decision: 'BLOCK', reason: 'Response blocked: contains restricted or harmful content.' };
    }

    // ── 2. Financial Advice (always blocked in education context) ─────────
    if (lowerText.includes('invest in') || lowerText.includes('buy stocks')) {
      logger.warn('🛡️ Output Safety: Blocked financial advice', { actorId, intent });
      return { decision: 'BLOCK', reason: 'Response blocked: financial advice is out of scope.' };
    }

    // ── 3. Diagnosis / Treatment Recommendations (blocked per doctrine) ────
    // OPA conditions: admin cannot receive diagnosis or treatment recs
    const isDiagnosis = /\b(you (have|likely have|might have)|diagnosis is|diagnosed with|i recommend taking|prescribe)\b/i.test(responseText);
    if (isDiagnosis && !opaConditions.includes('allow_clinical_language') && !opaConditions.includes('own_child_data_allowed')) {
      logger.warn('🛡️ Output Safety: Blocked diagnostic language', { actorId, intent });
      return { decision: 'BLOCK', reason: 'Response blocked: clinical diagnosis or treatment recommendations are prohibited.' };
    }

    // ── 4. PII Scan (phone numbers, SSNs) ────────────────────────────────
    // OPA grants access via rationale codes like OWN_CHILD_DATA_ALLOWED or ADMIN_TREND_ACCESS_ALLOWED
    // The conditions array carries exemptions from OPA — we trust them.
    const hasSSN = /\d{3}-\d{2}-\d{4}/.test(responseText);
    const hasPhone = /\b\d{10,}\b/.test(responseText);

    const piiExempt =
      opaConditions.includes('own_child_data_allowed') ||
      opaConditions.includes('admin_full_access') ||
      opaConditions.includes('admin_trend_access_allowed') ||
      opaConditions.includes('teacher_restricted_data_allowed') ||
      opaConditions.includes('no_pii_restriction');

    if ((hasSSN || hasPhone) && !piiExempt) {
      logger.warn('🛡️ Output Safety: Blocked unauthorized PII in response', { actorId, intent });
      return { decision: 'BLOCK', reason: 'Response blocked: output contains personal identifiers without OPA authorization.' };
    }

    return { decision: 'ALLOW', reason: null };
  }
}

module.exports = new OutputSafetyService();
