/**
 * ConvAI MVP — Telegram Service
 * 
 * Handles sending messages via Telegram Bot API.
 * Supports mock mode for local development.
 */

const axios = require('axios');
const config = require('../utils/config');
const logger = require('../utils/logger');

class TelegramService {
  constructor() {
    this.mockMode = config.telegram.mockMode;
    this.token = config.telegram.botToken;
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
  }

  /**
   * Send a text message to a Telegram chat.
   * @param {string|number} chatId — Recipient chat ID
   * @param {string} text — Message body
   */
  async sendTextMessage(chatId, text) {
    if (this.mockMode) {
      logger.info('📱 [MOCK Telegram] Message sent', {
        to: chatId,
        text: text.substring(0, 200) + (text.length > 200 ? '...' : ''),
      });
      return { mock: true, status: 'sent' };
    }

    if (!this.token) {
      logger.error('📱 Telegram bot token is missing');
      throw new Error('Telegram bot token not configured');
    }

    try {
      const response = await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown', // Support basic formatting
      }, { timeout: 10000 });

      logger.info('📱 Telegram message sent', {
        to: chatId,
        messageId: response.data?.result?.message_id,
      });

      return response.data;
    } catch (error) {
      logger.error('📱 Telegram send failed', {
        to: chatId,
        error: error.response?.data || error.message,
      });
      throw error;
    }
  }

  /**
   * Extract text message data from a Telegram webhook update.
   * @param {object} body — The webhook POST body (Update object)
   * @returns {object|null} — { from, text, messageId } or null if not a text message
   */
  extractTextMessage(body) {
    try {
      const message = body.message;
      if (!message || !message.text) {
        return null;
      }

      return {
        from: message.chat.id.toString(), // Use chat ID as session identifier
        text: message.text,
        messageId: message.message_id.toString(),
        timestamp: message.date,
        contactName: message.from?.first_name || 'Unknown',
      };
    } catch (error) {
      logger.error('📱 Failed to extract Telegram message', { error: error.message });
      return null;
    }
  }
}

module.exports = new TelegramService();
