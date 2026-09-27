/**
 * ConvAI — Session Service
 * 
 * Manages user-specific conversation state:
 * - Tracks turn count (for 5-turn compaction)
 * - Tracks last activity (for 2-min abandonment compaction)
 * - Handles compaction (summarization) using LLM
 * - Maintains active token window
 */

const config = require('../utils/config');
const logger = require('../utils/logger');
const llmService = require('./llmService');

class SessionService {
  constructor() {
    this.sessions = new Map(); // { from: { history: [], turnCount, lastActivity, compactedSummary } }
    this.compactionTurns = config.sessionCompactionTurns || 5;
    this.idleCompactionMs = config.sessionIdleCompactionMs || 120000;
  }

  /**
   * Get or create a session for a user.
   */
  async getOrCreateSession(from) {
    let session = this.sessions.get(from);

    // Session timeout (e.g., 2 hours) to start fresh on a new day or long pause
    const sessionTimeoutMs = config.sessionTimeoutMs || 2 * 60 * 60 * 1000;

    if (session) {
      const idleTime = Date.now() - session.lastActivity;
      if (idleTime > sessionTimeoutMs) {
        logger.info(`🗑️ Session for ${from.slice(-4)} expired after ${Math.round(idleTime/60000)}m. Starting fresh.`);
        this.clear(from);
        session = null;
      }
    }

    if (!session) {
      session = {
        history: [],
        turnCount: 0,
        lastActivity: Date.now(),
        compactedSummary: '',
        currentIndustry: null, // Track current conversation scope
        auth: {
          isAuthenticated: false,
          token: null,
          expiresAt: null,
          pendingMessage: null
        },
        identity: {
          state: 'NONE',
          name: null,
          studentName: null,
          role: null,
          verifiedAt: null
        },
        currentTargetStudent: null
      };
      this.sessions.set(from, session);
    }

    // Check for idle abandonment compaction before returning
    await this._checkIdleCompaction(from, session);

    return session;
  }

  /**
   * Update session after a response.
   */
  async update(from, input, output, industry = null) {
    const session = this.sessions.get(from);
    if (!session) return;

    session.history.push({ role: 'user', content: input });
    session.history.push({ role: 'assistant', content: output });
    session.turnCount += 1;
    session.lastActivity = Date.now();
    
    if (industry) {
      session.currentIndustry = industry;
    }

    // Trigger turn-based compaction if limit reached
    if (session.turnCount >= this.compactionTurns) {
      await this.compact(from);
    }
  }

  /**
   * Proactively compact a session's history into a summary.
   */
  async compact(from) {
    const session = this.sessions.get(from);
    if (!session || session.history.length === 0) return;

    logger.info(`🔄 Compacting session for ${from.slice(-4)} (Turns: ${session.turnCount})`);

    try {
      const historyText = session.history
        .map(h => `${h.role}: ${h.content}`)
        .join('\n');

      const systemPrompt = "Summarize the following conversation history concisely. Focus on the main topic, current user intent, and any key facts discussed. Keep it under 200 words. This summary will be used as the context foundation for future turns.";
      
      const summary = await llmService.generateResponse(systemPrompt, historyText, {
          model: config.compactionModel || 'llama-3.1-8b-instant',
          fast: true, // Use fast Python server for compaction
      });

      session.compactedSummary = summary;
      session.history = []; // Clear active window
      session.turnCount = 0; // Reset counter
      
      logger.info(`🔄 Session compacted for ${from.slice(-4)}`);
    } catch (error) {
      logger.error(`🔄 Compaction failed for ${from.slice(-4)}`, { error: error.message });
    }
  }

  /**
   * Check if session has been idle for > 2 mins and needs compaction.
   */
  async _checkIdleCompaction(from, session) {
    const now = Date.now();
    const idleTime = now - session.lastActivity;

    if (idleTime > this.idleCompactionMs && session.history.length > 0) {
      logger.info(`🔄 Session for ${from.slice(-4)} abandoned for ${Math.round(idleTime/1000)}s. Compacting.`);
      await this.compact(from);
      // After idle compaction, update lastActivity to now so we don't repeat immediately
      session.lastActivity = now;
    }
  }

  /**
   * Clear/Delete a user's session (e.g. for safety violations).
   */
  clear(from) {
    this.sessions.delete(from);
    logger.info(`🗑️ Session cleared for ${from.slice(-4)}`);
  }
}

module.exports = new SessionService();
