/**
 * @fileoverview Notification dispatchers for Telegram, Discord, and Slack channels.
 */

const { fetchWithRetry } = require('./utils');
const { NotifierError } = require('./errors');
const logger = require('./logger');

/**
 * Convert Markdown formatting to Telegram HTML format.
 * @param {string} markdownText 
 * @returns {string}
 */
function convertMarkdownToHtml(markdownText) {
  if (!markdownText) return '';
  // Convert [text](url) to <a href="$2">$1</a>
  let html = markdownText.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, '<a href="$2">$1</a>');
  // Convert **bold** to <b>bold</b>
  html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  return html;
}

/**
 * Send a Telegram message.
 * @param {string} text 
 * @param {string} taskName 
 * @param {string} botToken 
 * @param {string} chatId 
 * @returns {Promise<void>}
 */
async function sendTelegramMessage(text, taskName, botToken, chatId) {
  logger.debug(`Sending Telegram alert...`);
  if (!botToken || !chatId) {
    throw new NotifierError('Telegram Bot Token or Chat ID is missing', 'telegram');
  }

  const htmlContent = convertMarkdownToHtml(text);
  const formattedText = `🔔 <b>Alert: ${taskName}</b>\n\n${htmlContent}`;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  
  try {
    let response = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: formattedText,
        parse_mode: 'HTML',
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      logger.warn(`HTML parsing failed for Telegram message (${errorData.description}). Retrying in plain text.`);
      
      const plainText = `🔔 Alert: ${taskName}\n\n${text}`;
      response = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
  } catch (err) {
    logger.error('Failed to deliver Telegram notification', err);
    throw new NotifierError(`Telegram failed: ${err.message}`, 'telegram');
  }
}

/**
 * Send a Discord message.
 * @param {string} text 
 * @param {string} taskName 
 * @param {string} webhookUrl 
 * @returns {Promise<void>}
 */
async function sendDiscordMessage(text, taskName, webhookUrl) {
  logger.debug(`Sending Discord Webhook alert...`);
  if (!webhookUrl) {
    throw new NotifierError('Discord Webhook URL is missing', 'discord');
  }
  
  const formattedText = `🔔 **Alert: ${taskName}**\n\n${text}`;
  
  try {
    const response = await fetchWithRetry(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: formattedText })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Discord Webhook returned status ${response.status}: ${errText}`);
    }
  } catch (err) {
    logger.error('Failed to deliver Discord notification', err);
    throw new NotifierError(`Discord failed: ${err.message}`, 'discord');
  }
}

/**
 * Send a Slack message.
 * @param {string} text 
 * @param {string} taskName 
 * @param {string} webhookUrl 
 * @returns {Promise<void>}
 */
async function sendSlackMessage(text, taskName, webhookUrl) {
  logger.debug(`Sending Slack Webhook alert...`);
  if (!webhookUrl) {
    throw new NotifierError('Slack Webhook URL is missing', 'slack');
  }
  
  const formattedText = `🔔 *Alert: ${taskName}*\n\n${text}`;
  
  try {
    const response = await fetchWithRetry(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: formattedText })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Slack Webhook returned status ${response.status}: ${errText}`);
    }
  } catch (err) {
    logger.error('Failed to deliver Slack notification', err);
    throw new NotifierError(`Slack failed: ${err.message}`, 'slack');
  }
}

/**
 * Send non-blocking system diagnostic alerts on consecutive failures.
 * @param {any} task 
 * @param {string} errorMessage 
 * @param {string} botToken 
 * @param {string} chatId 
 * @returns {Promise<void>}
 */
async function sendSystemDiagnosticAlert(task, errorMessage, botToken, chatId) {
  const channels = task.channels || ['telegram'];
  const systemMsg = `⚠️ [AuraVigil System Alert]\nTask "${task.name}" has failed 3 consecutive times.\n\nLatest Error: ${errorMessage}`;
  
  if (channels.includes('telegram') && botToken && chatId) {
    try {
      await sendTelegramMessage(systemMsg, 'AuraVigil System Diagnostic', botToken, chatId);
    } catch (e) {
      logger.warn(`Failed to deliver Telegram system alert: ${e.message}`);
    }
  }
  
  const discordUrl = process.env.DISCORD_WEBHOOK_URL;
  if (channels.includes('discord') && discordUrl) {
    try {
      await sendDiscordMessage(systemMsg, 'AuraVigil System Diagnostic', discordUrl);
    } catch (e) {
      logger.warn(`Failed to deliver Discord system alert: ${e.message}`);
    }
  }
  
  const slackUrl = process.env.SLACK_WEBHOOK_URL;
  if (channels.includes('slack') && slackUrl) {
    try {
      await sendSlackMessage(systemMsg, 'AuraVigil System Diagnostic', slackUrl);
    } catch (e) {
      logger.warn(`Failed to deliver Slack system alert: ${e.message}`);
    }
  }
}

module.exports = {
  convertMarkdownToHtml,
  sendTelegramMessage,
  sendDiscordMessage,
  sendSlackMessage,
  sendSystemDiagnosticAlert
};
