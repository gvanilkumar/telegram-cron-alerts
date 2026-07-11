/**
 * @fileoverview AI model connections, embeddings, and similarity calculators.
 */

const { fetchWithRetry } = require('./utils');
const { AiError } = require('./errors');
const logger = require('./logger');

/**
 * Call the Google Gemini API to process a prompt.
 * @param {string} prompt 
 * @param {string} apiKey 
 * @returns {Promise<string>}
 */
async function executeAiPrompt(prompt, apiKey) {
  logger.debug(`Calling Gemini API for prompt...`);
  const systemInstruction = `You are a helpful automation assistant. Return a concise, clear alert or summary according to the user request. Make it look beautiful on a phone screen. Use Markdown formatting when appropriate. Keep the response under 1500 characters.`;
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  
  try {
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
      throw new Error(`Status ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!generatedText) {
      throw new Error('Gemini API returned empty response structure.');
    }

    return generatedText.trim();
  } catch (err) {
    logger.error('Gemini API execution error', err);
    throw new AiError(`Gemini API failed: ${err.message}`, 'gemini');
  }
}

/**
 * Call an OpenAI-compatible API to process a prompt.
 * @param {string} prompt 
 * @param {string} apiKey 
 * @param {string} url 
 * @param {string} model 
 * @returns {Promise<string>}
 */
async function executeOpenAiCompatiblePrompt(prompt, apiKey, url, model) {
  logger.debug(`Calling OpenAI-compatible API at ${url} (model: ${model})...`);
  const systemInstruction = `You are a helpful automation assistant. Return a concise, clear alert or summary according to the user request. Make it look beautiful on a phone screen. Use Markdown formatting when appropriate. Keep the response under 1500 characters.`;

  let endpoint = url;
  if (!endpoint.includes('/v1') && !endpoint.includes('/v2') && !endpoint.includes('/public')) {
    endpoint = endpoint.replace(/\/$/, '') + '/v1';
  }
  if (!endpoint.endsWith('/chat/completions') && !endpoint.endsWith('/chat/completions/')) {
    endpoint = endpoint.replace(/\/$/, '') + '/chat/completions';
  }

  try {
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
      throw new Error(`Status ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const generatedText = data.choices?.[0]?.message?.content;

    if (!generatedText) {
      throw new Error('AI API returned empty response structure.');
    }

    return generatedText.trim();
  } catch (err) {
    logger.error(`OpenAI-compatible API execution error (${model})`, err);
    throw new AiError(`AI API failed: ${err.message}`, model);
  }
}

/**
 * Get vector embedding from Google Gemini API.
 * @param {string} text 
 * @param {string} apiKey 
 * @returns {Promise<Array<number>>}
 */
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

/**
 * Get vector embedding from OpenAI API.
 * @param {string} text 
 * @param {string} apiKey 
 * @returns {Promise<Array<number>>}
 */
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

/**
 * Generic embedding retriever with local fallback error handling.
 * @param {string} text 
 * @param {string} apiKey 
 * @returns {Promise<Array<number>|null>}
 */
async function getEmbedding(text, apiKey, provider = 'auto') {
  if (!apiKey || !text) return null;
  try {
    let resolvedProvider = provider;
    if (resolvedProvider === 'auto') {
      if (apiKey.startsWith('sk-')) resolvedProvider = 'openai';
      else if (apiKey.startsWith('gsk_')) resolvedProvider = 'groq';
      else if (apiKey.startsWith('cbs-') || apiKey.startsWith('csk-')) resolvedProvider = 'cerebras';
      else resolvedProvider = 'gemini';
    }

    if (resolvedProvider === 'openai') {
      return await getOpenAiEmbedding(text, apiKey);
    } else if (resolvedProvider === 'gemini') {
      return await getGeminiEmbedding(text, apiKey);
    }
  } catch (err) {
    logger.warn(`Embedding generation failed (${err.message}). Falling back to local similarity.`);
  }
  return null;
}

/**
 * Calculate Cosine Similarity between two numerical vectors.
 * @param {Array<number>} vec1 
 * @param {Array<number>} vec2 
 * @returns {number}
 */
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

/**
 * Local word-frequency Cosine similarity fallback.
 * @param {string} str1 
 * @param {string} str2 
 * @returns {number}
 */
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

module.exports = {
  executeAiPrompt,
  executeOpenAiCompatiblePrompt,
  getEmbedding,
  calculateCosineSimilarity,
  calculateLocalSimilarity
};
