/**
 * @fileoverview Atomic state and task configuration manager.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

const tasksPath = path.join(config.rootDir, 'tasks.json');
const statePath = path.join(config.rootDir, 'state.json');
const logsDir = path.join(config.rootDir, 'logs');
const logsPath = path.join(logsDir, 'history.json');
const MAX_LOGS = 200;

/**
 * Write data atomically to a file by writing to a temporary file first and renaming.
 * @param {string} targetPath 
 * @param {any} data 
 */
function writeJsonAtomic(targetPath, data) {
  const tmpPath = targetPath + '.tmp';
  try {
    const content = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    logger.error(`Atomic write failed to ${targetPath}`, err);
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (_) {
        // Suppress unlink error
      }
    }
    throw err;
  }
}

const stateManager = {
  tasksPath,
  statePath,
  logsPath,

  /**
   * Reads all active task configurations.
   * @returns {Array<any>}
   */
  readTasks() {
    if (!fs.existsSync(tasksPath)) return [];
    try {
      return JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
    } catch (err) {
      logger.error('Failed to read tasks file', err);
      return [];
    }
  },

  /**
   * Writes tasks to config file atomically.
   * @param {Array<any>} tasks 
   */
  writeTasks(tasks) {
    writeJsonAtomic(tasksPath, tasks);
  },

  /**
   * Reads task run statuses.
   * @returns {Object}
   */
  readState() {
    if (!fs.existsSync(statePath)) return {};
    try {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (err) {
      logger.error('Failed to read state file', err);
      return {};
    }
  },

  /**
   * Writes task state atomically.
   * @param {Object} state 
   */
  writeState(state) {
    writeJsonAtomic(statePath, state);
  },

  /**
   * Writes execution logs to history database atomically and caps logs.
   * @param {Object} logEntry 
   */
  async writeHistoryLog(logEntry) {
    try {
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      let logs = [];
      if (fs.existsSync(logsPath)) {
        try {
          logs = JSON.parse(fs.readFileSync(logsPath, 'utf8'));
        } catch (e) {
          logger.warn(`Failed to parse history.json, resetting log database.`);
        }
      }

      // Prepend and cap at MAX_LOGS
      logs = [logEntry, ...logs].slice(0, MAX_LOGS);
      writeJsonAtomic(logsPath, logs);

      // Async call to Google Sheets if enabled
      if (config.settings.googleSheetLoggingEnabled && config.googleSheetId && config.googleServiceAccountKey) {
        try {
          const { appendSheetLog } = require('./sheets');
          await appendSheetLog(config.googleSheetId, config.googleServiceAccountKey, logEntry);
        } catch (sheetErr) {
          logger.error('Google Sheets log append failed', sheetErr);
        }
      }
    } catch (err) {
      logger.error('Failed to write history log entry', err);
    }
  }
};

module.exports = stateManager;
