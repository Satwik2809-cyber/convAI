/**
 * ConvAI — Knowledge Service
 * 
 * Manages the knowledge base from local folder data/knowledge/{industry}.
 * Implements re-indexing logic only if the files have changed and a 10-minute
 * TTL window has passed.
 */

const fs = require('fs/promises');
const path = require('path');
const config = require('../utils/config');
const logger = require('../utils/logger');
const documentProcessor = require('../utils/documentProcessor');
const chokidar = require('chokidar');

class KnowledgeService {
  constructor() {
    this.knowledgeDir = config.knowledgeDir || 'data/knowledge';
    this.cacheTtlMs = (config.ragCacheTtlMin || 10) * 60 * 1000;
    this.debounceMs = 60000; // 1-minute debounce for bulk uploads
    this.lastIndexedAt = {}; // { industry: timestamp }
    this.processedFiles = {}; // { industry: { filePath: mtime } }
    this.syncCallback = null;
    this.debounceTimers = {}; // { industry: timer }
  }

  /**
   * Initialize file watcher to detect changes in knowledge base.
   */
  initWatcher(onSyncNeeded) {
    this.syncCallback = onSyncNeeded;
    
    // Watch knowledge directory for all industries
    const watcher = chokidar.watch(this.knowledgeDir, {
      ignored: /(^|[\/\\])\../, // ignore dotfiles
      persistent: true,
      ignoreInitial: true, // Don't trigger on startup
      usePolling: true,    // Required for Docker volume event detection
      interval: 1000,      // Poll every 1 second
    });

    watcher.on('all', (event, filePath) => {
      // Determine industry from path: data/knowledge/{industry}/file.pdf
      const relativePath = path.relative(this.knowledgeDir, filePath);
      const industry = relativePath.split(path.sep)[0];
      
      if (industry && config.industry.allowed.includes(industry)) {
          logger.info(`📄 Knowledge change detected: ${event} on ${filePath}. Queueing sync for ${industry}.`);
          this._scheduleSync(industry);
      }
    });

    logger.info(`👁️ Knowledge watcher initialized for: ${this.knowledgeDir}`);
  }

  /**
   * Schedule a sync with debounce.
   */
  _scheduleSync(industry) {
    if (this.debounceTimers[industry]) {
      clearTimeout(this.debounceTimers[industry]);
    }

    this.debounceTimers[industry] = setTimeout(() => {
      if (this.syncCallback) {
        logger.info(`🔄 1-minute silence elapsed. Triggering sync for ${industry}...`);
        this.syncCallback(industry);
      }
      delete this.debounceTimers[industry];
    }, this.debounceMs);
  }



  /**
   * Get files and chunks for a specific industry.
   * Returns a map of filePath -> { chunks: string[], mtime: number, upToDate: boolean }
   */
  async getDetailedKnowledge(industry, existingMetadatas = []) {
    const industryDir = path.join(this.knowledgeDir, industry);
    
    try {
      await fs.mkdir(industryDir, { recursive: true });
    } catch (e) {
      return {};
    }

    const files = await this._listFiles(industryDir);
    const knowledgeMap = {};

    for (const file of files) {
      const filePath = path.join(industryDir, file);
      try {
        const stats = await fs.stat(filePath);
        
        // Optimization: skip parsing if the file's mtime matches ChromaDB
        const isUpToDate = existingMetadatas.some(m => m.source === filePath && m.mtime === stats.mtimeMs);
        if (isUpToDate) {
          knowledgeMap[filePath] = { chunks: [], mtime: stats.mtimeMs, upToDate: true };
          continue;
        }

        const chunks = await documentProcessor.processFile(filePath);
        knowledgeMap[filePath] = { chunks, mtime: stats.mtimeMs, upToDate: false };
      } catch (e) {
        logger.warn(`📄 Skipping file ${file}: ${e.message}`);
      }
    }

    this.lastIndexedAt[industry] = Date.now();
    return knowledgeMap;
  }

  /**
   * Helper: recursively list files in a directory.
   */
  async _listFiles(dir) {
    try {
      const items = await fs.readdir(dir);
      return items.filter(f => !f.startsWith('.')); // Ignore hidden files
    } catch (e) {
      return [];
    }
  }
}

module.exports = new KnowledgeService();
