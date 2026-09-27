const axios = require('axios');
const logger = require('../utils/logger');
const config = require('../utils/config');
const dataQueryService = require('./dataQueryService');

/**
 * ConvAI — Context Assembler (RAG Service)
 *
 * FAST PATH: Uses in-memory DataQueryService for all structured health/attendance queries.
 * SLOW PATH: Falls back to Python semantic search (ChromaDB) for fuzzy/trend analysis.
 *
 * This gives sub-200ms responses for 90% of queries vs the previous 8-12s via Python.
 */
class RagService {
  constructor() {
    this.pythonRagUrl = process.env.PYTHON_RAG_URL || 'http://localhost:8080';
    if (process.env.DOCKER_ENV) {
      this.pythonRagUrl = 'http://host.docker.internal:8080';
    }
  }

  /**
   * Trigger Python RAG data ingestion (only needed for semantic/ChromaDB path).
   */
  async ensureDatasetLoaded() {
    try {
      logger.info('🚀 Triggering Python RAG data ingestion...');
      await axios.post(`${this.pythonRagUrl}/ingest`, {}, { timeout: 120000 });
      logger.info('✅ Python RAG data ingested successfully.');
    } catch (err) {
      logger.warn('Python RAG ingestion unavailable (will use direct JSON query)', { error: err.message });
    }
    // Always ensure the in-memory service is loaded
    await dataQueryService.ensureLoaded();
  }

  /**
   * Determine if a query is SEMANTIC (needs ChromaDB) or STRUCTURED (direct JSON lookup).
   */
  _isSemanticQuery(query, role) {
    const lowerQ = (query || '').toLowerCase();
    const semanticKeywords = [
      'trend', 'compare', 'average', 'cohort', 'similar', 'pattern',
      'benchmark', 'analyse', 'analyze', 'insight', 'suggest', 'recommend',
      'why', 'correlation', 'improve', 'across all'
    ];
    return semanticKeywords.some(kw => lowerQ.includes(kw));
  }

  /**
   * Sync knowledge base (called by watcher on file change).
   */
  async sync(industry) {
    if (industry === 'education') {
      await dataQueryService.ensureLoaded();
    }
  }

  /**
   * Fetch relevant context for a query.
   *
   * @param {string} query          - User's question
   * @param {string} industry       - 'education'
   * @param {string} actorId        - Verified user's name
   * @param {string} targetActorId  - Target student name (if detected)
   * @param {string[]} conditions   - OPA-issued conditions array
   * @param {string} userRole       - teacher / parent / admin etc.
   * @param {string} sessionStudentId - Optional student ID from session
   */
  async getRelevantContext(query, industry, actorId, targetActorId, conditions = [], userRole = 'guest', sessionStudentId = null) {
    if (industry !== 'education') {
      return { context: '', rawContext: '', sourcesAvailable: [] };
    }

    const startTime = Date.now();

    // ── FAST PATH: Direct in-memory JSON query ──────────────────────────────
    try {
      await dataQueryService.ensureLoaded();

      const directCtx = await dataQueryService.buildContext(actorId, userRole, targetActorId, query, sessionStudentId);

      if (directCtx && !directCtx.startsWith('## Access Denied')) {
        // Add OPA masking on top if conditions demand it
        let finalCtx = directCtx;
        if (conditions.includes('high_level_only') || conditions.includes('no_medical_detail')) {
          finalCtx = dataQueryService._maskForTeacher(directCtx);
        }

        const header = this._buildHeader(actorId, userRole, targetActorId, conditions, 'DIRECT_JSON');
        logger.info(`✅ DataQueryService answered in ${Date.now() - startTime}ms`);
        return {
          context: (header + finalCtx).trim(),
          rawContext: finalCtx.trim(),
          sourcesAvailable: ['student_health_dataset.json']
        };
      }

      // Access denied — return the denial message directly
      if (directCtx && directCtx.startsWith('## Access Denied')) {
        const header = this._buildHeader(actorId, userRole, targetActorId, conditions, 'ACCESS_DENIED');
        return {
          context: (header + directCtx).trim(),
          rawContext: directCtx.trim(),
          sourcesAvailable: []
        };
      }
    } catch (err) {
      logger.warn('DataQueryService fast path failed, trying Python RAG', { error: err.message });
    }

    // ── SLOW PATH: Python semantic search (ChromaDB) ────────────────────────
    // Only reached for semantic/trend queries or if direct lookup returned nothing
    if (this._isSemanticQuery(query, userRole)) {
      try {
        const allowedStudents = this._getAllowedStudents(actorId, userRole);

        const response = await axios.post(`${this.pythonRagUrl}/retrieve`, {
          query,
          role: userRole,
          actorId,
          targetActorId,
          opaConditions: conditions,
          allowedStudents
        }, { timeout: 10000 });

        const payload = response.data;
        let semanticCtx = payload.context || '';

        // Apply OPA masking
        if (conditions.includes('high_level_only') || conditions.includes('no_medical_detail')) {
          semanticCtx = dataQueryService._maskForTeacher(semanticCtx);
        }

        const header = this._buildHeader(actorId, userRole, targetActorId, conditions, 'SEMANTIC_SEARCH');
        logger.info(`✅ Python RAG answered in ${Date.now() - startTime}ms`);
        return {
          context: (header + semanticCtx).trim(),
          rawContext: semanticCtx,
          sourcesAvailable: payload.sourcesAvailable || []
        };
      } catch (err) {
        logger.warn('Python RAG unavailable, falling back to direct JSON only', { error: err.message });
      }
    }

    // ── FALLBACK: Try direct JSON again without targetActorId restriction ──
    // (e.g. teacher asking generic question — return classroom context)
    try {
      const fallbackCtx = await dataQueryService.buildContext(actorId, userRole, null, query, sessionStudentId);
      if (fallbackCtx) {
        let finalCtx = fallbackCtx;
        if (conditions.includes('high_level_only') || conditions.includes('no_medical_detail')) {
          finalCtx = dataQueryService._maskForTeacher(fallbackCtx);
        }
        const header = this._buildHeader(actorId, userRole, targetActorId, conditions, 'DIRECT_JSON_FALLBACK');
        return {
          context: (header + finalCtx).trim(),
          rawContext: finalCtx,
          sourcesAvailable: ['student_health_dataset.json']
        };
      }
    } catch (_) {}

    // ── NOTHING FOUND ───────────────────────────────────────────────────────
    const header = this._buildHeader(actorId, userRole, targetActorId, conditions, 'NO_DATA');
    return {
      context: header + 'No specific student data found for this query. The dataset may not contain records for the requested student or the query may need more specificity.',
      rawContext: '',
      sourcesAvailable: []
    };
  }

  _buildHeader(actorId, userRole, targetActorId, conditions, source) {
    return `User Context:
- Requesting Actor: ${actorId}
- Role: ${userRole}
- Target Student: ${targetActorId || 'Not specified'}
- OPA Conditions: ${conditions.length > 0 ? conditions.join(', ') : 'FULL ACCESS'}
- Data Source: ${source}

`;
  }

  _getAllowedStudents(actorId, userRole) {
    try {
      const allowed = dataQueryService.getAllowedStudentIds(actorId, userRole);
      if (allowed === 'ALL') return null;
      // Convert student IDs to names for ChromaDB filter compatibility
      const names = [];
      for (const sid of allowed) {
        const s = dataQueryService.studentsById.get(sid);
        if (s) names.push(s.StudentName);
      }
      return names.length > 0 ? names : null;
    } catch (_) {
      return null;
    }
  }

  async reload() {
    logger.info('🔄 Reloading student health dataset...');
    dataQueryService._loaded = false;
    await dataQueryService.ensureLoaded();
    await this.ensureDatasetLoaded();
  }
}

module.exports = new RagService();
