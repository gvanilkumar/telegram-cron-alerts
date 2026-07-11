/**
 * @fileoverview Concurrent scheduler alert runner.
 */

const cronParser = require('cron-parser');
const config = require('./lib/config');
const logger = require('./lib/logger');
const stateManager = require('./lib/state');
const { scrapeWebpage } = require('./lib/scraper');
const {
  executeAiPrompt,
  executeOpenAiCompatiblePrompt,
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
    const tz = process.env.TIMEZONE || 'UTC';
    
    let isDue = false;
    try {
      const parsedInterval = cronParser.CronExpressionParser.parse(cronExpr, { tz });
      const prevRunTime = parsedInterval.prev().getTime();
      isDue = !lastRun || lastRun < prevRunTime;
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
        const resolvedModel = (provider === 'groq') ? 'groq/compound'
          : (provider === 'auto' && config.geminiApiKey && config.geminiApiKey.startsWith('gsk_')) ? 'groq/compound'
          : null;
        const isCompound = resolvedModel === 'groq/compound';
        
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
          // Hint the model to search the web if a URL or task name is available
          const hint = task.url ? ` Search this page for context: ${task.url}` : (task.name ? ` Search the web for: ${task.name}` : '');
          promptText = `${task.prompt}${hint}`;
        }

        let alertMessage = '';
        if (task.type === 'ai') {
          if (!config.geminiApiKey) {
            throw new Error('AI API Key (GEMINI_API_KEY environment variable) is not configured.');
          }
          
          if (provider === 'custom' && config.customApiEndpoint) {
            alertMessage = await executeOpenAiCompatiblePrompt(promptText, config.geminiApiKey, config.customApiEndpoint, config.customAiModel || 'gpt-4o-mini');
          } else if (provider === 'groq') {
            alertMessage = await executeOpenAiCompatiblePrompt(promptText, config.geminiApiKey, 'https://api.groq.com/openai/v1/chat/completions', 'groq/compound');
          } else if (provider === 'cerebras') {
            alertMessage = await executeOpenAiCompatiblePrompt(promptText, config.geminiApiKey, 'https://api.cerebras.ai/v1/chat/completions', 'gpt-oss-120b');
          } else if (provider === 'openai') {
            alertMessage = await executeOpenAiCompatiblePrompt(promptText, config.geminiApiKey, 'https://api.openai.com/v1/chat/completions', 'gpt-4o-mini');
          } else if (provider === 'gemini') {
            alertMessage = await executeAiPrompt(promptText, config.geminiApiKey);
          } else {
            // Prefix fallback auto-detection
            if (config.customApiEndpoint) {
              alertMessage = await executeOpenAiCompatiblePrompt(promptText, config.geminiApiKey, config.customApiEndpoint, config.customAiModel || 'gpt-4o-mini');
            } else if (config.geminiApiKey.startsWith('gsk_')) {
              alertMessage = await executeOpenAiCompatiblePrompt(promptText, config.geminiApiKey, 'https://api.groq.com/openai/v1/chat/completions', 'llama-3.3-70b-versatile');
            } else if (config.geminiApiKey.startsWith('cbs-') || config.geminiApiKey.startsWith('csk-')) {
              alertMessage = await executeOpenAiCompatiblePrompt(promptText, config.geminiApiKey, 'https://api.cerebras.ai/v1/chat/completions', 'gpt-oss-120b');
            } else if (config.geminiApiKey.startsWith('sk-')) {
              alertMessage = await executeOpenAiCompatiblePrompt(promptText, config.geminiApiKey, 'https://api.openai.com/v1/chat/completions', 'gpt-4o-mini');
            } else {
              alertMessage = await executeAiPrompt(promptText, config.geminiApiKey);
            }
          }
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
          if (task.deduplicate && task.type === 'ai' && !newVector) {
            newVector = await getEmbedding(alertMessage, config.geminiApiKey);
          }

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
            consecutiveFailures: 0
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
          consecutiveFailures: failures
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
        const tz = process.env.TIMEZONE || 'UTC';
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

  // Log execution runs
  executionLogs.forEach(log => stateManager.writeHistoryLog(log));

  logger.info('Alert Runner Finished.');
}

// Run immediately if executed directly via node runner.js
if (require.main === module) {
  run().catch(err => {
    logger.error('Unhandled scheduler failure', err);
    process.exit(1);
  });
}

<<<<<<< Updated upstream
module.exports = { run };
=======
async function executeOpenAiCompatiblePrompt(prompt, apiKey, url, model) {
  logDebug(`Calling OpenAI-compatible API at ${url} (model: ${model})...`);
  const systemInstruction = `You are a helpful automation assistant. Return a concise, clear alert or summary according to the user request. Make it look beautiful on a phone screen. Use Markdown formatting when appropriate (bold, bullet points, emoji). Keep the response under 1500 characters.`;

  let endpoint = url;
  if (!endpoint.endsWith('/chat/completions') && !endpoint.endsWith('/chat/completions/')) {
    endpoint = endpoint.replace(/\/$/, '') + '/chat/completions';
  }

  const response = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`AI API returned status ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const generatedText = data.choices?.[0]?.message?.content;

  if (!generatedText) {
    throw new Error('AI API returned empty response structure.');
  }

  return generatedText.trim();
}

function convertMarkdownToHtml(markdownText) {
  if (!markdownText) return '';
  // Convert [text](url) to <a href="$2">$1</a>
  let html = markdownText.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, '<a href="$2">$1</a>');
  // Convert **bold** to <b>bold</b>
  html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  return html;
}

async function sendTelegramMessage(text, taskName) {
  logDebug(`Sending Telegram alert...`);
  
  const htmlContent = convertMarkdownToHtml(text);
  const formattedText = `🔔 <b>Alert: ${taskName}</b>\n\n${htmlContent}`;
  
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  
  // Send message using robust HTML parsing
  let response = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: formattedText,
      parse_mode: 'HTML',
    })
  });

  // Fallback to plain text if HTML parsing has any unexpected tags
  if (!response.ok) {
    const errorData = await response.json();
    logDebug(`HTML parsing failed for Telegram message (${errorData.description}). Retrying in plain text.`);
    
    const plainText = `🔔 Alert: ${taskName}\n\n${text}`;
    response = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: plainText,
      })
    });
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Telegram API returned status ${response.status}: ${errText}`);
  }
}

async function sendDiscordMessage(text, taskName, webhookUrl) {
  logDebug(`Sending Discord Webhook alert...`);
  
  const formattedText = `🔔 **Alert: ${taskName}**\n\n${text}`;
  
  const response = await fetchWithRetry(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content: formattedText
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Discord Webhook returned status ${response.status}: ${errText}`);
  }
}

async function sendSlackMessage(text, taskName, webhookUrl) {
  logDebug(`Sending Slack Webhook alert...`);
  
  // Slack uses *bold* for bold and _italic_ for italic (matches Telegram!)
  const formattedText = `🔔 *Alert: ${taskName}*\n\n${text}`;
  
  const response = await fetchWithRetry(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: formattedText
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Slack Webhook returned status ${response.status}: ${errText}`);
  }
}

// Run the script
run().catch(err => {
  console.error('Fatal Runner Error:', err);
  process.exit(1);
});
>>>>>>> Stashed changes
