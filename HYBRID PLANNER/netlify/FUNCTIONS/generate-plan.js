// netlify/functions/generate-plan.js
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ORIGINS dopuszczone do CORS
const ALLOWED_ORIGINS = new Set([
  'https://tgmproject.net',
  'https://www.tgmproject.net',
  'http://localhost:8888',
  'http://localhost:5173',
  'http://localhost:3000'
]);

function corsHeaders(origin) {
  const allow = (origin && ALLOWED_ORIGINS.has(origin)) ? origin : '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json; charset=utf-8'
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || '';

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin) };
  }
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders(origin),
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    if (!GROQ_API_KEY) {
      return {
        statusCode: 500,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: 'GROQ_API_KEY not set' })
      };
    }

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } 
    catch { 
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({error:'Bad JSON'}) };
    }

    const { mode = 'A', inputs = {}, lang = 'pl', prompt } = body;
    if (!prompt || typeof prompt !== 'string') {
      return {
        statusCode: 400,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: 'Missing "prompt" in body' })
      };
    }

    // Zapytanie do GROQ (Llama 3.1 70B)
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-70b-versatile',
        temperature: 0.4,
        max_tokens: 2200,
        messages: [
          { role: 'system', content: 'You are an experienced strength & conditioning coach. Output plain text only (no tables or HTML).' },
          { role: 'user', content: prompt }
        ]
      })
    });

    const raw = await resp.text();
    if (!resp.ok) {
      return {
        statusCode: resp.status || 500,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: 'GROQ error', details: raw })
      };
    }

    let data;
    try { data = JSON.parse(raw); } catch { data = {}; }
    const planText =
      data?.choices?.[0]?.message?.content?.trim?.() ||
      'Nie udało się wygenerować planu.';

    const planName = mode === 'A'
      ? 'Plan Treningowy'
      : 'Hybrydowy Plan Treningowy';

    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: JSON.stringify({ planText, planName })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: corsHeaders(origin),
      body: JSON.stringify({ error: 'Unhandled exception', message: String(e) })
    };
  }
};
