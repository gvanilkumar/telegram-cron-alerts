/**
 * @fileoverview Lightweight Google Sheets API integration.
 * Uses Node's built-in 'crypto' module for JWT signing, requiring no external packages.
 */

const crypto = require('crypto');
const logger = require('./logger');

/**
 * Encodes a string to Base64URL.
 * @param {string|Buffer} input 
 * @returns {string}
 */
function base64url(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer.toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Gets a temporary access token from Google OAuth2 using Service Account JWT assertion.
 * @param {Object} serviceAccount 
 * @returns {Promise<string>} Access token
 */
async function getAccessToken(serviceAccount) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: serviceAccount.token_uri || 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const signatureInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  
  try {
    const formattedPrivateKey = (serviceAccount.private_key || '').replace(/\\n/g, '\n');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signatureInput);
    const signature = sign.sign(formattedPrivateKey, 'base64');
    const signedJwt = `${signatureInput}.${base64url(Buffer.from(signature, 'base64'))}`;

    const tokenUrl = serviceAccount.token_uri || 'https://oauth2.googleapis.com/token';
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedJwt}`
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Google OAuth API responded with status ${response.status}: ${errText}`);
    }

    const data = await response.json();
    if (!data.access_token) {
      throw new Error('Google OAuth response did not contain access_token.');
    }

    return data.access_token;
  } catch (err) {
    logger.error('Failed to authenticate Google Service Account', err);
    throw new Error(`Google Sheets Auth failed: ${err.message}`);
  }
}

/**
 * Parses Service Account JSON string safely.
 * @param {string} keyString 
 * @returns {Object|null}
 */
function parseServiceAccountKey(keyString) {
  if (!keyString) return null;
  let str = keyString.trim();

  // Strip wrapping quotes if present
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    str = str.slice(1, -1).trim();
  }

  try {
    const parsed = JSON.parse(str);
    if (parsed.client_email && parsed.private_key) {
      return parsed;
    }
  } catch (e) {
    // Attempt base64 decoding if raw JSON parsing failed
    try {
      const decoded = Buffer.from(str, 'base64').toString('utf8').trim();
      const parsed = JSON.parse(decoded);
      if (parsed.client_email && parsed.private_key) {
        return parsed;
      }
    } catch (_) {}
  }
  return null;
}

/**
 * Appends a log row to the Google Sheet.
 * @param {string} spreadsheetId 
 * @param {string} serviceAccountKey 
 * @param {Object} logEntry 
 * @returns {Promise<boolean>}
 */
async function appendSheetLog(spreadsheetId, serviceAccountKey, logEntry) {
  const sa = parseServiceAccountKey(serviceAccountKey);
  if (!sa) {
    logger.warn('Google Sheets logger: invalid or missing Service Account JSON.');
    return false;
  }

  try {
    const token = await getAccessToken(sa);
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };

    // First check if the sheet is empty to initialize header columns
    const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1:G1`;
    const readRes = await fetch(readUrl, { headers });
    const readData = await readRes.json();
    
    // If empty or values property is missing, write headers first
    if (!readData.values || readData.values.length === 0) {
      const initUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1:G1?valueInputOption=USER_ENTERED`;
      await fetch(initUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          values: [
            ['Timestamp', 'Task ID', 'Task Name', 'Schedule', 'Status', 'Message Preview / Details', 'AI Model']
          ]
        })
      });
      logger.info('Initialized Google Sheet headers.');
    }

    // Append log row
    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1:append?valueInputOption=USER_ENTERED`;
    const row = [
      logEntry.timestamp,
      logEntry.taskId,
      logEntry.taskName,
      logEntry.schedule,
      logEntry.status,
      logEntry.output,
      logEntry.model || 'N/A'
    ];

    const appendRes = await fetch(appendUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        values: [row]
      })
    });

    if (!appendRes.ok) {
      const errTxt = await appendRes.text();
      throw new Error(`Status ${appendRes.status}: ${errTxt}`);
    }

    logger.debug(`Successfully appended log row to Google Sheet (${spreadsheetId})`);
    return true;
  } catch (err) {
    logger.error('Failed to append log to Google Sheet', err);
    return false;
  }
}

/**
 * Fetches and formats the last N logs from the Google Sheet.
 * @param {string} spreadsheetId 
 * @param {string} serviceAccountKey 
 * @param {number} limit 
 * @returns {Promise<Array<Object>>}
 */
async function fetchSheetLogs(spreadsheetId, serviceAccountKey, limit = 200) {
  const sa = parseServiceAccountKey(serviceAccountKey);
  if (!sa) {
    throw new Error('Invalid or missing Google Service Account credentials.');
  }

  try {
    const token = await getAccessToken(sa);
    const headers = { 'Authorization': `Bearer ${token}` };

    // Fetch the entire sheet values (limit to first 1000 rows to prevent huge downloads)
    const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A:G`;
    const response = await fetch(readUrl, { headers });
    
    if (!response.ok) {
      const errTxt = await response.text();
      throw new Error(`Sheets API responded with ${response.status}: ${errTxt}`);
    }

    const data = await response.json();
    const rows = data.values || [];

    if (rows.length === 0) return [];

    // Filter out the header row if present
    const cleanRows = rows.filter(r => r[0] !== 'Timestamp');

    // Parse and map rows, reversing so newest logs are first
    const mappedLogs = cleanRows.map(row => ({
      timestamp: row[0] || new Date().toISOString(),
      taskId: row[1] || 'unknown',
      taskName: row[2] || 'Unnamed Task',
      schedule: row[3] || 'N/A',
      status: row[4] || 'error',
      output: row[5] || '',
      model: row[6] || 'N/A'
    })).reverse();

    return mappedLogs.slice(0, limit);
  } catch (err) {
    logger.error('Failed to fetch logs from Google Sheet', err);
    throw err;
  }
}

module.exports = {
  parseServiceAccountKey,
  appendSheetLog,
  fetchSheetLogs
};
