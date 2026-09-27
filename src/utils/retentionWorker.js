/**
 * ConvAI — Data Retention Worker
 * 
 * Periodically purges trace logs and interaction data older than the
 * configured retention period (7-30 days).
 */

const fs = require('fs/promises');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

class RetentionWorker {
  constructor() {
    this.retentionDays = config.retentionDays || 7;
    this.logDir = config.logging.dir || 'logs';
    this.traceDir = path.join(this.logDir, 'traces');
  }

  /**
   * Run the purge process.
   */
  async purgeOldData() {
    logger.info(`🧹 Starting data retention purge (Policy: ${this.retentionDays} days)`);
    
    let deletedCount = 0;
    const now = Date.now();
    const retentionMs = this.retentionDays * 24 * 60 * 60 * 1000;

    try {
      // 1. Purge Trace Logs
      const files = await this._listFiles(this.traceDir);
      
      for (const file of files) {
        const filePath = path.join(this.traceDir, file);
        const stats = await fs.stat(filePath);
        const ageMs = now - stats.mtimeMs;

        if (ageMs > retentionMs) {
          await fs.unlink(filePath);
          deletedCount++;
        }
      }

      logger.info(`🧹 Data retention purge complete`, { deletedCount });
    } catch (error) {
      logger.error(`🧹 Data retention purge failed`, { error: error.message });
    }
  }

  /**
   * Start a daily interval for the retention worker.
   */
  start() {
    // Run immediately on start
    this.purgeOldData();

    // Then run every 24 hours
    const twentyFourHours = 24 * 60 * 60 * 1000;
    setInterval(() => this.purgeOldData(), twentyFourHours);
  }

  async _listFiles(dir) {
    try {
      return await fs.readdir(dir);
    } catch (e) {
      return [];
    }
  }
}

module.exports = new RetentionWorker();
