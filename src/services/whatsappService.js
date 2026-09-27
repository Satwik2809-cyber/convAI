/**
 * ConvAI MVP — WhatsApp Service
 * 
 * Handles sending messages via WhatsApp Cloud API.
 * Supports mock mode for local development without Meta credentials.
 * Follows least-privilege: only uses the messages permission scope.
 */

const axios = require('axios');
const config = require('../utils/config');
const logger = require('../utils/logger');

class WhatsAppService {
  constructor() {
    this.mockMode = config.whatsapp.mockMode;
    this.baseUrl = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}`;
    this.headers = {
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Send a text message to a WhatsApp user.
   * @param {string} phoneNumber — Recipient phone number (with country code)
   * @param {string} text — Message body
   */
  async sendTextMessage(phoneNumber, text) {
    if (this.mockMode) {
      logger.info('📱 [MOCK WhatsApp] Message sent', {
        to: phoneNumber,
        text: text.substring(0, 200) + (text.length > 200 ? '...' : ''),
      });
      return { mock: true, status: 'sent' };
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/messages`,
        {
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: 'text',
          text: { body: text },
        },
        { headers: this.headers, timeout: 10000 }
      );

      logger.info('📱 WhatsApp message sent', {
        to: phoneNumber,
        messageId: response.data?.messages?.[0]?.id,
      });

      return response.data;
    } catch (error) {
      logger.error('📱 WhatsApp send failed', {
        to: phoneNumber,
        error: error.response?.data || error.message,
      });
      throw error;
    }
  }

  /**
   * Mark a received message as read.
   * @param {string} messageId — The incoming message ID
   */
  async markAsRead(messageId) {
    if (this.mockMode) {
      logger.debug('📱 [MOCK WhatsApp] Marked as read', { messageId });
      return;
    }

    try {
      await axios.post(
        `${this.baseUrl}/messages`,
        {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
        },
        { headers: this.headers, timeout: 5000 }
      );
    } catch (error) {
      // Non-critical — log and continue
      logger.warn('📱 Failed to mark message as read', {
        messageId,
        error: error.message,
      });
    }
  }

  /**
   * Extract text message data from a WhatsApp webhook payload.
   * @param {object} body — The webhook POST body
   * @returns {object|null} — { from, text, messageId } or null if not a text message
   */
  static extractTextMessage(body) {
    try {
      if (body?.object !== 'whatsapp_business_account') return null;

      const entry = body.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

      // Support both real user messages and Meta Dashboard test messages (echoes)
      const message = value?.messages?.[0] || value?.message_echoes?.[0];

      if (!message) return null;

      // Only process text messages (ignore images, stickers, etc.)
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
}

module.exports = new WhatsAppService();
