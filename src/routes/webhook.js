/**
 * ConvAI MVP — WhatsApp Webhook Routes
 * 
 * GET  /webhook — Meta verification handshake
 * POST /webhook — Incoming message handler
 */

const express = require('express');
const router = express.Router();
const config = require('../utils/config');
const logger = require('../utils/logger');
const WhatsAppService = require('../services/whatsappService');
const interactionService = require('../services/interactionService');

// Simple per-user debounce to prevent duplicate processing
const recentMessages = new Map();
const DEBOUNCE_MS = 2000;

/**
 * GET /webhook — Meta verification endpoint.
 * Meta sends a GET request to verify your webhook URL during setup.
 */
router.get('/', (req, res) => {
  logger.info('📥 Received GET /webhook request for verification', { query: req.query });
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    logger.info('✅ Webhook verified successfully');
    return res.status(200).send(challenge);
  }

  logger.warn('❌ Webhook verification failed', { mode, tokenMatch: token === config.whatsapp.verifyToken });
  return res.sendStatus(403);
});

/**
 * POST /webhook — Incoming message handler.
 * Returns 200 immediately (Meta requirement), then processes asynchronously.
 */
router.post('/', (req, res) => {
  logger.info('📥 Received POST /webhook request', { body: JSON.stringify(req.body, null, 2) });
  
  // Always respond 200 immediately — Meta requires fast acknowledgment
  res.sendStatus(200);

  // Extract text message from webhook payload
  const messageData = WhatsAppService.constructor.extractTextMessage
    ? require('../services/whatsappService').constructor.extractTextMessage(req.body)
    : extractMessage(req.body);

  logger.info('🔍 Extracted message data:', { messageData });

  if (!messageData) {
    logger.warn('⚠️ No valid text message extracted from payload. Ignoring.');
    return; // Not a text message or invalid payload — already logged
  }

  const { from, text, messageId } = messageData;

  // Debounce: skip if we just processed a message from this user
  const lastProcessed = recentMessages.get(from);
  if (lastProcessed && Date.now() - lastProcessed < DEBOUNCE_MS) {
    logger.debug('⏳ Debounced duplicate message', { from: from.slice(-4) });
    return;
  }
  
  logger.info('✅ Message passed debounce check. Proceeding to processing.', { from, messageId });
  recentMessages.set(from, Date.now());

  // Clean up old entries periodically
  if (recentMessages.size > 1000) {
    const cutoff = Date.now() - DEBOUNCE_MS * 10;
    for (const [key, time] of recentMessages) {
      if (time < cutoff) recentMessages.delete(key);
    }
  }

  // Process the message asynchronously
  interactionService.processMessage(from, text, messageId).catch((error) => {
    logger.error('💥 Unhandled interaction error', { error: error.message });
  });
});

/**
 * Fallback message extractor (in case static method reference fails).
 */
function extractMessage(body) {
  logger.debug('🔍 extractMessage called with body:', { body: JSON.stringify(body, null, 2) });
  try {
    if (body?.object !== 'whatsapp_business_account') {
      logger.debug('📱 Ignoring payload: not a whatsapp_business_account');
      return null;
    }

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Support both real user messages and Meta Dashboard test messages (echoes)
    const message = value?.messages?.[0] || value?.message_echoes?.[0];

    if (!message) return null;

    if (message.type !== 'text') {
      logger.debug('📱 Ignoring non-text message', { type: message.type });
      return null;
    }

    return {
      from: message.from,
      text: message.text.body,
      messageId: message.id,
      timestamp: message.timestamp,
      contactName: value.contacts?.[0]?.profile?.name || 'Unknown',
    };
  } catch (error) {
    logger.error('📱 Failed to extract message', { error: error.message });
    return null;
  }
}

module.exports = router;
