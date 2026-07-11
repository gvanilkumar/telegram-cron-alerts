/**
 * @fileoverview Scraper engine with Jina Reader and fallback HTML selectors.
 */

const { fetchWithRetry } = require('./utils');
const { ScraperError } = require('./errors');
const logger = require('./logger');

/**
 * Scrape webpage context using Jina Reader (with local raw HTML parser fallback).
 * @param {string} url 
 * @returns {Promise<string>}
 */
async function scrapeWebpage(url) {
  logger.debug(`Scraping webpage: ${url}`);
  
  // 1. Try Jina Reader first for ultra-clean Markdown context
  try {
    logger.debug(`Attempting clean markdown scrape via Jina Reader for: ${url}`);
    const jinaResponse = await fetch(`https://r.jina.ai/${url}`, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': 'Telegram-Cron-Alerts-Scraper/1.0'
      }
    });
    
    if (jinaResponse.ok) {
      const text = await jinaResponse.text();
      if (text && text.trim().length > 100) {
        logger.debug(`Jina Reader scrape successful! Length: ${text.length} chars.`);
        return text.trim().substring(0, 15000); // Truncate to avoid context window blowouts
      }
    }
    logger.debug(`Jina Reader returned empty or non-200 status: ${jinaResponse.status}. Falling back to raw HTML scraper.`);
  } catch (jinaErr) {
    logger.debug(`Jina Reader failed: ${jinaErr.message}. Falling back to raw HTML scraper.`);
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
    logger.debug(`Raw HTML scraping failed: ${err.message}`);
    throw new ScraperError(`Failed to scrape ${url}: ${err.message}`, url);
  }
}

module.exports = {
  scrapeWebpage
};
