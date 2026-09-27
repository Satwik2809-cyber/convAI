/**
 * ConvAI MVP — Telegram Webhook Routes
 * 
 * POST /telegram — Incoming message handler
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const TelegramService = require('../services/telegramService');
const interactionService = require('../services/interactionService');

// Simple per-user debounce to prevent duplicate processing
const recentMessages = new Map();
const DEBOUNCE_MS = 2000;

/**
 * POST /telegram — Incoming update handler.
 */
router.post('/', (req, res) => {
  // Always respond 200 immediately
  res.sendStatus(200);

  // Extract text message from Telegram update payload
  const messageData = TelegramService.extractTextMessage(req.body);

  if (!messageData) {
    return; // Not a text message or invalid payload
  }

  const { from, text, messageId } = messageData;

  // Debounce: skip if we just processed a message from this user
  const lastProcessed = recentMessages.get(from);
  if (lastProcessed && Date.now() - lastProcessed < DEBOUNCE_MS) {
    logger.debug('⏳ Debounced duplicate Telegram message', { from });
    return;
  }
  recentMessages.set(from, Date.now());

  // Clean up old entries periodically
  if (recentMessages.size > 1000) {
    const cutoff = Date.now() - DEBOUNCE_MS * 10;
    for (const [key, time] of recentMessages) {
      if (time < cutoff) recentMessages.delete(key);
    }
  }

  // Process the message asynchronously
  interactionService.processMessage(from, text, messageId, 'telegram').catch((error) => {
    logger.error('💥 Unhandled Telegram interaction error', { error: error.message });
  });
});

module.exports = router;
