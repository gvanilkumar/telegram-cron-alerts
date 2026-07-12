/**
 * @fileoverview AuraVigil Local Configuration Express Server.
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const parser = require('cron-parser');

// Import modular libraries
const config = require('./lib/config');
const logger = require('./lib/logger');
const stateManager = require('./lib/state');
const { scrapeWebpage } = require('./lib/scraper');
const { runCmd, gitSync } = require('./lib/git');
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
  convertMarkdownToHtml
} = require('./lib/notifier');

const app = express();
const PORT = process.env.PORT || 3001;

// Path definitions
const frontendDistPath = path.join(config.rootDir, 'frontend', 'dist');

// Middleware
app.use(cors());
app.use(express.json());

// Initialize settings and configuration files if missing
if (!fs.existsSync(stateManager.tasksPath)) {
  fs.writeFileSync(stateManager.tasksPath, '[]', 'utf8');
}
if (!fs.existsSync(stateManager.statePath)) {
  fs.writeFileSync(stateManager.statePath, '{}', 'utf8');
}
if (!fs.existsSync(config.settingsPath)) {
  fs.writeFileSync(config.settingsPath, JSON.stringify({ autoSync: false }, null, 2), 'utf8');
}
if (!fs.existsSync(path.dirname(stateManager.logsPath))) {
  fs.mkdirSync(path.dirname(stateManager.logsPath), { recursive: true });
}
if (!fs.existsSync(stateManager.logsPath)) {
  fs.writeFileSync(stateManager.logsPath, '[]', 'utf8');
}

/**
 * Parses GitHub repository name/owner from Git configuration.
 * @returns {Promise<string>}
 */
async function getGitRepoPath() {
  try {
    const url = await runCmd('git config --get remote.origin.url');
    if (!url) return '';
    const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    return match ? match[1] : '';
  } catch (err) {
    logger.debug(`Could not retrieve Git remote configuration: ${err.message}`);
    return '';
  }
}

/**
 * Filter and mask sensitive strings when saving credentials.
 * @param {string} newValue 
 * @param {string} existingValue 
 * @returns {string}
 */
function getCleanCredential(newValue, existingValue) {
  if (!newValue || newValue.includes('...')) {
    return existingValue || '';
  }
  return newValue.trim();
}

// --- API ROUTES ---

// 1. Fetch active tasks
app.get('/api/tasks', (req, res) => {
  try {
    const tasks = stateManager.readTasks();
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read tasks config: ' + err.message });
  }
});

// 2. Create new task configuration
app.post('/api/tasks', async (req, res) => {
  try {
    const tasks = stateManager.readTasks();
    const newTask = {
      id: 'task_' + Math.random().toString(36).substring(2, 11),
      name: req.body.name,
      type: req.body.type,
      prompt: req.body.prompt,
      schedule: req.body.schedule,
      url: req.body.url || '',
      channels: req.body.channels || ['telegram'],
      deduplicate: !!req.body.deduplicate,
      threshold: req.body.threshold !== undefined ? parseFloat(req.body.threshold) : 0.90,
      active: true,
      createdAt: new Date().toISOString(),
    };
    
    tasks.push(newTask);
    stateManager.writeTasks(tasks);

    // Trigger sync
    let syncStatus = { synced: false, message: 'Auto-sync not triggered' };
    try {
      syncStatus = await gitSync();
    } catch (syncErr) {
      syncStatus = { synced: false, error: syncErr.message };
    }

    res.json({ task: newTask, sync: syncStatus });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create task: ' + err.message });
  }
});

// 3. Update existing task details
app.put('/api/tasks/:id', async (req, res) => {
  try {
    const tasks = stateManager.readTasks();
    const index = tasks.findIndex(t => t.id === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ error: 'Task not found' });
    }

    tasks[index] = {
      ...tasks[index],
      name: req.body.name !== undefined ? req.body.name : tasks[index].name,
      type: req.body.type !== undefined ? req.body.type : tasks[index].type,
      prompt: req.body.prompt !== undefined ? req.body.prompt : tasks[index].prompt,
      schedule: req.body.schedule !== undefined ? req.body.schedule : tasks[index].schedule,
      url: req.body.url !== undefined ? req.body.url : tasks[index].url,
      channels: req.body.channels !== undefined ? req.body.channels : tasks[index].channels,
      deduplicate: req.body.deduplicate !== undefined ? !!req.body.deduplicate : tasks[index].deduplicate,
      threshold: req.body.threshold !== undefined ? parseFloat(req.body.threshold) : (tasks[index].threshold !== undefined ? tasks[index].threshold : 0.90),
      active: req.body.active !== undefined ? req.body.active : tasks[index].active,
      updatedAt: new Date().toISOString(),
    };

    stateManager.writeTasks(tasks);

    // Trigger sync
    let syncStatus = { synced: false, message: 'Auto-sync not triggered' };
    try {
      syncStatus = await gitSync();
    } catch (syncErr) {
      syncStatus = { synced: false, error: syncErr.message };
    }

    res.json({ task: tasks[index], sync: syncStatus });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update task: ' + err.message });
  }
});

// 4. Delete task configurations
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    let tasks = stateManager.readTasks();
    const exists = tasks.some(t => t.id === req.params.id);
    
    if (!exists) {
      return res.status(404).json({ error: 'Task not found' });
    }

    tasks = tasks.filter(t => t.id !== req.params.id);
    stateManager.writeTasks(tasks);

    // Clean up scheduler state atomically
    const state = stateManager.readState();
    if (state[req.params.id]) {
      delete state[req.params.id];
      stateManager.writeState(state);
    }

    // Trigger sync
    let syncStatus = { synced: false, message: 'Auto-sync not triggered' };
    try {
      syncStatus = await gitSync();
    } catch (syncErr) {
      syncStatus = { synced: false, error: syncErr.message };
    }

    res.json({ success: true, sync: syncStatus });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete task: ' + err.message });
  }
});

// 5. Run a task manually (immediate test execution)
app.post('/api/tasks/:id/run', async (req, res) => {
  try {
    const tasks = stateManager.readTasks();
    const task = tasks.find(t => t.id === req.params.id);
    
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const botToken = config.telegramBotToken;
    const chatId = config.telegramChatId;
    const geminiApiKey = config.geminiApiKey;

    const channels = task.channels || ['telegram'];
    
    // Validate credential configurations for manual execution
    if (channels.includes('telegram') && (!botToken || !chatId)) {
      return res.status(400).json({ error: 'Telegram credentials are not configured in Settings.' });
    }
    if (channels.includes('discord') && !config.discordWebhookUrl) {
      return res.status(400).json({ error: 'Discord Webhook URL is not configured in Settings.' });
    }
    if (channels.includes('slack') && !config.slackWebhookUrl) {
      return res.status(400).json({ error: 'Slack Webhook URL is not configured in Settings.' });
    }

    // Resolve provider early so we can decide whether to scrape
    const provider = config.settings.aiProvider || 'auto';
    const groqModel = config.settings.groqModel || 'groq/compound';
    const isCompound = (provider === 'groq' || (provider === 'auto' && geminiApiKey && geminiApiKey.startsWith('gsk_')))
      && groqModel.startsWith('groq/compound');

    // Web Scraping context (skip for groq/compound — it has built-in web search)
    let promptText = task.prompt || '';
    if (task.type === 'ai') {
      if (!isCompound) {
        let targetUrl = task.url;
        let isFallback = false;
        if (!targetUrl) {
          const searchQuery = task.name || 'financial news';
          targetUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(searchQuery)}&hl=en-US&gl=US&ceid=US:en`;
          isFallback = true;
        }
        
        try {
          const pageText = await scrapeWebpage(targetUrl);
          if (isFallback) {
            logger.debug(`Manual run: Auto-scraped Google News RSS search query for: "${task.name}"`);
            promptText = `Context from news search:\n---\n${pageText}\n---\n\nUser Request: ${task.prompt}`;
          } else {
            promptText = `Context from webpage (${targetUrl}):\n---\n${pageText}\n---\n\nUser Request: ${task.prompt}`;
          }
        } catch (scrapeErr) {
          logger.warn(`Proceeding without webpage content due to scrape error: ${scrapeErr.message}`);
          promptText = `[Note: Unable to fetch live content from ${targetUrl || 'default news'} due to error: ${scrapeErr.message}]\n\nUser Request: ${task.prompt}`;
        }
      } else {
        logger.debug(`Manual run: Skipping scrape for groq/compound — model has built-in web search.`);
        const hint = task.url ? ` Search this page for context: ${task.url}` : (task.name ? ` Search the web for: ${task.name}` : '');
        promptText = `${task.prompt}${hint}`;
      }
    }

    let alertMessage = '';
    let activeModelUsed = 'N/A';
    if (task.type === 'ai') {
      if (!geminiApiKey) {
        return res.status(400).json({ error: 'AI API Key is not configured in Settings.' });
      }

      const selectedModel = config.settings.groqModel;
      if (provider === 'custom' && config.customApiEndpoint) {
        activeModelUsed = selectedModel || config.customAiModel || 'gpt-4o-mini';
        alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, config.customApiEndpoint, activeModelUsed);
      } else if (provider === 'groq') {
        activeModelUsed = selectedModel || 'groq/compound';
        alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, 'https://api.groq.com/openai/v1/chat/completions', activeModelUsed);
      } else if (provider === 'cerebras') {
        activeModelUsed = 'gpt-oss-120b';
        alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, 'https://api.cerebras.ai/v1/chat/completions', activeModelUsed);
      } else if (provider === 'openai') {
        activeModelUsed = selectedModel || 'gpt-4o-mini';
        alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, 'https://api.openai.com/v1/chat/completions', activeModelUsed);
      } else if (provider === 'gemini') {
        activeModelUsed = 'gemini-2.5-flash';
        alertMessage = await executeAiPrompt(promptText, geminiApiKey);
      } else {
        if (config.customApiEndpoint) {
          activeModelUsed = selectedModel || config.customAiModel || 'gpt-4o-mini';
          alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, config.customApiEndpoint, activeModelUsed);
        } else if (geminiApiKey.startsWith('gsk_')) {
          activeModelUsed = selectedModel || 'groq/compound';
          alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, 'https://api.groq.com/openai/v1/chat/completions', activeModelUsed);
        } else if (geminiApiKey.startsWith('cbs-') || geminiApiKey.startsWith('csk-')) {
          activeModelUsed = 'gpt-oss-120b';
          alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, 'https://api.cerebras.ai/v1/chat/completions', activeModelUsed);
        } else if (geminiApiKey.startsWith('sk-')) {
          activeModelUsed = selectedModel || 'gpt-4o-mini';
          alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, 'https://api.openai.com/v1/chat/completions', activeModelUsed);
        } else {
          activeModelUsed = 'gemini-2.5-flash';
          alertMessage = await executeAiPrompt(promptText, geminiApiKey);
        }
      }
    } else {
      alertMessage = task.prompt;
    }

    // Retrieve deduplication similarity
    let shouldSkip = false;
    let similarityScore = 0;
    let newVector = null;
    let prevText = null;
    let prevVector = null;

    const state = stateManager.readState();

    if (task.deduplicate && task.type === 'ai') {
      const taskState = state[task.id];
      if (taskState && typeof taskState === 'object') {
        prevText = taskState.lastAlertText;
        prevVector = taskState.lastEmbedding;
      }
      
      if (prevText) {
        newVector = await getEmbedding(alertMessage, geminiApiKey, provider);
        if (newVector && prevVector && Array.isArray(newVector) && Array.isArray(prevVector)) {
          similarityScore = calculateCosineSimilarity(newVector, prevVector);
          logger.debug(`Semantic similarity (Manual Run Neural): ${Math.round(similarityScore * 100)}%`);
        } else {
          similarityScore = calculateLocalSimilarity(alertMessage, prevText);
          logger.debug(`Semantic similarity (Manual Run Local Fallback): ${Math.round(similarityScore * 100)}%`);
        }
        
        const threshold = task.threshold !== undefined ? task.threshold : 0.90;
        if (similarityScore >= threshold) {
          shouldSkip = true;
        }
      }
    }

    if (shouldSkip) {
      logger.info(`Skipping alert delivery for manual run task "${task.name}". Similarity is above threshold.`);
      
      state[task.id] = {
        lastRun: Date.now(),
        lastAlertText: prevText,
        lastEmbedding: prevVector
      };
      stateManager.writeState(state);

      // Write skipped log atomically
      const logEntry = {
        timestamp: new Date().toISOString(),
        taskId: task.id,
        taskName: task.name,
        schedule: task.schedule,
        status: 'skipped',
        output: `[Manual Run Skipped] Similarity (${Math.round(similarityScore * 100)}%) is above threshold.`,
        model: activeModelUsed
      };
      stateManager.writeHistoryLog(logEntry);

      // Trigger sync
      let syncStatus = { synced: false, message: 'Auto-sync not triggered' };
      try {
        syncStatus = await gitSync();
      } catch (syncErr) {
        syncStatus = { synced: false, error: syncErr.message };
      }

      return res.json({ 
        success: true, 
        message: `Alert skipped (similarity ${Math.round(similarityScore * 100)}% is above threshold).`, 
        sync: syncStatus 
      });
    }

    if (task.deduplicate && task.type === 'ai' && !newVector) {
      newVector = await getEmbedding(alertMessage, geminiApiKey);
    }

    // Deliver notifications
    const deliveryErrors = [];

    if (channels.includes('telegram')) {
      try {
        await sendTelegramMessage(alertMessage, task.name, botToken, chatId);
      } catch (err) {
        deliveryErrors.push(`Telegram: ${err.message}`);
      }
    }

    if (channels.includes('discord')) {
      try {
        await sendDiscordMessage(alertMessage, task.name, config.discordWebhookUrl);
      } catch (err) {
        deliveryErrors.push(`Discord: ${err.message}`);
      }
    }

    if (channels.includes('slack')) {
      try {
        await sendSlackMessage(alertMessage, task.name, config.slackWebhookUrl);
      } catch (err) {
        deliveryErrors.push(`Slack: ${err.message}`);
      }
    }

    if (deliveryErrors.length > 0) {
      throw new Error(`Delivery failures: ${deliveryErrors.join(', ')}`);
    }

    // Update state last run
    state[task.id] = {
      lastRun: Date.now(),
      lastAlertText: alertMessage,
      lastEmbedding: newVector
    };
    stateManager.writeState(state);

    // Log success entry
    const logEntry = {
      timestamp: new Date().toISOString(),
      taskId: task.id,
      taskName: task.name,
      schedule: task.schedule,
      status: 'success',
      output: '[Manual Run] ' + alertMessage.substring(0, 150) + (alertMessage.length > 150 ? '...' : ''),
      model: activeModelUsed
    };
    stateManager.writeHistoryLog(logEntry);

    // Trigger sync
    let syncStatus = { synced: false, message: 'Auto-sync not triggered' };
    try {
      syncStatus = await gitSync();
    } catch (syncErr) {
      syncStatus = { synced: false, error: syncErr.message };
    }

    res.json({ success: true, message: 'Task executed successfully.', sync: syncStatus });
  } catch (err) {
    res.status(500).json({ error: 'Execution failed: ' + err.message });
  }
});

// 6. Fetch execution logs
app.get('/api/logs', async (req, res) => {
  try {
    if (config.settings.googleSheetLoggingEnabled && config.googleSheetId && config.googleServiceAccountKey) {
      try {
        const { fetchSheetLogs } = require('./lib/sheets');
        const sheetLogs = await fetchSheetLogs(config.googleSheetId, config.googleServiceAccountKey);
        return res.json(sheetLogs);
      } catch (sheetErr) {
        logger.error('Failed to fetch logs from Google Sheets, falling back to local history.json', sheetErr);
      }
    }

    if (fs.existsSync(stateManager.logsPath)) {
      const data = JSON.parse(fs.readFileSync(stateManager.logsPath, 'utf8'));
      res.json(data);
    } else {
      res.json([]);
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to read logs: ' + err.message });
  }
});

// 7. Validate Cron expressions
app.get('/api/cron/validate', (req, res) => {
  const { expr, tz } = req.query;
  if (!expr) {
    return res.status(400).json({ valid: false, error: 'Expression is required' });
  }
  try {
    const options = tz ? { tz } : {};
    const interval = parser.CronExpressionParser.parse(expr, options);
    const times = [
      interval.next().toString(),
      interval.next().toString(),
      interval.next().toString(),
    ];
    res.json({ valid: true, nextRuns: times });
  } catch (err) {
    res.json({ valid: false, error: err.message });
  }
});

// 8. Fetch masked configuration and settings
app.get('/api/settings', async (req, res) => {
  try {
    let settings = { autoSync: false };
    if (fs.existsSync(config.settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(config.settingsPath, 'utf8'));
      } catch (_) {}
    }
    
    // Mask sensitive configurations keys
    const botTokenMasked = config.telegramBotToken 
      ? config.telegramBotToken.substring(0, 6) + '...' + config.telegramBotToken.substring(config.telegramBotToken.length - 4)
      : '';
    const chatIdMasked = config.telegramChatId 
      ? config.telegramChatId.substring(0, 3) + '...' + config.telegramChatId.substring(config.telegramChatId.length - 2)
      : '';
    const geminiKeyMasked = config.geminiApiKey 
      ? config.geminiApiKey.substring(0, 4) + '...' + config.geminiApiKey.substring(config.geminiApiKey.length - 4)
      : '';
    const discordUrlMasked = config.discordWebhookUrl
      ? config.discordWebhookUrl.substring(0, 15) + '...' + config.discordWebhookUrl.substring(config.discordWebhookUrl.length - 8)
      : '';
    const slackUrlMasked = config.slackWebhookUrl
      ? config.slackWebhookUrl.substring(0, 15) + '...' + config.slackWebhookUrl.substring(config.slackWebhookUrl.length - 8)
      : '';
    const googleServiceAccountKeyMasked = config.googleServiceAccountKey
      ? '(saved)'
      : '';

    res.json({
      credentialsConfigured: {
        telegramBotToken: !!config.telegramBotToken,
        telegramChatId: !!config.telegramChatId,
        geminiApiKey: !!config.geminiApiKey,
        discordWebhookUrl: !!config.discordWebhookUrl,
        slackWebhookUrl: !!config.slackWebhookUrl,
        googleServiceAccountKey: !!config.googleServiceAccountKey
      },
      masked: {
        telegramBotToken: botTokenMasked,
        telegramChatId: chatIdMasked,
        geminiApiKey: geminiKeyMasked,
        discordWebhookUrl: discordUrlMasked,
        slackWebhookUrl: slackUrlMasked,
        googleServiceAccountKey: googleServiceAccountKeyMasked
      },
      customApiEndpoint: config.customApiEndpoint,
      customAiModel: config.customAiModel,
      googleSheetId: config.googleSheetId,
      timezone: process.env.TIMEZONE || 'UTC',
      autoSync: settings.autoSync,
      aiProvider: settings.aiProvider || 'auto',
      groqModel: settings.groqModel || 'groq/compound',
      googleSheetLoggingEnabled: !!settings.googleSheetLoggingEnabled,
      githubRepoPath: (await getGitRepoPath()) || ''
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read settings: ' + err.message });
  }
});

// 9. Save settings and credentials configuration
app.post('/api/settings', (req, res) => {
  try {
    // Write settings atomically
    const settings = {
      autoSync: !!req.body.autoSync,
      aiProvider: req.body.aiProvider || 'auto',
      groqModel: req.body.groqModel || 'groq/compound',
      googleSheetLoggingEnabled: !!req.body.googleSheetLoggingEnabled
    };
    const tmpSettingsPath = config.settingsPath + '.tmp';
    fs.writeFileSync(tmpSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
    fs.renameSync(tmpSettingsPath, config.settingsPath);
    config.settings = settings;

    // Save credentials in .env atomically
    let envContent = '';
    const token = getCleanCredential(req.body.telegramBotToken, config.telegramBotToken);
    const chat = getCleanCredential(req.body.telegramChatId, config.telegramChatId);
    const gemini = getCleanCredential(req.body.geminiApiKey, config.geminiApiKey);
    const discord = getCleanCredential(req.body.discordWebhookUrl, config.discordWebhookUrl);
    const slack = getCleanCredential(req.body.slackWebhookUrl, config.slackWebhookUrl);
    const customApiEndpoint = (req.body.customApiEndpoint !== undefined ? req.body.customApiEndpoint : config.customApiEndpoint).trim();
    const customAiModel = (req.body.customAiModel !== undefined ? req.body.customAiModel : config.customAiModel).trim();
    const timezone = (req.body.timezone !== undefined ? req.body.timezone : (process.env.TIMEZONE || 'UTC')).trim();
    const rawGoogleKey = getCleanCredential(req.body.googleServiceAccountKey, config.googleServiceAccountKey);
    let googleServiceAccountKeyEnv = rawGoogleKey;
    if (rawGoogleKey && rawGoogleKey.trim().startsWith('{')) {
      try {
        googleServiceAccountKeyEnv = Buffer.from(rawGoogleKey.trim()).toString('base64');
      } catch (_) {}
    }
    const googleSheetId = (req.body.googleSheetId !== undefined ? req.body.googleSheetId : config.googleSheetId).trim();

    envContent += `TELEGRAM_BOT_TOKEN=${token}\n`;
    envContent += `TELEGRAM_CHAT_ID=${chat}\n`;
    envContent += `GEMINI_API_KEY=${gemini}\n`;
    envContent += `DISCORD_WEBHOOK_URL=${discord}\n`;
    envContent += `SLACK_WEBHOOK_URL=${slack}\n`;
    envContent += `CUSTOM_API_ENDPOINT=${customApiEndpoint}\n`;
    envContent += `CUSTOM_AI_MODEL=${customAiModel}\n`;
    envContent += `TIMEZONE=${timezone}\n`;
    envContent += `GOOGLE_SERVICE_ACCOUNT_KEY=${googleServiceAccountKeyEnv}\n`;
    envContent += `GOOGLE_SHEET_ID=${googleSheetId}\n`;

    const tmpEnvPath = config.envPath + '.tmp';
    fs.writeFileSync(tmpEnvPath, envContent, 'utf8');
    fs.renameSync(tmpEnvPath, config.envPath);

    // Reload process env variables & config object references
    process.env.TELEGRAM_BOT_TOKEN = token;
    process.env.TELEGRAM_CHAT_ID = chat;
    process.env.GEMINI_API_KEY = gemini;
    process.env.DISCORD_WEBHOOK_URL = discord;
    process.env.SLACK_WEBHOOK_URL = slack;
    process.env.CUSTOM_API_ENDPOINT = customApiEndpoint;
    process.env.CUSTOM_AI_MODEL = customAiModel;
    process.env.TIMEZONE = timezone;
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = googleServiceAccountKeyEnv;
    process.env.GOOGLE_SHEET_ID = googleSheetId;

    config.telegramBotToken = token;
    config.telegramChatId = chat;
    config.geminiApiKey = gemini;
    config.discordWebhookUrl = discord;
    config.slackWebhookUrl = slack;
    config.customApiEndpoint = customApiEndpoint;
    config.customAiModel = customAiModel;
    config.googleServiceAccountKey = rawGoogleKey;
    config.googleSheetId = googleSheetId;

    res.json({ success: true, message: 'Settings saved successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save settings: ' + err.message });
  }
});

// 9b. Proxy provider model list — fetches models from the selected AI provider
app.get('/api/ai/models', async (req, res) => {
  const { key, provider, endpoint } = req.query;
  const apiKey = key || config.geminiApiKey;
  if (!apiKey) return res.status(400).json({ error: 'No API key provided.' });

  let modelsUrl;
  const resolvedProvider = provider || (apiKey.startsWith('gsk_') ? 'groq' : apiKey.startsWith('sk-') ? 'openai' : 'gemini');

  if (resolvedProvider === 'groq') {
    modelsUrl = 'https://api.groq.com/openai/v1/models';
  } else if (resolvedProvider === 'openai') {
    modelsUrl = 'https://api.openai.com/v1/models';
  } else if (resolvedProvider === 'custom' && endpoint) {
    modelsUrl = endpoint.replace(/\/$/, '').replace(/\/chat\/completions$/, '') + '/models';
    if (!modelsUrl.includes('/v1')) modelsUrl = modelsUrl + '/v1/models';
  } else {
    return res.json({ models: [] }); // Gemini/Cerebras don't have standard models list
  }

  try {
    const response = await fetch(modelsUrl, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!response.ok) {
      const txt = await response.text();
      return res.status(response.status).json({ error: txt });
    }
    const data = await response.json();
    // Normalize: filter to text-in/text-out, active models only
    const models = (data.data || data.models || []).filter(m => {
      if (m.active === false) return false;
      const out = m.output_modalities || [];
      if (out.length > 0 && !out.includes('text')) return false;
      return true;
    }).map(m => ({ id: m.id, name: m.name || m.id }));
    res.json({ models, provider: resolvedProvider });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch models: ' + err.message });
  }
});


// 10. Send test Telegram notifications
app.post('/api/test-telegram', async (req, res) => {
  const token = req.body.telegramBotToken || config.telegramBotToken;
  const chat = req.body.telegramChatId || config.telegramChatId;

  if (!token || !chat) {
    return res.status(400).json({ error: 'Telegram Bot Token and Chat ID are required to send test message.' });
  }

  try {
    await sendTelegramMessage(
      '🔔 *Telegram Cron Alerts Setup*\n\nYour bot has been successfully configured! You will receive automated alerts here.',
      'Setup Check',
      token,
      chat
    );
    res.json({ success: true, message: 'Test message sent successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Telegram test failed: ' + err.message });
  }
});

// 11. Send test Discord webhook alerts
app.post('/api/test-discord', async (req, res) => {
  const url = req.body.discordWebhookUrl || config.discordWebhookUrl;

  if (!url) {
    return res.status(400).json({ error: 'Discord Webhook URL is required to send test message.' });
  }

  try {
    await sendDiscordMessage(
      '🔔 **Discord Webhook Connection Success**\n\nYour Discord alert channel has been successfully configured!',
      'Setup Check',
      url
    );
    res.json({ success: true, message: 'Test message sent to Discord!' });
  } catch (err) {
    res.status(500).json({ error: 'Discord test failed: ' + err.message });
  }
});

// 12. Send test Slack webhook alerts
app.post('/api/test-slack', async (req, res) => {
  const url = req.body.slackWebhookUrl || config.slackWebhookUrl;

  if (!url) {
    return res.status(400).json({ error: 'Slack Webhook URL is required to send test message.' });
  }

  try {
    await sendSlackMessage(
      '🔔 *Slack Webhook Connection Success*\n\nYour Slack alert channel has been successfully configured!',
      'Setup Check',
      url
    );
    res.json({ success: true, message: 'Test message sent to Slack!' });
  } catch (err) {
    res.status(500).json({ error: 'Slack test failed: ' + err.message });
  }
});

// 13. Trigger active workflow dispatch tests
app.post('/api/test-dispatch', async (req, res) => {
  const { pat } = req.body;
  if (!pat) {
    return res.status(400).json({ error: 'GitHub Personal Access Token (PAT) is required.' });
  }

  try {
    const repoPath = await getGitRepoPath();
    if (!repoPath) {
      throw new Error('Could not identify your GitHub repository name from local Git configuration.');
    }

    const url = `https://api.github.com/repos/${repoPath}/actions/workflows/scheduler.yml/dispatches`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Telegram-Cron-Alerts-Manager'
      },
      body: JSON.stringify({ ref: 'main' })
    });

    if (response.status === 204) {
      res.json({ success: true, message: 'Workflow dispatch triggered successfully!' });
    } else {
      const text = await response.text();
      let parsedError = text;
      try {
        const json = JSON.parse(text);
        if (json.message) parsedError = json.message;
      } catch (e) {}
      throw new Error(`GitHub API Error (${response.status}): ${parsedError}`);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 14. Enhance prompt instruction drafts
app.post('/api/prompt/enhance', async (req, res) => {
  const { prompt, url } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt content is required' });
  }

  const geminiApiKey = config.geminiApiKey;
  if (!geminiApiKey) {
    return res.status(400).json({ error: 'AI API Key must be configured in Settings to use the Prompt Enhancer.' });
  }

  const targetUrlContext = url ? `Target webpage URL is: ${url}` : 'No target URL provided.';
  
  const instructionPrompt = `You are a professional prompt engineer for web scraping and notification alerts.
The user has a task that monitors a page and alerts them on Telegram/Discord.
User's goal / draft instructions: "${prompt}"
${targetUrlContext}

Please improve and rewrite their prompt. The rewritten prompt MUST:
1. Explain what context to look at (if target URL is provided, mention to scan the scraped page text).
2. Detail the exact triggers or conditions to look for.
3. Explicitly instruct the AI: "If nothing has changed, or if the conditions are not met, output 'no update' and nothing else." (This is crucial for deduplication!).
4. Define a clear output format for the alert notification (e.g. brief summary, bullet points, emoji prefix).
5. Be highly professional and keep the final prompt under 6-8 sentences.

Return ONLY the final enhanced prompt text inside your response. Do not include quotes, wrappers, conversational chatter, or explanations. Start directly with the prompt text.`;

  try {
    let enhancedText = '';

    const provider = config.settings.aiProvider || 'auto';
    const selectedModel = config.settings.groqModel;
    if (provider === 'custom' && config.customApiEndpoint) {
      enhancedText = await executeOpenAiCompatiblePrompt(instructionPrompt, geminiApiKey, config.customApiEndpoint, selectedModel || config.customAiModel || 'gpt-4o-mini');
    } else if (provider === 'groq') {
      enhancedText = await executeOpenAiCompatiblePrompt(instructionPrompt, geminiApiKey, 'https://api.groq.com/openai/v1/chat/completions', selectedModel || 'groq/compound');
    } else if (provider === 'cerebras') {
      enhancedText = await executeOpenAiCompatiblePrompt(instructionPrompt, geminiApiKey, 'https://api.cerebras.ai/v1/chat/completions', 'gpt-oss-120b');
    } else if (provider === 'openai') {
      enhancedText = await executeOpenAiCompatiblePrompt(instructionPrompt, geminiApiKey, 'https://api.openai.com/v1/chat/completions', selectedModel || 'gpt-4o-mini');
    } else if (provider === 'gemini') {
      enhancedText = await executeAiPrompt(instructionPrompt, geminiApiKey);
    } else {
      if (config.customApiEndpoint) {
        enhancedText = await executeOpenAiCompatiblePrompt(instructionPrompt, geminiApiKey, config.customApiEndpoint, selectedModel || config.customAiModel || 'gpt-4o-mini');
      } else if (geminiApiKey.startsWith('gsk_')) {
        enhancedText = await executeOpenAiCompatiblePrompt(instructionPrompt, geminiApiKey, 'https://api.groq.com/openai/v1/chat/completions', selectedModel || 'groq/compound');
      } else if (geminiApiKey.startsWith('cbs-') || geminiApiKey.startsWith('csk-')) {
        enhancedText = await executeOpenAiCompatiblePrompt(instructionPrompt, geminiApiKey, 'https://api.cerebras.ai/v1/chat/completions', 'gpt-oss-120b');
      } else if (geminiApiKey.startsWith('sk-')) {
        enhancedText = await executeOpenAiCompatiblePrompt(instructionPrompt, geminiApiKey, 'https://api.openai.com/v1/chat/completions', selectedModel || 'gpt-4o-mini');
      } else {
        enhancedText = await executeAiPrompt(instructionPrompt, geminiApiKey);
      }
    }

    res.json({ success: true, enhancedPrompt: enhancedText.trim() });
  } catch (err) {
    res.status(500).json({ error: 'Enhancement failed: ' + err.message });
  }
});

// 15. Preview scraped page text
app.post('/api/scrape/preview', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const pageText = await scrapeWebpage(url);
    res.json({ success: true, text: pageText });
  } catch (err) {
    res.status(500).json({ error: 'Failed to preview scrape: ' + err.message });
  }
});

// 16. Simulate prompt runs
app.post('/api/prompt/simulate', async (req, res) => {
  const { url, prompt, type, name } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt instructions are required.' });
  }

  const geminiApiKey = config.geminiApiKey;
  if (type === 'ai' && !geminiApiKey) {
    return res.status(400).json({ error: 'AI API Key is not configured in Settings.' });
  }

  try {
    const provider = config.settings.aiProvider || 'auto';
    const groqModel = config.settings.groqModel || 'groq/compound';
    const isCompound = (provider === 'groq' || (provider === 'auto' && geminiApiKey && geminiApiKey.startsWith('gsk_')))
      && groqModel.startsWith('groq/compound');

    let promptText = prompt;
    if (type === 'ai') {
      if (!isCompound) {
        let targetUrl = url;
        let isFallback = false;
        if (!targetUrl) {
          const searchQuery = name || 'financial news';
          targetUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(searchQuery)}&hl=en-US&gl=US&ceid=US:en`;
          isFallback = true;
        }

        try {
          const pageText = await scrapeWebpage(targetUrl);
          if (isFallback) {
            logger.debug(`Simulation: Auto-scraped Google News RSS search query for: "${name || 'unnamed'}"`);
            promptText = `Context from news search:\n---\n${pageText}\n---\n\nUser Request: ${prompt}`;
          } else {
            promptText = `Context from webpage (${targetUrl}):\n---\n${pageText}\n---\n\nUser Request: ${prompt}`;
          }
        } catch (scrapeErr) {
          promptText = `[Note: Scraper failed to fetch page content: ${scrapeErr.message}]\n\nUser Request: ${prompt}`;
        }
      } else {
        logger.debug(`Simulation: Skipping scrape for groq/compound — model has built-in web search.`);
        const hint = url ? ` Search this page for context: ${url}` : (name ? ` Search the web for: ${name}` : '');
        promptText = `${prompt}${hint}`;
      }
    }

    let alertMessage = '';
    if (type === 'ai') {
      const selectedModel = config.settings.groqModel;
      if (provider === 'custom' && config.customApiEndpoint) {
        alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, config.customApiEndpoint, selectedModel || config.customAiModel || 'gpt-4o-mini');
      } else if (provider === 'groq') {
        alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, 'https://api.groq.com/openai/v1/chat/completions', selectedModel || 'groq/compound');
      } else if (provider === 'cerebras') {
        alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, 'https://api.cerebras.ai/v1/chat/completions', 'gpt-oss-120b');
      } else if (provider === 'openai') {
        alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, 'https://api.openai.com/v1/chat/completions', selectedModel || 'gpt-4o-mini');
      } else if (provider === 'gemini') {
        alertMessage = await executeAiPrompt(promptText, geminiApiKey);
      } else {
        if (config.customApiEndpoint) {
          alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, config.customApiEndpoint, selectedModel || config.customAiModel || 'gpt-4o-mini');
        } else if (geminiApiKey.startsWith('gsk_')) {
          alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, 'https://api.groq.com/openai/v1/chat/completions', selectedModel || 'groq/compound');
        } else if (geminiApiKey.startsWith('cbs-') || geminiApiKey.startsWith('csk-')) {
          alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, 'https://api.cerebras.ai/v1/chat/completions', 'gpt-oss-120b');
        } else if (geminiApiKey.startsWith('sk-')) {
          alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, 'https://api.openai.com/v1/chat/completions', selectedModel || 'gpt-4o-mini');
        } else {
          alertMessage = await executeAiPrompt(promptText, geminiApiKey);
        }
      }
    } else {
      alertMessage = prompt;
    }

    res.json({ success: true, alertMessage });
  } catch (err) {
    res.status(500).json({ error: 'Simulation failed: ' + err.message });
  }
});

// 17. Manual sync trigger
app.post('/api/git/sync', async (req, res) => {
  try {
    const result = await gitSync();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve frontend build static files
if (fs.existsSync(frontendDistPath)) {
  app.use(express.static(frontendDistPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDistPath, 'index.html'));
  });
}

// Start HTTP server listener
const server = app.listen(PORT, () => {
  logger.info(`Local Configuration UI Server started on http://localhost:${PORT}`);
});

// Graceful process termination handlers
function handleGracefulShutdown(signal) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  server.close(() => {
    logger.info('HTTP server closed cleanly.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));
