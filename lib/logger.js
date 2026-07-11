/**
 * @fileoverview Structured logging engine supporting level filtering and formatting.
 */

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

// Determine default log level (default to DEBUG for convenience, or check environment)
const CURRENT_LEVEL = process.env.LOG_LEVEL 
  ? (LOG_LEVELS[process.env.LOG_LEVEL.toUpperCase()] !== undefined ? LOG_LEVELS[process.env.LOG_LEVEL.toUpperCase()] : LOG_LEVELS.DEBUG)
  : LOG_LEVELS.DEBUG;

/**
 * Format log message with ISO timestamp and level
 * @param {string} level 
 * @param {string} msg 
 * @returns {string}
 */
function formatMessage(level, msg) {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level}] ${msg}`;
}

const logger = {
  /**
   * @param {string} msg
   */
  debug(msg) {
    if (CURRENT_LEVEL <= LOG_LEVELS.DEBUG) {
      console.log(formatMessage('DEBUG', msg));
    }
  },
  /**
   * @param {string} msg
   */
  info(msg) {
    if (CURRENT_LEVEL <= LOG_LEVELS.INFO) {
      console.log(formatMessage('INFO', msg));
    }
  },
  /**
   * @param {string} msg
   */
  warn(msg) {
    if (CURRENT_LEVEL <= LOG_LEVELS.WARN) {
      console.warn(formatMessage('WARN', msg));
    }
  },
  /**
   * @param {string} msg
   * @param {Error} [err]
   */
  error(msg, err = null) {
    if (CURRENT_LEVEL <= LOG_LEVELS.ERROR) {
      let errMsg = msg;
      if (err) {
        errMsg += ` - ${err.message}`;
        if (err.stack && CURRENT_LEVEL === LOG_LEVELS.DEBUG) {
          errMsg += `\n${err.stack}`;
        }
      }
      console.error(formatMessage('ERROR', errMsg));
    }
  }
};

module.exports = logger;
