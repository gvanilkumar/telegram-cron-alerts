const fs = require('fs');
const path = require('path');

// Constants for preset schedules (in milliseconds)
const INTERVALS = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '5h': 5 * 60 * 60 * 1000,
  'daily': 24 * 60 * 60 * 1000,
  'weekly': 7 * 24 * 60 * 60 * 1000,
  'monthly': 30 * 24 * 60 * 60 * 1000,
};

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
    
    // Extract first 5000 characters to stay within reasonable token/context limits
    return text.substring(0, 5000);
  } catch (err) {
    logDebug(`Scraping failed: ${err.message}`);
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

  for (const task of tasks) {
    if (!task.active) {
      continue;
    }

    const lastRun = state[task.id] || 0;
    const interval = INTERVALS[task.schedule];
    
    if (!interval) {
      logDebug(`Warning: Task "${task.name}" has invalid schedule "${task.schedule}". Skipping.`);
      continue;
    }

    // Determine if task is due. Apply a 30s buffer to account for GitHub Actions scheduling variations
    const buffer = 30 * 1000;
    const isDue = (now - lastRun) >= (interval - buffer);

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
            alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, 'https://api.groq.com/openai/v1/chat/completions', 'llama3-70b-8192');
          } else if (geminiApiKey.startsWith('sk-')) {
            alertMessage = await executeOpenAiCompatiblePrompt(promptText, geminiApiKey, 'https://api.openai.com/v1/chat/completions', 'gpt-4o-mini');
          } else {
            alertMessage = await executeAiPrompt(promptText);
          }
        } else {
          alertMessage = task.prompt || 'No message content defined.';
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
        state[task.id] = now;
        stateChanged = true;
      } catch (err) {
        console.error(`Error executing task "${task.name}":`, err.message);
        logEntry.status = 'error';
        logEntry.output = `Error: ${err.message}`;
        // Still update state lastRun to avoid infinitely retrying a broken prompt on every cron run
        state[task.id] = now;
        stateChanged = true;
      }

      executionLogs.push(logEntry);
    } else {
      const nextRunTime = new Date(lastRun + interval);
      logDebug(`Task "${task.name}" is not due. Next run at: ${nextRunTime.toISOString()}`);
    }
  }

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

async function executeAiPrompt(prompt) {
  logDebug(`Calling Gemini API for prompt...`);
  const systemInstruction = `You are a helpful automation assistant. Return a concise, clear alert or summary according to the user request. Make it look beautiful on a phone screen. Use Markdown formatting when appropriate (bold, bullet points, emoji). Keep the response under 1500 characters.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`;
  
  const response = await fetch(url, {
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

  const response = await fetch(endpoint, {
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
  let response = await fetch(url, {
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
      response = await fetch(url, {
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
  
  const response = await fetch(webhookUrl, {
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
  
  const response = await fetch(webhookUrl, {
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
