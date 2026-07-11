/**
 * @fileoverview Custom error classes for granular error classification.
 */

class AuraError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

class ScraperError extends AuraError {
  /**
   * @param {string} message
   * @param {string} url
   */
  constructor(message, url) {
    super(message);
    this.url = url;
  }
}

class AiError extends AuraError {
  /**
   * @param {string} message
   * @param {string} provider
   */
  constructor(message, provider) {
    super(message);
    this.provider = provider;
  }
}

class NotifierError extends AuraError {
  /**
   * @param {string} message
   * @param {string} channel
   */
  constructor(message, channel) {
    super(message);
    this.channel = channel;
  }
}

module.exports = {
  AuraError,
  ScraperError,
  AiError,
  NotifierError
};
