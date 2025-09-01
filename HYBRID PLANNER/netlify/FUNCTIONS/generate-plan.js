// netlify/functions/generate-plan.js
// Groq-only, kompatybilne z obecnym frontem (zwraca { planText, planName })

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ORIGINS dopuszczone do CORS – spójne z frontem
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

  if (!GROQ_API_KEY) {
    return {
      statusCode: 500,
      headers: corsHeaders(origin),
      body: JSON.stringify({ error: 'GROQ_API_KEY not set' })
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const {
      mode = 'A',          // 'A' lub 'B'
      inputs = {},         // przesyłasz już z frontu
      lang = 'pl',
      prompt               // gotowy prompt z frontu (buildPrompt)
    } = body;

    if (!prompt || typeof prompt !== 'string') {
      return {
        statusCode: 400,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: 'Missing "prompt" (string) in body' })
      };
    }

    // Wywołanie Groq (endpoint zgodny z OpenAI)
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-70b-versatile',   // stabilny, dobry do dłuższych planów
        temperature: 0.4,
        max_tokens: 2200,
        messages: [
          {
            role: 'system',
            content: 'You are an experienced strength & conditioning coach. Output plain text only (no HTML tables).'
          },
          { role: 'user', content: prompt }
        ]
      })
    });

    const raw = await resp.text();
    if (!resp.ok) {
      // Zwracamy treść błędu do frontu, żebyś widział log w konsoli
      return {
        statusCode: resp.status || 500,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: 'Groq error', details: raw })
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
    return {
      statusCode: 500,
      headers: corsHeaders(origin),
      body: JSON.stringify({ error: 'Unhandled exception', message: String(e) })
    };
  }
};
