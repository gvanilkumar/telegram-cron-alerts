/**
 * @fileoverview General utility functions.
 */

const logger = require('./logger');

/**
 * Perform a fetch request with exponential backoff retry logic.
 * @param {string} url 
 * @param {RequestInit} [options] 
 * @param {number} [retries] 
 * @param {number} [backoff] 
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}, retries = 3, backoff = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      return response;
    } catch (err) {
      if (i === retries - 1) throw err;
      logger.warn(`Fetch connection error: ${err.message}. Retrying in ${backoff}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoff));
      backoff *= 2;
    }
  }
}

module.exports = {
  fetchWithRetry
};
