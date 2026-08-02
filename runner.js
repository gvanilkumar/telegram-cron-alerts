/**
 * @fileoverview Concurrent scheduler alert runner.
 */

const cronParser = require('cron-parser');
const config = require('./lib/config');
const logger = require('./lib/logger');
const stateManager = require('./lib/state');
const { scrapeWebpage } = require('./lib/scraper');
const {
  dispatchAiPrompt,
  getEmbedding,
  calculateCosineSimilarity,
  calculateLocalSimilarity
} = require('./lib/ai');
const {
  sendTelegramMessage,
  sendDiscordMessage,
  sendSlackMessage,
  sendSystemDiagnosticAlert
} = require('./lib/notifier');

/**
 * Map preset frequency strings to cron expressions
 * @param {string} schedule 
 * @returns {string}
 */
function getCronExpression(schedule) {
  const presets = {
    '5m': '*/5 * * * *',
    '15m': '*/15 * * * *',
    '1h': '0 * * * *',
    '5h': '0 */5 * * *',
    'daily': '0 9 * * *',
    'weekly': '0 9 * * 0',
    'monthly': '0 9 1 * *',
  };
  return presets[schedule] || schedule;
}

/**
 * Main execution orchestration routine.
 */
async function run() {
  logger.info('Starting Alert Runner...');

  const tasks = stateManager.readTasks();
  if (tasks.length === 0) {
    logger.info('No active tasks configured. Exiting.');
    return;
  }

  const state = stateManager.readState();
  const now = Date.now();
  let stateChanged = false;
  const executionLogs = [];

  await Promise.all(tasks.map(async (task) => {
    if (!task.active) return;

    const taskState = state[task.id];
    const lastRun = (taskState && typeof taskState === 'object') ? taskState.lastRun : (taskState || 0);
    
    const cronExpr = getCronExpression(task.schedule);
    const tz = process.env.TIMEZONE || config.settings.timezone || 'UTC';
    
    let isDue = false;
    try {
      if (!lastRun) {
        isDue = true;
      } else {
        const nextInterval = cronParser.CronExpressionParser.parse(cronExpr, { currentDate: new Date(lastRun), tz });
        const nextRunTime = nextInterval.next().getTime();
        // 45s tolerance window to prevent early trigger skipping due to clock skew or early webhooks
        const toleranceMs = 45000;
        isDue = (nextRunTime <= (now + toleranceMs));
      }
    } catch (cronErr) {
      logger.warn(`Task "${task.name}" has invalid cron schedule "${task.schedule}" / "${cronExpr}": ${cronErr.message}. Skipping.`);
      return;
    }

    if (isDue) {
      logger.info(`Executing Task: "${task.name}" (${task.schedule})`);
      const logEntry = {
        timestamp: new Date().toISOString(),
        taskId: task.id,
        taskName: task.name,
        schedule: task.schedule,
        status: 'pending',
        output: '',
        model: 'N/A'
      };

      let prevText = null;
      let prevVector = null;
      if (taskState && typeof taskState === 'object') {
        prevText = taskState.lastAlertText;
        prevVector = taskState.lastEmbedding;
      }

      try {
        let promptText = task.prompt || '';

        // Resolve provider early so we can skip scraping for compound models
        const provider = (task.type === 'ai') ? (config.settings.aiProvider || 'auto') : 'none';
        const groqModel = config.settings.groqModel || 'groq/compound';
        const isGroq = provider === 'groq' || (provider === 'auto' && config.geminiApiKey && config.geminiApiKey.startsWith('gsk_'));
        const isCompound = isGroq && groqModel.startsWith('groq/compound');
        
        // Scrape page context if task type is AI (skip for compound — it has built-in web search)
        if (task.type === 'ai' && !isCompound) {
          let targetUrl = task.url;
          let isFallback = false;
          if (!targetUrl) {
            const searchQuery = task.name || 'financial news';
            targetUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(searchQuery)}&hl=en-US&gl=US&ceid=US:en`;
            isFallback = true;
          }
          
          try {
            const pageContext = await scrapeWebpage(targetUrl);
            if (isFallback) {
              logger.debug(`Auto-scraped Google News RSS search query for: "${task.name}"`);
              promptText = `Context from news search:\n---\n${pageContext}\n---\n\nUser Request: ${task.prompt}`;
            } else {
              promptText = `Context from webpage (${targetUrl}):\n---\n${pageContext}\n---\n\nUser Request: ${task.prompt}`;
            }
          } catch (scrapeErr) {
            logger.warn(`Proceeding without webpage content due to scrape error: ${scrapeErr.message}`);
            promptText = `[Note: Unable to fetch live content from ${targetUrl || 'default news'} due to error: ${scrapeErr.message}]\n\nUser Request: ${task.prompt}`;
          }
        } else if (task.type === 'ai' && isCompound) {
          logger.debug(`Skipping scrape for groq/compound — model has built-in web search.`);
          const hint = task.url ? ` Search this page for context: ${task.url}` : (task.name ? ` Search the web for: ${task.name}` : '');
          promptText = `${task.prompt}${hint}`;
        }

        let alertMessage = '';
        if (task.type === 'ai') {
          if (!config.geminiApiKey) {
            throw new Error('AI API Key (GEMINI_API_KEY environment variable) is not configured.');
          }
          
          const result = await dispatchAiPrompt(
            promptText,
            config.geminiApiKey,
            provider,
            groqModel,
            config.customApiEndpoint
          );
          alertMessage = result.text;
          logEntry.model = result.model;
        } else {
          alertMessage = task.prompt || 'No message content defined.';
        }

        // Deduplication
        let shouldSkip = false;
        let similarityScore = 0;
        let newVector = null;

        if (task.deduplicate && task.type === 'ai' && prevText) {
          newVector = await getEmbedding(alertMessage, config.geminiApiKey, provider);
          if (newVector && prevVector && Array.isArray(newVector) && Array.isArray(prevVector)) {
            similarityScore = calculateCosineSimilarity(newVector, prevVector);
            logger.debug(`Semantic similarity (Neural): ${Math.round(similarityScore * 100)}%`);
          } else {
            similarityScore = calculateLocalSimilarity(alertMessage, prevText);
            logger.debug(`Semantic similarity (Local Fallback): ${Math.round(similarityScore * 100)}%`);
          }
          
          const threshold = task.threshold !== undefined ? task.threshold : 0.90;
          if (similarityScore >= threshold) {
            shouldSkip = true;
          }
        }

        if (shouldSkip) {
          logger.info(`Skipping alert delivery for task "${task.name}". Similarity is above threshold.`);
          logEntry.status = 'skipped';
          logEntry.output = `[Skipped] Similarity (${Math.round(similarityScore * 100)}%) is above threshold.`;
          
          state[task.id] = {
            lastRun: now,
            lastAlertText: prevText,
            lastEmbedding: prevVector,
            consecutiveFailures: 0
          };
          stateChanged = true;
        } else {
          const channels = task.channels || ['telegram'];
          const deliveryErrors = [];

          if (channels.includes('telegram')) {
            try {
              await sendTelegramMessage(alertMessage, task.name, config.telegramBotToken, config.telegramChatId);
            } catch (err) {
              deliveryErrors.push(`Telegram: ${err.message}`);
            }
          }

          if (channels.includes('discord')) {
            if (!config.discordWebhookUrl) {
              deliveryErrors.push('DISCORD_WEBHOOK_URL is missing');
            } else {
              try {
                await sendDiscordMessage(alertMessage, task.name, config.discordWebhookUrl);
              } catch (err) {
                deliveryErrors.push(`Discord: ${err.message}`);
              }
            }
          }

          if (channels.includes('slack')) {
            if (!config.slackWebhookUrl) {
              deliveryErrors.push('SLACK_WEBHOOK_URL is missing');
            } else {
              try {
                await sendSlackMessage(alertMessage, task.name, config.slackWebhookUrl);
              } catch (err) {
                deliveryErrors.push(`Slack: ${err.message}`);
              }
            }
          }

          if (deliveryErrors.length > 0) {
            throw new Error(`Delivery failures: ${deliveryErrors.join(', ')}`);
          }

          logEntry.status = 'success';
          logEntry.output = alertMessage.substring(0, 150) + (alertMessage.length > 150 ? '...' : '');

          state[task.id] = {
            lastRun: now,
            lastAlertText: alertMessage,
            lastEmbedding: newVector,
            consecutiveFailures: 0,
            lastError: null
          };
          stateChanged = true;
        }
      } catch (err) {
        logger.error(`Error executing task "${task.name}"`, err);
        logEntry.status = 'error';
        logEntry.output = `Error: ${err.message}`;

        const failures = (taskState && typeof taskState === 'object') ? (taskState.consecutiveFailures || 0) + 1 : 1;
        state[task.id] = {
          lastRun: now,
          lastAlertText: prevText,
          lastEmbedding: prevVector,
          consecutiveFailures: failures,
          lastError: err.message
        };
        stateChanged = true;

        if (failures === 3) {
          logger.warn(`Task "${task.name}" failed 3 consecutive times. Dispatching system alert.`);
          await sendSystemDiagnosticAlert(task, err.message, config.telegramBotToken, config.telegramChatId);
        }
      }

      executionLogs.push(logEntry);
    } else {
      try {
        const cronExpr = getCronExpression(task.schedule);
        const tz = process.env.TIMEZONE || config.settings.timezone || 'UTC';
        const parsedInterval = cronParser.CronExpressionParser.parse(cronExpr, { tz });
        const nextRunTime = parsedInterval.next().toDate();
        logger.debug(`Task "${task.name}" is not due. Next run at: ${nextRunTime.toISOString()} (${tz})`);
      } catch (e) {
        logger.debug(`Task "${task.name}" is not due.`);
      }
    }
  }));

  // Save changes atomically
  if (stateChanged) {
    stateManager.writeState(state);
    logger.debug('Saved updated state.json');
  }

  // Log execution runs and wait for Google Sheets appends to finish
  await Promise.all(executionLogs.map(log => stateManager.writeHistoryLog(log)));

  logger.info('Alert Runner Finished.');
}

// Run immediately if executed directly via node runner.js
if (require.main === module) {
  run().catch(err => {
    logger.error('Unhandled scheduler failure', err);
    process.exit(1);
  });
}

module.exports = { run };
