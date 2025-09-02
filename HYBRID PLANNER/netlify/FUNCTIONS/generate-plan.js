// netlify/functions/generate-plan.js
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Dozwolone originy (dodaj swoje jeśli potrzeba)
const ALLOWED_ORIGINS = new Set([
  'https://tgmproject.net',
  'https://www.tgmproject.net',
  'http://localhost:8888',
  'http://localhost:5173',
  'http://localhost:3000',
]);

function corsHeaders(origin) {
  const allow = (origin && ALLOWED_ORIGINS.has(origin)) ? origin : '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || '';

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    if (!GROQ_API_KEY) {
      return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'GROQ_API_KEY not set' }) };
    }

    let body = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Bad JSON' }) };
    }

    const { prompt = '', mode = 'A', inputs = {}, lang = 'pl' } = body;
    if (!prompt.trim()) {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Missing prompt' }) };
    }

    // ✅ Poprawny endpoint i aktualny model Groq
    const payload = {
      model: 'llama-3.1-70b-versatile',
      temperature: 0.4,
      max_tokens: 2200,
      messages: [
        { role: 'system', content: 'You are an experienced strength & conditioning coach. Output plain text only (no tables or HTML).' },
        { role: 'user', content: prompt },
      ],
    };

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const raw = await r.text();
    if (!r.ok) {
      // pokażemy dokładny błąd z Groq w logach Netlify
      return {
        statusCode: r.status || 500,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: 'Groq error', details: raw }),
      };
    }

    let data = {};
    try { data = JSON.parse(raw); } catch {}
    const planText = data?.choices?.[0]?.message?.content?.trim?.() || '';

    if (!planText) {
      return { statusCode: 502, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Empty response from model' }) };
    }

    const planName = mode === 'A' ? 'Plan Treningowy' : 'Plan';
    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: JSON.stringify({ planText, planName }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: corsHeaders(origin),
      body: JSON.stringify({ error: 'Unhandled exception', message: String(e) }),
    };
  }
};
