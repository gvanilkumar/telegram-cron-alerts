const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const dotenv = require('dotenv');


const app = express();
const PORT = process.env.PORT || 3001;

function logDebug(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// Paths
const rootDir = __dirname;
const envPath = path.join(rootDir, '.env');
const configPath = path.join(rootDir, 'tasks.json');
const statePath = path.join(rootDir, 'state.json');
const settingsPath = path.join(rootDir, 'settings.json');
const logsPath = path.join(rootDir, 'logs', 'history.json');
const frontendDistPath = path.join(rootDir, 'frontend', 'dist');

// Load environment variables locally
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

// Middleware
app.use(cors());
app.use(express.json());

// Initialize files if they don't exist
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, '[]', 'utf8');
}
if (!fs.existsSync(statePath)) {
  fs.writeFileSync(statePath, '{}', 'utf8');
}
if (!fs.existsSync(settingsPath)) {
  fs.writeFileSync(settingsPath, JSON.stringify({ autoSync: false }, null, 2), 'utf8');
}
if (!fs.existsSync(path.join(rootDir, 'logs'))) {
  fs.mkdirSync(path.join(rootDir, 'logs'), { recursive: true });
}
if (!fs.existsSync(logsPath)) {
  fs.writeFileSync(logsPath, '[]', 'utf8');
}

// Helper to run shell commands
function runCmd(command) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd: rootDir }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

// Git Sync helper
async function gitSync() {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (!settings.autoSync) return { synced: false, message: 'Auto-sync is disabled' };

  try {
    // Check if git repository is initialized
    await runCmd('git rev-parse --is-inside-work-tree');
  } catch (e) {
    return { synced: false, message: 'Not a git repository. Please initialize git.' };
  }

  try {
    // 1. Stage all files (config, state, and logs)
    await runCmd('git add tasks.json settings.json state.json logs/history.json');
    
    // 2. Commit changes locally only if there are active staged changes
    const changes = await runCmd('git diff --cached --name-only');
    if (changes.trim()) {
      await runCmd('git commit -m "Local config and state update [skip ci]"');
    }

    // 3. Pull with rebase from remote counterpart
    await runCmd('git pull --rebase origin HEAD');
    
    // 4. Push changes back
    await runCmd('git push origin HEAD');
    return { synced: true, message: 'Configurations successfully synced to GitHub.' };
  } catch (err) {
    console.error('Git sync error:', err.message);
    throw new Error(`Git sync failed: ${err.message}`);
  }
}

// Scrape webpage context using native fetch and cleaning HTML tags
async function scrapeWebpage(url) {
  logDebug(`Scraping webpage: ${url}`);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP status ${response.status}`);
    }
    const html = await response.text();
    
    // Strip head, script, and style tags
    let text = html.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    
    // Strip all remaining HTML tags
    text = text.replace(/<[^>]+>/g, ' ');
    
    // Normalize spaces and trim
    text = text.replace(/\s+/g, ' ').trim();
    
    // Limit to 5000 characters
    return text.substring(0, 5000);
  } catch (err) {
    logDebug(`Scraping failed: ${err.message}`);
    throw new Error(`Failed to scrape ${url}: ${err.message}`);
  }
}

// --- API Endpoints ---

// Get all tasks
app.get('/api/tasks', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read tasks config: ' + err.message });
  }
});

// Create a task
app.post('/api/tasks', async (req, res) => {
  try {
    const tasks = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const newTask = {
      id: 'task_' + Math.random().toString(36).substring(2, 11),
      name: req.body.name,
      type: req.body.type, // 'ai' or 'static'
      prompt: req.body.prompt,
      schedule: req.body.schedule, // '5m', '15m', '1h', etc.
      url: req.body.url || "",
      channels: req.body.channels || ['telegram'],
      active: true,
      createdAt: new Date().toISOString(),
    };
    
    tasks.push(newTask);
    fs.writeFileSync(configPath, JSON.stringify(tasks, null, 2), 'utf8');

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

// Update a task
app.put('/api/tasks/:id', async (req, res) => {
  try {
    const tasks = JSON.parse(fs.readFileSync(configPath, 'utf8'));
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
      active: req.body.active !== undefined ? req.body.active : tasks[index].active,
      updatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(configPath, JSON.stringify(tasks, null, 2), 'utf8');

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

// Delete a task
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    let tasks = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const exists = tasks.some(t => t.id === req.params.id);
    
    if (!exists) {
      return res.status(404).json({ error: 'Task not found' });
    }

    tasks = tasks.filter(t => t.id !== req.params.id);
    fs.writeFileSync(configPath, JSON.stringify(tasks, null, 2), 'utf8');

    // Clean up state if it exists
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state[req.params.id]) {
        delete state[req.params.id];
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
      }
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

// Run a task manually (immediate test execution)
app.post('/api/tasks/:id/run', async (req, res) => {
  try {
    const tasks = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const task = tasks.find(t => t.id === req.params.id);
    
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Run runner.js in manual mode or run logic inline
    // Inline execution for immediate UI feedback
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    const geminiApiKey = process.env.GEMINI_API_KEY;

    const channels = task.channels || ['telegram'];
    
    // Check missing credentials for active channels
    if (channels.includes('telegram') && (!botToken || !chatId)) {
      return res.status(400).json({ error: 'Telegram credentials are not configured in Settings.' });
    }
    if (channels.includes('discord') && !process.env.DISCORD_WEBHOOK_URL) {
      return res.status(400).json({ error: 'Discord Webhook URL is not configured in Settings.' });
    }
    if (channels.includes('slack') && !process.env.SLACK_WEBHOOK_URL) {
      return res.status(400).json({ error: 'Slack Webhook URL is not configured in Settings.' });
    }

    // Web Scraping context
    let promptText = task.prompt || '';
    if (task.url && task.type === 'ai') {
      try {
        const pageText = await scrapeWebpage(task.url);
        promptText = `Context from webpage (${task.url}):\n---\n${pageText}\n---\n\nUser Request: ${task.prompt}`;
      } catch (scrapeErr) {
        logDebug(`Proceeding without webpage content due to scrape error: ${scrapeErr.message}`);
        promptText = `[Note: Unable to fetch live content from ${task.url} due to error: ${scrapeErr.message}]\n\nUser Request: ${task.prompt}`;
      }
    }

    let alertMessage = '';
    if (task.type === 'ai') {
      if (!geminiApiKey) {
        return res.status(400).json({ error: 'Gemini API Key is not configured in local Settings.' });
      }

      // Query Gemini
      const systemInstruction = `You are a helpful automation assistant. Return a concise, clear alert or summary according to the user request. Make it look beautiful on a phone screen. Use Markdown formatting when appropriate. Keep the response under 1500 characters.`;
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`;
      
      const response = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemInstruction}\n\nUser Request: ${promptText}` }] }]
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API returned status ${response.status}: ${errText}`);
      }

      const data = await response.json();
      alertMessage = data.candidates?.[0]?.content?.parts?.[0]?.text;
    } else {
      alertMessage = task.prompt;
    }

    if (!alertMessage) {
      throw new Error('Generated content was empty.');
    }

    // Deliver to selected channels
    const deliveryErrors = [];

    if (channels.includes('telegram')) {
      try {
        const formattedText = `🔔 *Manual Run: ${task.name}*\n\n${alertMessage}`;
        const tgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
        let tgRes = await fetch(tgUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: formattedText,
            parse_mode: 'Markdown',
          })
        });
        if (!tgRes.ok) {
          const errorData = await tgRes.json();
          if (errorData.description && errorData.description.includes('can\'t parse')) {
            const plainText = `🔔 Manual Run: ${task.name}\n\n${alertMessage}`;
            tgRes = await fetch(tgUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text: plainText })
            });
          }
        }
        if (!tgRes.ok) throw new Error(`Telegram returned status ${tgRes.status}`);
      } catch (err) {
        deliveryErrors.push(`Telegram: ${err.message}`);
      }
    }

    if (channels.includes('discord')) {
      try {
        const discordUrl = process.env.DISCORD_WEBHOOK_URL;
        const formattedText = `🔔 **Manual Run: ${task.name}**\n\n${alertMessage}`;
        const res = await fetch(discordUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: formattedText })
        });
        if (!res.ok) throw new Error(`Discord returned status ${res.status}`);
      } catch (err) {
        deliveryErrors.push(`Discord: ${err.message}`);
      }
    }

    if (channels.includes('slack')) {
      try {
        const slackUrl = process.env.SLACK_WEBHOOK_URL;
        const formattedText = `🔔 *Manual Run: ${task.name}*\n\n${alertMessage}`;
        const res = await fetch(slackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: formattedText })
        });
        if (!res.ok) throw new Error(`Slack returned status ${res.status}`);
      } catch (err) {
        deliveryErrors.push(`Slack: ${err.message}`);
      }
    }

    if (deliveryErrors.length > 0) {
      throw new Error(`Delivery failures: ${deliveryErrors.join(', ')}`);
    }

    // Update state last run
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      state[task.id] = Date.now();
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    }

    // Write to logs
    const logEntry = {
      timestamp: new Date().toISOString(),
      taskId: task.id,
      taskName: task.name,
      schedule: task.schedule,
      status: 'success',
      output: '[Manual Run] ' + alertMessage.substring(0, 150) + (alertMessage.length > 150 ? '...' : ''),
    };

    let existingLogs = [];
    if (fs.existsSync(logsPath)) {
      existingLogs = JSON.parse(fs.readFileSync(logsPath, 'utf8'));
    }
    const combinedLogs = [logEntry, ...existingLogs].slice(0, 200);
    fs.writeFileSync(logsPath, JSON.stringify(combinedLogs, null, 2), 'utf8');

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

// Get logs
app.get('/api/logs', (req, res) => {
  try {
    if (fs.existsSync(logsPath)) {
      const data = JSON.parse(fs.readFileSync(logsPath, 'utf8'));
      res.json(data);
    } else {
      res.json([]);
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to read logs: ' + err.message });
  }
});

// Get local settings
app.get('/api/settings', (req, res) => {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    
    // Mask sensitive keys for safety
    const botTokenMasked = process.env.TELEGRAM_BOT_TOKEN 
      ? process.env.TELEGRAM_BOT_TOKEN.substring(0, 6) + '...' + process.env.TELEGRAM_BOT_TOKEN.substring(process.env.TELEGRAM_BOT_TOKEN.length - 4)
      : '';
    const chatIdMasked = process.env.TELEGRAM_CHAT_ID 
      ? process.env.TELEGRAM_CHAT_ID.substring(0, 3) + '...' + process.env.TELEGRAM_CHAT_ID.substring(process.env.TELEGRAM_CHAT_ID.length - 2)
      : '';
    const geminiKeyMasked = process.env.GEMINI_API_KEY 
      ? process.env.GEMINI_API_KEY.substring(0, 4) + '...' + process.env.GEMINI_API_KEY.substring(process.env.GEMINI_API_KEY.length - 4)
      : '';
    const discordUrlMasked = process.env.DISCORD_WEBHOOK_URL
      ? process.env.DISCORD_WEBHOOK_URL.substring(0, 15) + '...' + process.env.DISCORD_WEBHOOK_URL.substring(process.env.DISCORD_WEBHOOK_URL.length - 8)
      : '';
    const slackUrlMasked = process.env.SLACK_WEBHOOK_URL
      ? process.env.SLACK_WEBHOOK_URL.substring(0, 15) + '...' + process.env.SLACK_WEBHOOK_URL.substring(process.env.SLACK_WEBHOOK_URL.length - 8)
      : '';

    res.json({
      credentialsConfigured: {
        telegramBotToken: !!process.env.TELEGRAM_BOT_TOKEN,
        telegramChatId: !!process.env.TELEGRAM_CHAT_ID,
        geminiApiKey: !!process.env.GEMINI_API_KEY,
        discordWebhookUrl: !!process.env.DISCORD_WEBHOOK_URL,
        slackWebhookUrl: !!process.env.SLACK_WEBHOOK_URL
      },
      masked: {
        telegramBotToken: botTokenMasked,
        telegramChatId: chatIdMasked,
        geminiApiKey: geminiKeyMasked,
        discordWebhookUrl: discordUrlMasked,
        slackWebhookUrl: slackUrlMasked
      },
      autoSync: settings.autoSync
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read settings: ' + err.message });
  }
});

// Helper to ignore masked placeholders or empty autofills when saving settings
function getCleanCredential(newValue, existingValue) {
  if (!newValue || newValue.includes('...')) {
    return existingValue || '';
  }
  return newValue.trim();
}

// Update settings & credentials
app.post('/api/settings', (req, res) => {
  try {
    // 1. Save settings
    const settings = {
      autoSync: !!req.body.autoSync
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

    // 2. Save credentials in .env if provided
    let envContent = '';
    const token = getCleanCredential(req.body.telegramBotToken, process.env.TELEGRAM_BOT_TOKEN);
    const chat = getCleanCredential(req.body.telegramChatId, process.env.TELEGRAM_CHAT_ID);
    const gemini = getCleanCredential(req.body.geminiApiKey, process.env.GEMINI_API_KEY);
    const discord = getCleanCredential(req.body.discordWebhookUrl, process.env.DISCORD_WEBHOOK_URL);
    const slack = getCleanCredential(req.body.slackWebhookUrl, process.env.SLACK_WEBHOOK_URL);

    envContent += `TELEGRAM_BOT_TOKEN=${token}\n`;
    envContent += `TELEGRAM_CHAT_ID=${chat}\n`;
    envContent += `GEMINI_API_KEY=${gemini}\n`;
    envContent += `DISCORD_WEBHOOK_URL=${discord}\n`;
    envContent += `SLACK_WEBHOOK_URL=${slack}\n`;

    fs.writeFileSync(envPath, envContent, 'utf8');

    // Reload process env variables
    process.env.TELEGRAM_BOT_TOKEN = token;
    process.env.TELEGRAM_CHAT_ID = chat;
    process.env.GEMINI_API_KEY = gemini;
    process.env.DISCORD_WEBHOOK_URL = discord;
    process.env.SLACK_WEBHOOK_URL = slack;

    res.json({ success: true, message: 'Settings saved successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save settings: ' + err.message });
  }
});

// Send a test Telegram alert
app.post('/api/test-telegram', async (req, res) => {
  const token = req.body.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN;
  const chat = req.body.telegramChatId || process.env.TELEGRAM_CHAT_ID;

  if (!token || !chat) {
    return res.status(400).json({ error: 'Telegram Bot Token and Chat ID are required to send test message.' });
  }

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text: '🔔 *Telegram Cron Alerts Setup*\n\nYour bot has been successfully configured! You will receive automated alerts here.',
        parse_mode: 'Markdown'
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Telegram API status ${response.status}: ${errText}`);
    }

    res.json({ success: true, message: 'Test message sent successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Telegram test failed: ' + err.message });
  }
});

// Send a test Discord alert
app.post('/api/test-discord', async (req, res) => {
  const url = req.body.discordWebhookUrl || process.env.DISCORD_WEBHOOK_URL;

  if (!url) {
    return res.status(400).json({ error: 'Discord Webhook URL is required to send test message.' });
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '🔔 **Discord Webhook Connection Success**\n\nYour Discord alert channel has been successfully configured!'
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Discord Webhook returned status ${response.status}: ${errText}`);
    }

    res.json({ success: true, message: 'Test message sent to Discord!' });
  } catch (err) {
    res.status(500).json({ error: 'Discord test failed: ' + err.message });
  }
});

// Send a test Slack alert
app.post('/api/test-slack', async (req, res) => {
  const url = req.body.slackWebhookUrl || process.env.SLACK_WEBHOOK_URL;

  if (!url) {
    return res.status(400).json({ error: 'Slack Webhook URL is required to send test message.' });
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: '🔔 *Slack Webhook Connection Success*\n\nYour Slack alert channel has been successfully configured!'
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Slack Webhook returned status ${response.status}: ${errText}`);
    }

    res.json({ success: true, message: 'Test message sent to Slack!' });
  } catch (err) {
    res.status(500).json({ error: 'Slack test failed: ' + err.message });
  }
});

// Force git sync manual endpoint
app.post('/api/git/sync', async (req, res) => {
  try {
    const result = await gitSync();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shutdown API server
app.post('/api/shutdown', (req, res) => {
  res.json({ success: true, message: 'Server is shutting down...' });
  logDebug('Shutting down Express server as requested by UI.');
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

// Serve frontend React static build in production
if (fs.existsSync(frontendDistPath)) {
  app.use(express.static(frontendDistPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDistPath, 'index.html'));
  });
}

// Start Express server
app.listen(PORT, () => {
  logDebug(`Local Configuration UI Server started on http://localhost:${PORT}`);
  
  // Auto-open browser in production mode (when dist exists)
  if (fs.existsSync(frontendDistPath) && process.env.NODE_ENV !== 'development') {
    exec(`start http://localhost:${PORT}`);
  }
});
