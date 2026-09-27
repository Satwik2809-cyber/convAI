/**
 * ConvAI MVP — Interaction Service (Core Orchestrator)
 * 
 * Implements the ConvAI governed flow:
 * Input → Intent Classification → Context → OPA Policy (Pre) → Decision → LLM → OPA Policy (Post) → Compose → Send
 * 
 * strictly adhering to the Architecture Doctrine.
 */

const config = require('../utils/config');
const logger = require('../utils/logger');
const intentClassifier = require('./intentClassifier');
const llmService = require('./llmService');
const policyService = require('./policyService');
const responseComposer = require('./responseComposer');
const traceService = require('./traceService');
const whatsappService = require('./whatsappService');
const { getSystemPrompt, getFallbackResponse } = require('./promptTemplates');
const ragService = require('./ragService');
const sessionService = require('./sessionService');
const { extractThinking } = require('../utils/llmUtils');

const authService = require('./authService');
const relationshipService = require('./relationshipService');
const telegramService = require('./telegramService');
const identityService = require('./identityService');
const outputSafetyService = require('./outputSafetyService');

// Runtime dev-mode toggle (can be changed via admin API)
let devModeEnabled = config.devMode;

class InteractionService {
  /**
   * Helper to send response via the correct channel.
   */
  async _respond(channel, recipient, text) {
    if (channel === 'telegram') {
      return await telegramService.sendTextMessage(recipient, text);
    }
    // Default to WhatsApp
    return await whatsappService.sendTextMessage(recipient, text);
  }

  /**
   * Process an incoming message through the governed flow.
   */
  async processMessage(from, text, messageId, channel = 'whatsapp', requestedRole = null, sessionId = null) {
    const startTime = Date.now();

    logger.info('🔄 Processing interaction', { channel, from: from.slice(-4), messageLength: text.length });

    // Ensure relationship data is loaded
    await relationshipService.ensureDataLoaded();

    try {
      // ── Step 1: Input Adapter ─────────────────────────────────
      const sessionKey = sessionId ? `${from}_${sessionId}` : from;
      const session = await sessionService.getOrCreateSession(sessionKey);

      if (requestedRole) {
        session.userRole = requestedRole.toLowerCase();
        // Pre-verify the session for administrative test calls
        identityService.ensureIdentityState(session);
        session.identity.state = 'VERIFIED';
        session.identity.name = from; // Use the 'from' actor as verified identity
        session.identity.role = requestedRole.toLowerCase();
        
        // Auto-set the target child for relationship mapping in test context
        if (requestedRole.toLowerCase() === 'teacher') {
          session.currentTargetStudent = 'Saksham Kashyap';
        } else if (requestedRole.toLowerCase() === 'parent') {
          session.currentTargetStudent = 'Saksham Kashyap';
        }
      }

      const trimmedText = text.trim();
      let commandIntent = null;
      let newRole = null;

      // Extract Role Switching Commands
      if (trimmedText.toLowerCase().startsWith('/role ')) {
        newRole = trimmedText.split(' ')[1].toLowerCase();
        commandIntent = 'switch_role';
      } else {
        const roleMatch = trimmedText.match(/(?:i am|this is|switch to|acting as)(?: a| an| the)?\s+(parent|teacher|principal|medical admin|school admin|admin)/i);
        if (roleMatch) {
          newRole = roleMatch[1].toLowerCase().replace(' ', '_');
          commandIntent = 'switch_role';
        }
      }

      // ── Step 2: Intent Interpreter ─────────────────────────────
      let intentResult;
      if (text === '__INIT__' || session.identity.state !== 'VERIFIED') {
        intentResult = { industry: 'unknown', intent: 'identity_verification', confidence: 1 };
      } else if (commandIntent === 'switch_role') {
        intentResult = { industry: 'system', intent: commandIntent, confidence: 1, ambiguity_flag: false, target_role: newRole };
      } else {
        intentResult = await intentClassifier.classify(text);
      }
      logger.info('🔄 Step 2 complete: Intent classified', { industry: intentResult.industry, intent: intentResult.intent });

      // ── Identity & Verification ─────────────────────────────────
      // If session is brand-new (NONE) and no pre-set role — auto-trigger the greeting
      identityService.ensureIdentityState(session);

      const isAutoVerified = !!requestedRole; // dev/admin bypass

      if (!isAutoVerified) {
        // Fresh session → trigger greeting automatically
        if (session.identity.state === 'NONE') {
          intentResult = { industry: 'unknown', intent: 'identity_verification', confidence: 1 };
        } else if (session.identity.state !== 'VERIFIED') {
          // Mid-flow: still collecting name / student name
          intentResult = { industry: 'unknown', intent: 'identity_verification', confidence: 1 };
        } else if (
          intentResult.intent !== 'switch_role' &&
          identityService.requiresVerification(intentResult.intent) &&
          !identityService.isVerified(session)
        ) {
          intentResult = { industry: 'unknown', intent: 'identity_verification', confidence: 1 };
        }
      }

      // Scope Drift Detection
      if (session.currentIndustry && session.currentIndustry !== intentResult.industry && intentResult.intent !== 'identity_verification' && intentResult.intent !== 'switch_role') {
        logger.info('🔄 Scope drift detected', { from: session.currentIndustry, to: intentResult.industry });
        await this._respond(channel, from, `I notice we've moved from discussing ${session.currentIndustry} to ${intentResult.industry}. Should we switch our focus to that now? (I'll proceed with your request, but let me know if you want to clear our previous context! 🔄)`);
      }

      // ── Step 3: Context Assembler ─────────────────────────────────
      const actorId = (session.identity && session.identity.state === 'VERIFIED') ? session.identity.name : from;
      const actorInfo = relationshipService.getActorInfo(actorId);
      const userRelationships = actorInfo ? relationshipService.getRelationships(actorId) : null;

      let effectiveUserRole = actorInfo ? actorInfo.role : 'guest';
      if (!actorInfo && session.userRole) {
        effectiveUserRole = session.userRole;
      }
      if (actorInfo && !session.userRole) {
        session.userRole = actorInfo.type;
      }
      
      const roleForPolicy = requestedRole ? requestedRole.toLowerCase() : (session.userRole || effectiveUserRole);

      let targetActorId = null;
      let targetActorType = null;
      
      if (userRelationships || ['admin', 'principal', 'school_admin', 'medical_admin'].includes(roleForPolicy)) {
          // Search ALL students for mention so OPA can properly block unauthorized access
          const allStudents = Array.from(relationshipService.actorMap.values())
                                  .filter(a => a.type === 'student')
                                  .map(a => a.id);

          const lowerText = text.toLowerCase();
          
          // Basic Levenshtein distance helper for fuzzy matching names
          const getDist = (a, b) => {
              if (a.length === 0) return b.length; if (b.length === 0) return a.length;
              const m = []; for (let i = 0; i <= b.length; i++) m[i] = [i];
              for (let j = 0; j <= a.length; j++) m[0][j] = j;
              for (let i = 1; i <= b.length; i++) {
                  for (let j = 1; j <= a.length; j++) {
                      m[i][j] = b.charAt(i - 1) === a.charAt(j - 1) ? m[i - 1][j - 1] : Math.min(m[i - 1][j - 1] + 1, Math.min(m[i][j - 1] + 1, m[i - 1][j] + 1));
                  }
              }
              return m[b.length][a.length];
          };

          for (const target of allStudents) {
              const targetLower = target.toLowerCase();
              if (lowerText.includes(targetLower)) {
                  targetActorId = target; targetActorType = 'student'; break;
              }
              const firstName = targetLower.split(' ')[0];
              const genericWords = ['student', 'teacher', 'parent', 'admin', 'class', 'school', 'name', 'health'];
              if (firstName.length > 2 && !genericWords.includes(firstName) && lowerText.includes(firstName)) {
                  targetActorId = target; targetActorType = 'student'; break;
              }
              // Fuzzy match on full string if text length is close to target (e.g. user just typed the name with a typo)
              if (Math.abs(lowerText.length - targetLower.length) <= 3 && getDist(lowerText, targetLower) <= 3) {
                  targetActorId = target; targetActorType = 'student'; break;
              }
          }
          
          // If no explicitly named child, detect pronouns to fallback to current target
          if (!targetActorId && roleForPolicy === 'parent') {
              const pronouns = ['my child', 'my son', 'my daughter', 'his', 'her', 'their health', 'my kid', 'my boy', 'my girl'];
              const hasPronoun = pronouns.some(p => lowerText.includes(p));
              if (hasPronoun || intentResult.intent !== 'general_query') {
                  if (session.currentTargetStudent) {
                      targetActorId = session.currentTargetStudent;
                      targetActorType = 'student';
                  } else if (userRelationships['HAS_CHILD'] && userRelationships['HAS_CHILD'].length === 1) {
                      targetActorId = userRelationships['HAS_CHILD'][0];
                      targetActorType = 'student';
                      session.currentTargetStudent = targetActorId;
                  }
              }
          }
      }

      // Explicitly mentioned target overrides previous session target
      if (targetActorId && roleForPolicy === 'parent' && userRelationships['HAS_CHILD'] && userRelationships['HAS_CHILD'].includes(targetActorId)) {
          session.currentTargetStudent = targetActorId;
      }

      const studentToQuery = targetActorId || session.currentTargetStudent;
      const effectiveTargetType = studentToQuery ? 'student' : targetActorType;
      
      let context = null, rawContext = null, sourcesAvailable = false;
      let ragMetadata = { context_length: 0, sources_found: false };
      // NOTE: RAG (Context Assembler) is called AFTER OPA in Step 6, once conditions are known.

      // ── Step 4: Policy Engine (Pre-Action / Intent Authorization) ──
      // OPA is evaluated BEFORE any data is fetched. This is the governance gate.
      let inputPolicy = await policyService.evaluateInput(text);
      let policyResult = { decision: 'PROCEED', reason: 'System intent bypass', conditions: [] };

      const policyInput = {
        industry: intentResult.industry === 'unknown' ? (session.currentIndustry || config.industry.default) : intentResult.industry,
        intent: intentResult.intent,
        confidence: intentResult.confidence,
        input_text: text,
        response_text: '', // Pre-action — no response yet
        user_phone: from,
        actor_id: actorId,
        user_role: roleForPolicy,
        target_role: intentResult.target_role,
        target_actor_id: studentToQuery,
        target_actor_type: effectiveTargetType,
        ambiguity_flag: intentResult.ambiguity_flag,
      };

      if (intentResult.industry !== 'system' && intentResult.intent !== 'identity_verification') {
        if (inputPolicy.decision === 'DENY') {
          policyResult = {
            decision: 'BLOCK',
            reason: `Safety Violation: ${inputPolicy.reason}`,
            conditions: [],
            original_text: ''
          };
        } else {
          policyResult = await policyService.evaluatePolicy(policyInput);
        }
      }

      // Extract OPA-issued conditions — these drive the Context Assembler and Safety layer
      const opaConditions = policyResult.conditions || [];

      logger.info('🔄 Step 4 complete: Pre-Action Policy evaluated', { decision: policyResult.decision, conditions: opaConditions });

      // ── Step 5: Decision Engine ───────────────────────────────────
      // Map Policy Result to exactly one deterministic action
      let decisionObject = { action: 'GENERATE_LLM' };
      
      if (intentResult.intent === 'identity_verification') {
        decisionObject.action = 'VERIFY_IDENTITY';
      } else if (policyResult.decision === 'BLOCK' || policyResult.decision === 'DENY') {
        decisionObject.action = 'BLOCK_RESPONSE';
      } else if (intentResult.intent === 'switch_role') {
        decisionObject.action = 'SWITCH_ROLE';
      }

      // ── Step 6: Action Orchestrator ───────────────────────────────
      let rawLlmResponse = "";
      let reasoning = null;
      let systemPromptUsed = '';

      if (decisionObject.action === 'VERIFY_IDENTITY') {
        rawLlmResponse = identityService.handleVerification(text, session);
      } else if (decisionObject.action === 'SWITCH_ROLE') {
        const targetRole = intentResult.target_role;
        const oldRole = session.userRole;
        session.userRole = targetRole;
        identityService.switchRole(session, targetRole);
        session.history = [];
        session.summary = '';
        session.compactedSummary = '';
        if (oldRole === 'parent' && targetRole === 'parent') {
            rawLlmResponse = `Parent identity updated. Previous verification cleared. Please verify student access again.`;
        } else {
            rawLlmResponse = `✅ Role switched to: ${targetRole}. Previous conversation context cleared. How can I help you today?`;
        }
      } else if (decisionObject.action === 'BLOCK_RESPONSE') {
        rawLlmResponse = policyResult.reason || 'Your request has been blocked due to policy restrictions.';
      } else if (decisionObject.action === 'GENERATE_LLM') {
        // ── Step 6a: Context Assembler — called AFTER OPA with OPA conditions ──
        // RAG receives conditions from OPA, not raw role strings. It executes mechanically.
        const ragResponse = await ragService.getRelevantContext(
          text, intentResult.industry, actorId, studentToQuery, opaConditions, roleForPolicy, session.currentTargetStudent || null
        );
        context = ragResponse.context;
        rawContext = ragResponse.rawContext;
        sourcesAvailable = ragResponse.sourcesAvailable;
        ragMetadata = { context_length: context?.length || 0, sources_found: sourcesAvailable };

        try {
          systemPromptUsed = getSystemPrompt(intentResult.industry, {
            context,
            summary: session.summary,
            history: [...session.history, { role: 'user', content: text }],
            sourcesAvailable,
            userRole: roleForPolicy,
            actorId,
            opaConditions,
          });
          const fullLlmResponse = await llmService.generateResponse(systemPromptUsed, text);

          // Extract Chain-of-Thought
          const cotResult = extractThinking(fullLlmResponse);
          rawLlmResponse = cotResult.cleanResponse;
          reasoning = cotResult.reasoning;

          if (reasoning) {
            logger.debug('🧠 LLM Reasoning (CoT)', { reasoning: reasoning.substring(0, 500) });
          }
        } catch (llmError) {
          const rawCode = llmError.code || llmError.cause?.code || '';
          logger.error('🔄 LLM generation failed, using fallback', { error: llmError.message, code: rawCode });
          rawLlmResponse = getFallbackResponse(intentResult.industry);

          if (devModeEnabled) {
            const isConnRefused = rawCode === 'ECONNREFUSED' || rawCode === 'ERR_NETWORK';
            const isTimeout = rawCode === 'ETIMEDOUT' || rawCode === 'ECONNABORTED';
            let devErrorHeader;
            if (isConnRefused) devErrorHeader = `🔴 LLM SERVICE UNAVAILABLE`;
            else if (isTimeout) devErrorHeader = `🟡 LLM TIMEOUT`;
            else devErrorHeader = `🔴 LLM ERROR\n${llmError.message}`;
            rawLlmResponse = `[DEV MODE DIAGNOSTIC]\n${devErrorHeader}\n\n---\n${rawLlmResponse}`;
          }
        }
      }
      logger.info('🔄 Step 6 complete: Action Orchestrated', { action: decisionObject.action });

      // ── Step 7: Policy Engine (Post-Action / Output Validation) ──
      // Evaluate the generated text for safety using the dedicated backend Node.js filter
      if (decisionObject.action === 'GENERATE_LLM' && policyResult.decision !== 'BLOCK') {
        // Pass OPA conditions to output safety — no hardcoded role exemptions
        const safetyContext = {
          userRole: roleForPolicy,
          actorId: actorId,
          targetActorId: studentToQuery,
          intent: intentResult.intent,
          opaConditions,
        };

        const safetyResult = outputSafetyService.evaluateResponse(rawLlmResponse, safetyContext);

        if (safetyResult.decision === 'BLOCK') {
          policyResult = {
            decision: 'BLOCK',
            reason: safetyResult.reason,
            original_text: rawLlmResponse
          };
          decisionObject.action = 'BLOCK_RESPONSE';
        }
        logger.info('🔄 Step 7 complete: Post-Action Backend Safety evaluated', { decision: policyResult.decision, conditions: opaConditions });
      }

      // ── Step 8: Response Composer ─────────────────────────────────
      const authContext = {
        actorId: actorId,
        actorInfo: actorInfo,
        userRole: roleForPolicy,
        relationships: userRelationships,
        sessionUserRole: session.userRole
      };

      let { finalResponse, wasBlocked, policyDecision, score, rationale } = responseComposer.compose(
        policyResult,
        intentResult,
        rawLlmResponse,
        channel,
        devModeEnabled,
        reasoning,
        authContext,
        policyInput
      );
      
      // Inject Download Link Option if requested
      const lowerText = text.toLowerCase();
      if (!wasBlocked && (lowerText.includes('download') && lowerText.includes('report'))) {
          const downloadUrl = `/api/chat/download-report?from=${encodeURIComponent(from)}${sessionId ? '&sessionId=' + encodeURIComponent(sessionId) : ''}`;
          finalResponse += `\n\n📥 [Click here to download your report](${downloadUrl})`;
      }

      const totalLatencyMs = Date.now() - startTime;
      logger.info('🔄 Step 8 complete: Response composed', { wasBlocked, score, rationale, totalLatencyMs });

      // Send Response
      if (devModeEnabled) {
        const devMessage = responseComposer.formatDevModeMessage({
          request: text,
          inputPolicy,
          rawContext,
          curatedContext: context,
          prompt: systemPromptUsed,
          rawResponse: rawLlmResponse,
          finalResponse,
          policyResult,
          intentResult,
          totalLatencyMs,
          reasoning,
          authContext: authContext,
          policyInputDebug: policyInput
        });
        await this._respond(channel, from, devMessage);
      }

      await this._respond(channel, from, finalResponse);

      // Session State Update
      if (!wasBlocked && decisionObject.action !== 'VERIFY_IDENTITY') {
        session.userRole = roleForPolicy; 
        await sessionService.update(sessionKey, text, rawLlmResponse, intentResult.industry);
      }

      // ── Step 9: Trace Recorder ────────────────────────────────────
      const trace = traceService.createTrace({
        from,
        messageId,
        inputText: text,
        intentResult,
        rawLlmResponse,
        policyResult,
        finalResponse,
        wasBlocked,
        totalLatencyMs,
        score,
        finalRationale: rationale,
        ragMetadata,
        reasoning,
        channel,
        sessionState: {
          summary: session.compactedSummary,
          history_length: session.history.length
        },
        final_prompt: systemPromptUsed,
        authContext: authContext,
        policyInputDebug: policyInput
      });

      logger.info('🔄 Interaction complete', { traceId: trace.interaction_id, totalLatencyMs });
      return trace;

    } catch (error) {
      const totalLatencyMs = Date.now() - startTime;
      logger.error('🔄 Interaction failed', {
        channel, from: from.slice(-4), error: error.message, stack: error.stack, totalLatencyMs,
      });

      try {
        await this._respond(channel, from, "I'm sorry, something went wrong processing your request. Please try again in a moment.");
      } catch (sendError) {
        logger.error('🔄 Failed to send error response', { error: sendError.message });
      }

      // Ensure failure is traced
      traceService.createTrace({
        from,
        messageId,
        inputText: text,
        intentResult: { industry: 'unknown', intent: 'system_error', confidence: 0 },
        rawLlmResponse: '',
        policyResult: { decision: 'BLOCK', reason: `System Error: ${error.message}` },
        finalResponse: "System error occurred.",
        wasBlocked: true,
        totalLatencyMs,
        channel
      });

      throw error;
    }
  }

  setDevMode(enabled) {
    devModeEnabled = enabled;
    logger.info(`🔧 Dev mode ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }

  isDevMode() {
    return devModeEnabled;
  }
}

module.exports = new InteractionService();
