/**
 * @fileoverview Unified environment and configuration loader.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const rootDir = path.resolve(__dirname, '..');
const envPath = path.join(rootDir, '.env');
const settingsPath = path.join(rootDir, 'settings.json');

// Load environment variables from the project root .env file
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

// Load default settings
let settings = { autoSync: false };
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    // If settings are corrupt, we use the fallback defaults
  }
}

let googleServiceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '';
if (googleServiceAccountKey && !googleServiceAccountKey.trim().startsWith('{')) {
  try {
    googleServiceAccountKey = Buffer.from(googleServiceAccountKey.trim(), 'base64').toString('utf8');
  } catch (_) {}
}

const geminiApiKey = process.env.GEMINI_API_KEY || '';
const groqApiKey = process.env.GROQ_API_KEY || '';
const openAiApiKey = process.env.OPENAI_API_KEY || '';
const cerebrasApiKey = process.env.CEREBRAS_API_KEY || '';
const primaryApiKey = geminiApiKey || groqApiKey || openAiApiKey || cerebrasApiKey || '';

module.exports = {
  rootDir,
  envPath,
  settingsPath,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  geminiApiKey: primaryApiKey,
  rawGeminiKey: geminiApiKey,
  groqApiKey,
  openAiApiKey,
  cerebrasApiKey,
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  customApiEndpoint: process.env.CUSTOM_API_ENDPOINT || '',
  customAiModel: process.env.CUSTOM_AI_MODEL || '',
  googleServiceAccountKey,
  googleSheetId: process.env.GOOGLE_SHEET_ID || '',
  settings
};
