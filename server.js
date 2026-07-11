const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const dotenv = require('dotenv');
const parser = require('cron-parser');


const app = express();
const PORT = process.env.PORT || 3001;

function logDebug(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// Fetch wrapper with automatic retries and exponential backoff for network resilience
async function fetchWithRetry(url, options = {}, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      return response;
    } catch (err) {
      if (i === retries - 1) throw err;
      logDebug(`Fetch connection error: ${err.message}. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
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

    // 3. Pull with rebase from remote counterpart. Auto-stash dirty working changes, pull, and pop stash.
    let stashed = false;
    try {
      const status = await runCmd('git status --porcelain');
      // Check if there are unstaged changes (staged ones are committed above)
      if (status.trim()) {
        await runCmd('git stash -u');
        stashed = true;
      }
      await runCmd('git -c core.editor=true pull --rebase -X ours origin HEAD');
    } finally {
      if (stashed) {
        try {
          await runCmd('git stash pop');
        } catch (stashErr) {
          console.error('Stash pop warning:', stashErr.message);
        }
      }
    }
    
    // 4. Push changes back
    await runCmd('git push origin HEAD');
    return { synced: true, message: 'Configurations successfully synced to GitHub.' };
  } catch (err) {
    console.error('Git sync error:', err.message);
    throw new Error(`Git sync failed: ${err.message}`);
  }
}

// Get vector embedding from Google Gemini API
async function getGeminiEmbedding(text, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`;
  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: {
        parts: [{ text: text }]
      }
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini Embedding API returned status ${response.status}: ${errText}`);
  }
  const data = await response.json();
  const values = data.embedding?.values;
  if (!values) throw new Error('Empty embedding values from Gemini');
  return values;
}

// Get vector embedding from OpenAI API
async function getOpenAiEmbedding(text, apiKey) {
  const url = 'https://api.openai.com/v1/embeddings';
  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      input: text,
      model: 'text-embedding-3-small'
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI Embedding API returned status ${response.status}: ${errText}`);
  }
  const data = await response.json();
  const values = data.data?.[0]?.embedding;
  if (!values) throw new Error('Empty embedding values from OpenAI');
  return values;
}

// Generic embedding retriever with error handling
async function getEmbedding(text, apiKey) {
  if (!apiKey || !text) return null;
  try {
    if (apiKey.startsWith('sk-')) {
      return await getOpenAiEmbedding(text, apiKey);
    } else if (!apiKey.startsWith('gsk_')) {
      return await getGeminiEmbedding(text, apiKey);
    }
  } catch (err) {
    logDebug(`Warning: Embedding generation failed (${err.message}). Falling back to local similarity.`);
  }
  return null;
}

// Calculate Cosine Similarity between two numerical vectors
function calculateCosineSimilarity(vec1, vec2) {
  if (!vec1 || !vec2 || vec1.length !== vec2.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vec1.length; i++) {
    dotProduct += vec1[i] * vec2[i];
    normA += vec1[i] * vec1[i];
    normB += vec2[i] * vec2[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Local word-frequency Cosine similarity fallback
function calculateLocalSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  const tokenize = text => text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 0);
  const words1 = tokenize(str1);
  const words2 = tokenize(str2);
  if (words1.length === 0 || words2.length === 0) return 0;
  const freq1 = {};
  const freq2 = {};
  const allWords = new Set([...words1, ...words2]);
  words1.forEach(w => freq1[w] = (freq1[w] || 0) + 1);
  words2.forEach(w => freq2[w] = (freq2[w] || 0) + 1);
  let dotProduct = 0, mag1 = 0, mag2 = 0;
  allWords.forEach(w => {
    const v1 = freq1[w] || 0;
    const v2 = freq2[w] || 0;
    dotProduct += v1 * v2;
    mag1 += v1 * v1;
    mag2 += v2 * v2;
  });
  if (mag1 === 0 || mag2 === 0) return 0;
  return dotProduct / (Math.sqrt(mag1) * Math.sqrt(mag2));
}

// Scrape webpage context using Jina Reader (with local raw HTML parser fallback)
async function scrapeWebpage(url) {
  logDebug(`Scraping webpage: ${url}`);
  
  // 1. Try Jina Reader first for ultra-clean Markdown context
  try {
    logDebug(`Attempting clean markdown scrape via Jina Reader for: ${url}`);
    const jinaResponse = await fetch(`https://r.jina.ai/${url}`, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': 'Telegram-Cron-Alerts-Scraper/1.0'
      }
    });
    
    if (jinaResponse.ok) {
      const text = await jinaResponse.text();
      if (text && text.trim().length > 100) {
        logDebug(`Jina Reader scrape successful! Length: ${text.length} chars.`);
        return text.trim().substring(0, 15000); // Truncate to avoid context window blowouts
      }
    }
    logDebug(`Jina Reader returned empty or non-200 status: ${jinaResponse.status}. Falling back to raw HTML scraper.`);
  } catch (jinaErr) {
    logDebug(`Jina Reader failed: ${jinaErr.message}. Falling back to raw HTML scraper.`);
  }

  // 2. Raw HTML scraper fallback
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000), // 10s scraping timeout limit
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
    
    if (text.length === 0) {
      throw new Error('Webpage returned empty text content.');
    }
    
    // Limit to 5000 characters for fallback
    return text.substring(0, 5000);
  } catch (err) {
    logDebug(`Raw HTML scraping failed: ${err.message}`);
    throw new Error(`Failed to scrape ${url}: ${err.message}`);
  }
}

async function executeAiPrompt(prompt, apiKey) {
  logDebug(`Calling Gemini API for prompt...`);
  const systemInstruction = `You are a helpful automation assistant. Return a concise, clear alert or summary according to the user request. Make it look beautiful on a phone screen. Use Markdown formatting when appropriate. Keep the response under 1500 characters.`;
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  
  const response = await fetchWithRetry(geminiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${systemInstruction}\n\nUser Request: ${prompt}` }] }],
      tools: [{ googleSearch: {} }]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API returned status ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  
  if (!generatedText) {
    throw new Error('Gemini API returned empty response structure.');
  }

  return generatedText.trim();
}

async function executeOpenAiCompatiblePrompt(prompt, apiKey, url, model) {
  logDebug(`Calling OpenAI-compatible API at ${url} (model: ${model})...`);
  const systemInstruction = `You are a helpful automation assistant. Return a concise, clear alert or summary according to the user request. Make it look beautiful on a phone screen. Use Markdown formatting when appropriate. Keep the response under 1500 characters.`;

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
      deduplicate: !!req.body.deduplicate,
      threshold: req.body.threshold !== undefined ? parseFloat(req.body.threshold) : 0.90,
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
      deduplicate: req.body.deduplicate !== undefined ? !!req.body.deduplicate : tasks[index].deduplicate,
      threshold: req.body.threshold !== undefined ? parseFloat(req.body.threshold) : (tasks[index].threshold !== undefined ? tasks[index].threshold : 0.90),
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
    if (task.type === 'ai') {
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
          logDebug(`Manual run: Auto-scraped Google News RSS search query for: "${task.name}"`);
          promptText = `Context from news search:\n---\n${pageText}\n---\n\nUser Request: ${task.prompt}`;
        } else {
          promptText = `Context from webpage (${targetUrl}):\n---\n${pageText}\n---\n\nUser Request: ${task.prompt}`;
        }
      } catch (scrapeErr) {
        logDebug(`Proceeding without webpage content due to scrape error: ${scrapeErr.message}`);
        promptText = `[Note: Unable to fetch live content from ${targetUrl || 'default news'} due to error: ${scrapeErr.message}]\n\nUser Request: ${task.prompt}`;
      }
    }

    let alertMessage = '';
    if (task.type === 'ai') {
      if (!geminiApiKey) {
        return res.status(400).json({ error: 'AI API Key is not configured in Settings.' });
      }

      const customUrl = process.env.CUSTOM_API_ENDPOINT;
      const customModel = process.env.CUSTOM_AI_MODEL;

      if (customUrl) {
        const modelName = customModel || 'gpt-4o-mini';
        alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, customUrl, modelName);
      } else if (geminiApiKey.startsWith('gsk_')) {
        alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, 'https://api.groq.com/openai/v1/chat/completions', 'llama-3.3-70b-versatile');
      } else if (geminiApiKey.startsWith('sk-')) {
        alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, 'https://api.openai.com/v1/chat/completions', 'gpt-4o-mini');
      } else {
        alertMessage = await executeAiPrompt(promptText, geminiApiKey);
      }
    } else {
      alertMessage = task.prompt;
    }

    // Retrieve deduplication config
    let shouldSkip = false;
    let similarityScore = 0;
    let newVector = null;
    let prevText = null;
    let prevVector = null;

    let state = {};
    if (fs.existsSync(statePath)) {
      try {
        state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      } catch (e) {
        logDebug('Error parsing state in manual run');
      }
    }

    if (task.deduplicate && task.type === 'ai') {
      const taskState = state[task.id];
      if (taskState && typeof taskState === 'object') {
        prevText = taskState.lastAlertText;
        prevVector = taskState.lastEmbedding;
      }
      
      if (prevText) {
        // Get embedding of new candidate alert message
        newVector = await getEmbedding(alertMessage, geminiApiKey);
        
        if (newVector && prevVector && Array.isArray(newVector) && Array.isArray(prevVector)) {
          similarityScore = calculateCosineSimilarity(newVector, prevVector);
          logDebug(`Semantic similarity (Manual Run Neural): ${Math.round(similarityScore * 100)}%`);
        } else {
          similarityScore = calculateLocalSimilarity(alertMessage, prevText);
          logDebug(`Semantic similarity (Manual Run Local Fallback): ${Math.round(similarityScore * 100)}%`);
        }
        
        const threshold = task.threshold !== undefined ? task.threshold : 0.90;
        if (similarityScore >= threshold) {
          shouldSkip = true;
        }
      }
    }

    if (shouldSkip) {
      logDebug(`Skipping alert delivery for manual run task "${task.name}". Similarity is above threshold (${Math.round(similarityScore * 100)}% >= ${Math.round((task.threshold || 0.90) * 100)}%).`);
      
      // Update state: retain previous baseline
      state[task.id] = {
        lastRun: Date.now(),
        lastAlertText: prevText,
        lastEmbedding: prevVector
      };
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

      // Write skipped log
      const logEntry = {
        timestamp: new Date().toISOString(),
        taskId: task.id,
        taskName: task.name,
        schedule: task.schedule,
        status: 'skipped',
        output: `[Manual Run Skipped] Similarity (${Math.round(similarityScore * 100)}%) is above threshold.`
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

      return res.json({ 
        success: true, 
        message: `Alert skipped (similarity ${Math.round(similarityScore * 100)}% is above threshold).`, 
        sync: syncStatus 
      });
    }

    // Generate new embedding vector if we haven't already
    if (task.deduplicate && task.type === 'ai' && !newVector) {
      newVector = await getEmbedding(alertMessage, geminiApiKey);
    }

    // Deliver to selected channels
    const deliveryErrors = [];

    if (channels.includes('telegram')) {
      try {
        const formattedText = `🔔 *Manual Run: ${task.name}*\n\n${alertMessage}`;
        const tgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
        let tgRes = await fetchWithRetry(tgUrl, {
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
            tgRes = await fetchWithRetry(tgUrl, {
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
        const res = await fetchWithRetry(discordUrl, {
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
        const res = await fetchWithRetry(slackUrl, {
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
    state[task.id] = {
      lastRun: Date.now(),
      lastAlertText: alertMessage,
      lastEmbedding: newVector
    };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

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

// Validate cron expression and return next 3 run times in timezone
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

// Helper to parse GitHub repo path from git remote URL
function getGitRepoPath() {
  return new Promise((resolve) => {
    exec('git config --get remote.origin.url', (err, stdout) => {
      if (err || !stdout) {
        return resolve('');
      }
      const url = stdout.trim();
      const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
      resolve(match ? match[1] : '');
    });
  });
}

// Get local settings
app.get('/api/settings', async (req, res) => {
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
      customApiEndpoint: process.env.CUSTOM_API_ENDPOINT || '',
      customAiModel: process.env.CUSTOM_AI_MODEL || '',
      timezone: process.env.TIMEZONE || 'UTC',
      autoSync: settings.autoSync,
      githubRepoPath: (await getGitRepoPath()) || ''
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read settings: ' + err.message });
  }
});

// Trigger a test workflow dispatch on GitHub
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

// Enhance a user prompt using LLM
app.post('/api/prompt/enhance', async (req, res) => {
  const { prompt, url } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt content is required' });
  }

  const geminiApiKey = process.env.GEMINI_API_KEY;
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
    const customUrl = process.env.CUSTOM_API_ENDPOINT;
    const customModel = process.env.CUSTOM_AI_MODEL;

    if (customUrl) {
      const modelName = customModel || 'gpt-4o-mini';
      enhancedText = await executeOpenAiCompatiblePrompt(instructionPrompt, geminiApiKey, customUrl, modelName);
    } else if (geminiApiKey.startsWith('gsk_')) {
      enhancedText = await executeOpenAiCompatiblePrompt(instructionPrompt, geminiApiKey, 'https://api.groq.com/openai/v1/chat/completions', 'llama-3.3-70b-versatile');
    } else if (geminiApiKey.startsWith('sk-')) {
      enhancedText = await executeOpenAiCompatiblePrompt(instructionPrompt, geminiApiKey, 'https://api.openai.com/v1/chat/completions', 'gpt-4o-mini');
    } else {
      enhancedText = await executeAiPrompt(instructionPrompt, geminiApiKey);
    }

    res.json({ success: true, enhancedPrompt: enhancedText.trim() });
  } catch (err) {
    res.status(500).json({ error: 'Enhancement failed: ' + err.message });
  }
});

// Preview scraped webpage text using configured scraper
app.post('/api/scrape/preview', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required for preview.' });
  }
  try {
    const text = await scrapeWebpage(url);
    res.json({ success: true, text });
  } catch (err) {
    res.status(500).json({ error: 'Failed to preview scrape: ' + err.message });
  }
});

// Simulate AI prompt execution against a URL scrape outcome
app.post('/api/prompt/simulate', async (req, res) => {
  const { url, prompt, type, name } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt instructions are required.' });
  }

  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (type === 'ai' && !geminiApiKey) {
    return res.status(400).json({ error: 'AI API Key is not configured in Settings.' });
  }

  try {
    let promptText = prompt;
    if (type === 'ai') {
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
          logDebug(`Simulation: Auto-scraped Google News RSS search query for: "${name || 'unnamed'}"`);
          promptText = `Context from news search:\n---\n${pageText}\n---\n\nUser Request: ${prompt}`;
        } else {
          promptText = `Context from webpage (${targetUrl}):\n---\n${pageText}\n---\n\nUser Request: ${prompt}`;
        }
      } catch (scrapeErr) {
        promptText = `[Note: Scraper failed to fetch page content: ${scrapeErr.message}]\n\nUser Request: ${prompt}`;
      }
    }

    let alertMessage = '';
    if (type === 'ai') {
      const customUrl = process.env.CUSTOM_API_ENDPOINT;
      const customModel = process.env.CUSTOM_AI_MODEL;

      if (customUrl) {
        const modelName = customModel || 'gpt-4o-mini';
        alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, customUrl, modelName);
      } else if (geminiApiKey.startsWith('gsk_')) {
        alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, 'https://api.groq.com/openai/v1/chat/completions', 'llama-3.3-70b-versatile');
      } else if (geminiApiKey.startsWith('sk-')) {
        alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, 'https://api.openai.com/v1/chat/completions', 'gpt-4o-mini');
      } else {
        alertMessage = await executeAiPrompt(promptText, geminiApiKey);
      }
    } else {
      alertMessage = prompt;
    }

    res.json({ success: true, alertMessage });
  } catch (err) {
    res.status(500).json({ error: 'Simulation failed: ' + err.message });
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
    const customApiEndpoint = (req.body.customApiEndpoint !== undefined ? req.body.customApiEndpoint : (process.env.CUSTOM_API_ENDPOINT || '')).trim();
    const customAiModel = (req.body.customAiModel !== undefined ? req.body.customAiModel : (process.env.CUSTOM_AI_MODEL || '')).trim();
    const timezone = (req.body.timezone !== undefined ? req.body.timezone : (process.env.TIMEZONE || 'UTC')).trim();

    envContent += `TELEGRAM_BOT_TOKEN=${token}\n`;
    envContent += `TELEGRAM_CHAT_ID=${chat}\n`;
    envContent += `GEMINI_API_KEY=${gemini}\n`;
    envContent += `DISCORD_WEBHOOK_URL=${discord}\n`;
    envContent += `SLACK_WEBHOOK_URL=${slack}\n`;
    envContent += `CUSTOM_API_ENDPOINT=${customApiEndpoint}\n`;
    envContent += `CUSTOM_AI_MODEL=${customAiModel}\n`;
    envContent += `TIMEZONE=${timezone}\n`;

    fs.writeFileSync(envPath, envContent, 'utf8');

    // Reload process env variables
    process.env.TELEGRAM_BOT_TOKEN = token;
    process.env.TELEGRAM_CHAT_ID = chat;
    process.env.GEMINI_API_KEY = gemini;
    process.env.DISCORD_WEBHOOK_URL = discord;
    process.env.SLACK_WEBHOOK_URL = slack;
    process.env.CUSTOM_API_ENDPOINT = customApiEndpoint;
    process.env.CUSTOM_AI_MODEL = customAiModel;
    process.env.TIMEZONE = timezone;

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
    const response = await fetchWithRetry(url, {
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
    const response = await fetchWithRetry(url, {
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
    const response = await fetchWithRetry(url, {
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
