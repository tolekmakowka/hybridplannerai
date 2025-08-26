// /.netlify/functions/generate-plan.js
const ALLOWED_ORIGINS = new Set([
  'https://tgmproject.net',
  'https://www.tgmproject.net',
  'https://hybridplannerai.netlify.app'
]);

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';

function corsHeaders(origin) {
  const o = ALLOWED_ORIGINS.has(origin) ? origin : Array.from(ALLOWED_ORIGINS)[0];
  return {
    'Access-Control-Allow-Origin': o,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

exports.handler = async (event) => {
  const origin = event.headers.origin || '';
  const baseHeaders = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: baseHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: baseHeaders, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if(!apiKey){
    return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ error: 'Brak OPENAI_API_KEY w Netlify env.' }) };
  }

  try{
    const body = JSON.parse(event.body || '{}');
    let { prompt, mode, title, inputs } = body;

    // Gdyby front nie dosłał promptu, zbuduj minimalny (awaryjnie):
    if(!prompt){
      const sr = JSON.stringify(inputs||{});
      prompt = `Jesteś doświadczonym trenerem S&C. Stwórz kompletny plan (${mode==='A'?'12 tygodni':'4 tygodnie hybrydowy'}) zgodnie z zasadami formatowania, tylko z dozwolonych ćwiczeń. Dane wejściowe: ${sr}.`;
    }

    const messages = [
      { role: 'system', content: 'Jesteś pomocnym asystentem i doświadczonym trenerem S&C. Zwracaj wyłącznie finalny plan w czystym tekście.' },
      { role: 'user', content: prompt }
    ];

    const r = await fetch(OPENAI_URL, {
      method:'POST',
      headers:{
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.6,
        max_tokens: 4000
      })
    });

    const text = await r.text();
    let data; try{ data = JSON.parse(text); }catch(_){ data = null; }

    if(!r.ok){
      return { statusCode: r.status, headers: baseHeaders, body: JSON.stringify({ error: data?.error?.message || text }) };
    }

    const planText = data?.choices?.[0]?.message?.content?.trim();
    if(!planText){
      return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ error: 'OpenAI zwróciło pustą treść.' }) };
    }

    const planName = title || (mode==='A' ? 'Plan Treningowy (12 tygodni)' : 'Hybrydowy Plan Treningowy (4 tygodnie)');

    return {
      statusCode: 200,
      headers: baseHeaders,
      body: JSON.stringify({ planText, planName })
    };
  }catch(e){
    console.error('generate-plan exception:', e);
    return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ error: 'Wyjątek w funkcji generate-plan', detail: String(e) }) };
  }
};
