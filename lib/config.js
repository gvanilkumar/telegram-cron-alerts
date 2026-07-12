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

module.exports = {
  rootDir,
  envPath,
  settingsPath,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  customApiEndpoint: process.env.CUSTOM_API_ENDPOINT || '',
  customAiModel: process.env.CUSTOM_AI_MODEL || '',
  googleServiceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '',
  googleSheetId: process.env.GOOGLE_SHEET_ID || '',
  settings
};
