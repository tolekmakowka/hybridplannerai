// netlify/functions/generate-plan.js
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY || '';
const GROQ_API_KEY       = process.env.GROQ_API_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

const GROQ_MODEL         = process.env.GROQ_MODEL || 'llama3-70b-8192'; // sprawdzony model w Groq
const OPENROUTER_MODEL   = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-70b-instruct';
const OPENAI_MODEL       = process.env.OPENAI_MODEL || 'gpt-4o-mini';

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
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { mode = 'A', prompt } = body;
    if (!prompt || typeof prompt !== 'string') {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Missing "prompt" in body' }) };
    }

    // 1) Spróbuj OpenAI
    if (OPENAI_API_KEY) {
      const r = await callOpenAI(prompt);
      if (r.ok) return jsonOk(origin, r.planText, mode);
      // jeśli quota/402/429 → lecimy dalej
    }

    // 2) Spróbuj GROQ (Llama 3/3.1)
    if (GROQ_API_KEY) {
      const r = await callGroq(prompt);
      if (r.ok) return jsonOk(origin, r.planText, mode);
    }

    // 3) Spróbuj OpenRouter (dowolny model dostępny na Twoim koncie)
    if (OPENROUTER_API_KEY) {
      const r = await callOpenRouter(prompt, event);
      if (r.ok) return jsonOk(origin, r.planText, mode);
    }

    // Jeśli tu doszliśmy — żaden provider nie zadziałał
    return {
      statusCode: 502,
      headers: corsHeaders(origin),
      body: JSON.stringify({
        error: 'No LLM provider available',
        details: 'OpenAI: ' + (OPENAI_API_KEY ? 'key set' : 'missing') +
                 ', Groq: ' + (GROQ_API_KEY ? 'key set' : 'missing') +
                 ', OpenRouter: ' + (OPENROUTER_API_KEY ? 'key set' : 'missing')
      })
    };
  } catch (e) {
    console.error('Unhandled exception:', e);
    return { statusCode: 500, headers: corsHeaders(''), body: JSON.stringify({ error: 'Unhandled exception', message: String(e) }) };
  }
};

/* ---------------- helpers ---------------- */

function jsonOk(origin, planText, mode) {
  const planName = mode === 'A' ? 'Plan Treningowy' : 'Hybrydowy Plan Treningowy';
  return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify({ planText, planName }) };
}

async function callOpenAI(prompt) {
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.4,
        max_tokens: 2200,
        messages: [
          { role: 'system', content: 'You are an experienced strength & conditioning coach. Output plain text only (no tables).' },
          { role: 'user', content: prompt }
        ]
      })
    });
    const raw = await resp.text();
    if (!resp.ok) {
      console.error('OpenAI error:', raw);
      // jeśli quota 402/insufficient_quota → zwróć not ok, żeby spróbować kolejnego providera
      return { ok: false, why: 'openai_failed', raw };
    }
    const data = JSON.parse(raw || '{}');
    const planText = data?.choices?.[0]?.message?.content?.trim?.() || '';
    return { ok: !!planText, planText };
  } catch (e) {
    console.error('OpenAI exception:', e);
    return { ok: false, why: 'openai_exception', err: String(e) };
  }
}

async function callGroq(prompt) {
  try {
    // Groq ma endpoint zgodny z OpenAI:
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + GROQ_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.4,
        max_tokens: 2200,
        messages: [
          { role: 'system', content: 'You are an experienced strength & conditioning coach. Output plain text only (no tables).' },
          { role: 'user', content: prompt }
        ]
      })
    });
    const raw = await resp.text();
    if (!resp.ok) {
      console.error('Groq error:', raw);
      return { ok: false, why: 'groq_failed', raw };
    }
    const data = JSON.parse(raw || '{}');
    const planText = data?.choices?.[0]?.message?.content?.trim?.() || '';
    return { ok: !!planText, planText };
  } catch (e) {
    console.error('Groq exception:', e);
    return { ok: false, why: 'groq_exception', err: String(e) };
  }
}

async function callOpenRouter(prompt, event) {
  try {
    const referer = (event.headers?.referer) || 'https://tgmproject.net';
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
        'Content-Type': 'application/json',
        'HTTP-Referer': referer,
        'X-Title': 'HybridPlanner'
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        temperature: 0.4,
        messages: [
          { role: 'system', content: 'You are an experienced strength & conditioning coach. Output plain text only (no tables).' },
          { role: 'user', content: prompt }
        ]
      })
    });
    const raw = await resp.text();
    if (!resp.ok) {
      console.error('OpenRouter error:', raw);
      return { ok: false, why: 'openrouter_failed', raw };
    }
    const data = JSON.parse(raw || '{}');
    const planText = data?.choices?.[0]?.message?.content?.trim?.() || '';
    return { ok: !!planText, planText };
  } catch (e) {
    console.error('OpenRouter exception:', e);
    return { ok: false, why: 'openrouter_exception', err: String(e) };
  }
}
