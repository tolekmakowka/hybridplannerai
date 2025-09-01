// netlify/functions/generate-plan.js
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const MODEL = process.env.GROQ_MODEL || 'llama3-70b-8192';

// ORIGINS jak wcześniej
const ALLOWED_ORIGINS = new Set([
  'https://tgmproject.net',
  'https://www.tgmproject.net',
  'https://hybridplannerai.netlify.app',
  'http://localhost:8888',
  'http://localhost:5173',
  'http://localhost:3000'
]);

const cors = (origin) => ({
  'Access-Control-Allow-Origin': (origin && ALLOWED_ORIGINS.has(origin)) ? origin : '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
  'Content-Type': 'application/json; charset=utf-8'
});

exports.handler = async (event) => {
  const origin = event.headers?.origin || '';

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(origin) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors(origin), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!GROQ_API_KEY) {
    return { statusCode: 500, headers: cors(origin), body: JSON.stringify({ error: 'GROQ_API_KEY not set' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}
  const { mode = 'A', prompt } = body;

  if (!prompt || typeof prompt !== 'string') {
    return { statusCode: 400, headers: cors(origin), body: JSON.stringify({ error: 'Missing "prompt"' }) };
  }

  try {
    // Groq: endpoint zgodny z OpenAI
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + GROQ_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.4,
        max_tokens: 2200,
        messages: [
          { role: 'system', content: 'You are an experienced strength & conditioning coach. Output plain text only (no tables/HTML).' },
          { role: 'user', content: prompt }
        ]
      })
    });

    const raw = await r.text();
    if (!r.ok) {
      return { statusCode: r.status || 502, headers: cors(origin), body: JSON.stringify({ error: 'Groq error', details: raw }) };
    }

    const data = JSON.parse(raw || '{}');
    const planText = data?.choices?.[0]?.message?.content?.trim?.() || 'Brak treści planu.';
    const planName = (mode === 'A') ? 'Plan Treningowy' : 'Hybrydowy Plan Treningowy';

    return { statusCode: 200, headers: cors(origin), body: JSON.stringify({ planText, planName }) };
  } catch (e) {
    return { statusCode: 500, headers: cors(origin), body: JSON.stringify({ error: 'Unhandled exception', message: String(e) }) };
  }
};
