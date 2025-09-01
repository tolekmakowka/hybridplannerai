// netlify/functions/generate-plan.js
// Groq chat.completions (zgodne z API OpenAI)
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const ALLOWED_ORIGINS = new Set([
  'https://tgmproject.net',
  'https://www.tgmproject.net',
  'https://hybridplannerai.netlify.app',
  'http://localhost:8888',
  'http://localhost:5173',
  'http://localhost:3000'
]);

function corsHeaders(origin) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : '*';
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
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    if (!GROQ_API_KEY) {
      return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'GROQ_API_KEY not set' }) };
    }

    let body = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Bad JSON' }) }; }

    const { mode = 'A', prompt = '', lang = 'pl' } = body;
    if (!prompt || typeof prompt !== 'string') {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Missing "prompt"' }) };
    }

    // Wywołanie GROQ (ścieżka zgodna z OpenAI):
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama3-70b-8192',       // ewentualnie 'mixtral-8x7b-32768'
        temperature: 0.4,
        max_tokens: 3500,
        messages: [
          { role: 'system', content: 'You are an experienced strength & conditioning coach. Output plain text only (no tables/HTML).' },
          { role: 'user', content: prompt }
        ]
      })
    });

    const rawText = await resp.text();
    if (!resp.ok) {
      // Zwróć treść błędu do przeglądarki — frontend pokaże fallback i zaloguje błąd
      return {
        statusCode: resp.status || 500,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: 'Groq error', details: rawText })
      };
    }

    let data = {};
    try { data = JSON.parse(rawText); } catch {/* leave empty */}
    const planText = data?.choices?.[0]?.message?.content?.trim?.() || '';

    if (!planText) {
      return { statusCode: 502, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Empty completion from Groq' }) };
    }

    const planName = mode === 'A' ? (lang.startsWith('en') ? 'Training Plan' : 'Plan Treningowy') 
                                  : (lang.startsWith('en') ? 'Hybrid Training Plan' : 'Hybrydowy Plan Treningowy');

    // <<<<<<<<<<<<<<<<<<<<<<  WAŻNE: klucze zgodne z frontendem  >>>>>>>>>>>>>>>>>>>>>>
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
