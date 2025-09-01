// netlify/functions/generate-plan.js
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ORIGINS dopuszczone do CORS – te same co w send-email.js
const ALLOWED_ORIGINS = new Set([
  'https://tgmproject.net',
  'https://www.tgmproject.net',
  'https://hybridplannerai.netlify.app',
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
    if (!OPENAI_API_KEY) {
      return {
        statusCode: 500,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: 'OPENAI_API_KEY not set' })
      };
    }

    const body = JSON.parse(event.body || '{}');
    const { mode = 'A', inputs = {}, lang = 'pl', prompt } = body;

    if (!prompt || typeof prompt !== 'string') {
      return {
        statusCode: 400,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: 'Missing "prompt" in body' })
      };
    }

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.4,
        max_tokens: 2200,
        messages: [
          { role: 'system', content: 'You are an experienced strength & conditioning coach. Output plain text only (no tables or markdown tables).' },
          { role: 'user', content: prompt }
        ]
      })
    });

    const raw = await resp.text();
    if (!resp.ok) {
      console.error('OpenAI error:', raw);
      return {
        statusCode: resp.status || 500,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: 'OpenAI error', details: raw })
      };
    }

    let data = {};
    try { data = JSON.parse(raw); } catch {}
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
    console.error('Unhandled exception:', e);
    return {
      statusCode: 500,
      headers: corsHeaders(origin),
      body: JSON.stringify({ error: 'Unhandled exception', message: String(e) })
    };
  }
};
