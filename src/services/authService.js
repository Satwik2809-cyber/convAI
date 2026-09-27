/**
 * ConvAI — Auth Service (Dummy)
 * 
 * Handles simple token-based authentication and authorization.
 * Tokens are valid for 24 hours.
 */

const logger = require('../utils/logger');

class AuthService {
  constructor() {
    // Hardcoded secret for dummy implementation
    this.DUMMY_TOKEN = 'CONVAI-2024';
    this.TOKEN_PREFIX = 'TOKEN:';
    this.EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
  }

  /**
   * Check if a session is currently authenticated.
   * @param {Object} session 
   * @returns {boolean}
   */
  isAuthenticated(session) {
    if (!session.auth || !session.auth.isAuthenticated) {
      return false;
    }

    // Check for expiry
    const now = Date.now();
    if (session.auth.expiresAt && now > session.auth.expiresAt) {
      logger.info(`🔐 Token expired for session`, { expiresAt: new Date(session.auth.expiresAt).toISOString() });
      this.logout(session);
      return false;
    }

    return true;
  }

  /**
   * Validate if a message text contains a valid token.
   * For this dummy implementation, we accept ANY non-empty string as a valid token.
   * @param {string} text 
   * @returns {boolean}
   */
  validateToken(text) {
    return text && text.trim().length > 0;
  }

  /**
   * Authenticate a session.
   * @param {Object} session 
   * @param {string} token 
   */
  login(session, token) {
    session.auth = {
      isAuthenticated: true,
      token: token,
      expiresAt: Date.now() + this.EXPIRY_MS,
      pendingMessage: session.auth ? session.auth.pendingMessage : null
    };
    logger.info(`🔐 Session authenticated. Expires at: ${new Date(session.auth.expiresAt).toISOString()}`);
  }

  /**
   * Clear authentication for a session.
   * @param {Object} session 
   */
  logout(session) {
    session.auth = {
      isAuthenticated: false,
      token: null,
      expiresAt: null,
      pendingMessage: null
    };
  }

  /**
   * Check if the message is a login attempt.
   * In dummy mode, if the user was challenged (pendingMessage exists), 
   * the very next message is treated as a token.
   * @param {string} text 
   * @param {Object} session
   * @returns {boolean}
   */
  isLoginAttempt(text, session) {
    if (!text) return false;
    const cleanText = text.trim();
    
    // Explicit login attempt with prefix
    if (cleanText.startsWith(this.TOKEN_PREFIX)) return true;
    
    // Or if we are waiting for a token
    if (session && session.auth && session.auth.pendingMessage) return true;

    // Legacy hardcoded token check
    return cleanText === this.DUMMY_TOKEN;
  }
}

module.exports = new AuthService();
