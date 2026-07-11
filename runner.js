const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const cronParser = require('cron-parser');

// Load environment variables locally
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

// Constants for preset schedules (in milliseconds) - Deprecated in favor of cron but kept for reference
const INTERVALS = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '5h': 5 * 60 * 60 * 1000,
  'daily': 24 * 60 * 60 * 1000,
  'weekly': 7 * 24 * 60 * 60 * 1000,
  'monthly': 30 * 24 * 60 * 60 * 1000,
};

// Map preset frequency strings to cron expressions
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

// Max history logs to keep in logs/history.json
const MAX_LOGS = 200;

// Load config, state, and credentials
const configPath = path.join(__dirname, 'tasks.json');
const statePath = path.join(__dirname, 'state.json');
const logsDir = path.join(__dirname, 'logs');
const logsPath = path.join(logsDir, 'history.json');

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const geminiApiKey = process.env.GEMINI_API_KEY;

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

async function run() {
  logDebug('Starting Alert Runner...');

  // Load tasks configuration
  if (!fs.existsSync(configPath)) {
    logDebug('No tasks.json configuration file found. Exiting.');
    return;
  }
  
  let tasks = [];
  try {
    tasks = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error('Error reading or parsing tasks.json:', err.message);
    process.exit(1);
  }

  // Load scheduler states
  let state = {};
  if (fs.existsSync(statePath)) {
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (err) {
      logDebug(`Warning: Could not parse state.json (${err.message}). Starting with empty state.`);
    }
  }

  // Process tasks
  const now = Date.now();
  let stateChanged = false;
  const executionLogs = [];

  await Promise.all(tasks.map(async (task) => {
    if (!task.active) {
      return;
    }

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
      logDebug(`Warning: Task "${task.name}" has invalid cron schedule "${task.schedule}" / "${cronExpr}": ${cronErr.message}. Skipping.`);
      return;
    }

    if (isDue) {
      logDebug(`Executing Task: "${task.name}" (${task.schedule})`);
      const logEntry = {
        timestamp: new Date().toISOString(),
        taskId: task.id,
        taskName: task.name,
        schedule: task.schedule,
        status: 'pending',
        output: '',
      };

      try {
        let promptText = task.prompt || '';
        
        // Fetch scraped webpage context if URL is provided
        if (task.url && task.type === 'ai') {
          try {
            const pageContext = await scrapeWebpage(task.url);
            promptText = `Context from webpage (${task.url}):\n---\n${pageContext}\n---\n\nUser Request: ${task.prompt}`;
          } catch (scrapeErr) {
            logDebug(`Proceeding without webpage content due to scrape error.`);
            promptText = `[Note: Unable to fetch live content from ${task.url} due to error: ${scrapeErr.message}]\n\nUser Request: ${task.prompt}`;
          }
        }

        let alertMessage = '';

        if (task.type === 'ai') {
          if (!geminiApiKey) {
            throw new Error('AI API Key (GEMINI_API_KEY environment variable) is not configured.');
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
            alertMessage = await executeAiPrompt(promptText);
          }
        } else {
          alertMessage = task.prompt || 'No message content defined.';
        }

        // Retrieve deduplication config
        let shouldSkip = false;
        let similarityScore = 0;
        let newVector = null;
        let prevText = null;
        let prevVector = null;

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
              logDebug(`Semantic similarity (Neural): ${Math.round(similarityScore * 100)}%`);
            } else {
              similarityScore = calculateLocalSimilarity(alertMessage, prevText);
              logDebug(`Semantic similarity (Local Fallback): ${Math.round(similarityScore * 100)}%`);
            }
            
            const threshold = task.threshold !== undefined ? task.threshold : 0.90;
            if (similarityScore >= threshold) {
              shouldSkip = true;
            }
          }
        }

        if (shouldSkip) {
          logDebug(`Skipping alert delivery for task "${task.name}". Similarity is above threshold (${Math.round(similarityScore * 100)}% >= ${Math.round((task.threshold || 0.90) * 100)}%).`);
          
          logEntry.status = 'skipped';
          logEntry.output = `[Skipped] Similarity (${Math.round(similarityScore * 100)}%) is above threshold.`;
          
          // Update state: update lastRun but retain previous alert and vector as baseline
          state[task.id] = {
            lastRun: now,
            lastAlertText: prevText,
            lastEmbedding: prevVector,
            consecutiveFailures: 0
          };
          stateChanged = true;
        } else {
          // Generate new embedding vector if we haven't already
          if (task.deduplicate && task.type === 'ai' && !newVector) {
            newVector = await getEmbedding(alertMessage, geminiApiKey);
          }

          // Deliver alerts through selected channels
          const channels = task.channels || ['telegram'];
          const deliveryErrors = [];

          if (channels.includes('telegram')) {
            if (!botToken || !chatId) {
              deliveryErrors.push('Telegram Bot Token or Chat ID is missing');
            } else {
              try {
                await sendTelegramMessage(alertMessage, task.name);
              } catch (err) {
                deliveryErrors.push(`Telegram: ${err.message}`);
              }
            }
          }

          if (channels.includes('discord')) {
            const discordUrl = process.env.DISCORD_WEBHOOK_URL;
            if (!discordUrl) {
              deliveryErrors.push('DISCORD_WEBHOOK_URL secret is missing');
            } else {
              try {
                await sendDiscordMessage(alertMessage, task.name, discordUrl);
              } catch (err) {
                deliveryErrors.push(`Discord: ${err.message}`);
              }
            }
          }

          if (channels.includes('slack')) {
            const slackUrl = process.env.SLACK_WEBHOOK_URL;
            if (!slackUrl) {
              deliveryErrors.push('SLACK_WEBHOOK_URL secret is missing');
            } else {
              try {
                await sendSlackMessage(alertMessage, task.name, slackUrl);
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
          
          // Update state: store timestamp, text, vector, and reset consecutive failures
          state[task.id] = {
            lastRun: now,
            lastAlertText: alertMessage,
            lastEmbedding: newVector,
            consecutiveFailures: 0
          };
          stateChanged = true;
        }
      } catch (err) {
        console.error(`Error executing task "${task.name}":`, err.message);
        logEntry.status = 'error';
        logEntry.output = `Error: ${err.message}`;
        
        const failures = (taskState && typeof taskState === 'object') ? (taskState.consecutiveFailures || 0) + 1 : 1;
        
        // Still update state lastRun to avoid infinitely retrying a broken prompt on every cron run
        state[task.id] = {
          lastRun: now,
          lastAlertText: prevText,
          lastEmbedding: prevVector,
          consecutiveFailures: failures
        };
        stateChanged = true;

        if (failures === 3) {
          logDebug(`[Self-Monitoring] Task "${task.name}" failed 3 consecutive times. Dispatching system alert.`);
          // Send system diagnostic alert (non-blocking, logs its own errors)
          await sendSystemDiagnosticAlert(task, err.message);
        }
      }

      executionLogs.push(logEntry);
    } else {
      try {
        const cronExpr = getCronExpression(task.schedule);
        const tz = process.env.TIMEZONE || 'UTC';
        const parsedInterval = cronParser.CronExpressionParser.parse(cronExpr, { tz });
        const nextRunTime = parsedInterval.next().toDate();
        logDebug(`Task "${task.name}" is not due. Next run at: ${nextRunTime.toISOString()} (${tz})`);
      } catch (e) {
        logDebug(`Task "${task.name}" is not due.`);
      }
    }
  }));

  // Write updated states and logs
  if (stateChanged) {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    logDebug('Saved updated state.json');
  }

  if (executionLogs.length > 0) {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    let existingLogs = [];
    if (fs.existsSync(logsPath)) {
      try {
        existingLogs = JSON.parse(fs.readFileSync(logsPath, 'utf8'));
      } catch (err) {
        logDebug(`Warning: Could not parse logs history (${err.message}). Resetting.`);
      }
    }

    // Add new logs at the beginning (newest first)
    const combinedLogs = [...executionLogs, ...existingLogs].slice(0, MAX_LOGS);
    fs.writeFileSync(logsPath, JSON.stringify(combinedLogs, null, 2), 'utf8');
    logDebug(`Logged ${executionLogs.length} execution results.`);
  }

  logDebug('Alert Runner Finished.');
}

// Send system diagnostics when a task breaks repeatedly in the cloud
async function sendSystemDiagnosticAlert(task, errorMessage) {
  const channels = task.channels || ['telegram'];
  const systemMsg = `⚠️ [AuraVigil System Alert]\nTask "${task.name}" has failed 3 consecutive times.\n\nLatest Error: ${errorMessage}`;
  
  if (channels.includes('telegram') && botToken && chatId) {
    try {
      await sendTelegramMessage(systemMsg, 'AuraVigil System Diagnostic');
    } catch (e) {
      logDebug(`Failed to deliver Telegram system alert: ${e.message}`);
    }
  }
  
  const discordUrl = process.env.DISCORD_WEBHOOK_URL;
  if (channels.includes('discord') && discordUrl) {
    try {
      await sendDiscordMessage(systemMsg, 'AuraVigil System Diagnostic', discordUrl);
    } catch (e) {
      logDebug(`Failed to deliver Discord system alert: ${e.message}`);
    }
  }
  
  const slackUrl = process.env.SLACK_WEBHOOK_URL;
  if (channels.includes('slack') && slackUrl) {
    try {
      await sendSlackMessage(systemMsg, 'AuraVigil System Diagnostic', slackUrl);
    } catch (e) {
      logDebug(`Failed to deliver Slack system alert: ${e.message}`);
    }
  }
}

async function executeAiPrompt(prompt) {
  logDebug(`Calling Gemini API for prompt...`);
  const systemInstruction = `You are a helpful automation assistant. Return a concise, clear alert or summary according to the user request. Make it look beautiful on a phone screen. Use Markdown formatting when appropriate (bold, bullet points, emoji). Keep the response under 1500 characters.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`;
  
  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: `${systemInstruction}\n\nUser Request: ${prompt}` }]
      }]
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

async function sendTelegramMessage(text, taskName) {
  logDebug(`Sending Telegram alert...`);
  
  // Format message with a header
  const formattedText = `🔔 *Alert: ${taskName}*\n\n${text}`;
  
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  
  // Try sending with Markdown formatting first
  let response = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: formattedText,
      parse_mode: 'Markdown',
    })
  });

  // If Markdown parsing fails, fallback to sending plain text
  if (!response.ok) {
    const errorData = await response.json();
    if (errorData.description && errorData.description.includes('can\'t parse')) {
      logDebug(`Markdown parsing failed for Telegram message. Retrying in plain text.`);
      
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
