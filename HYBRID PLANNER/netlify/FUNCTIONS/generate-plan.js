// netlify/functions/generate-plan.js

const ALLOWED = (process.env.ALLOWED_ORIGINS ||
  'https://tgmproject.net,https://www.tgmproject.net,https://hybridplannerai.netlify.app'
).split(',').map(s => s.trim());

function cors(origin) {
  const allow = ALLOWED.includes(origin) ? origin : ALLOWED[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
}

exports.handler = async (event) => {
  const origin = event.headers.origin || '';
  const headers = cors(origin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method Not Allowed' };
  }

  try {
    const { prompt, mode } = JSON.parse(event.body || '{}');
    if (!prompt) {
      return { statusCode: 400, headers, body: 'Missing prompt' };
    }

    // Call OpenAI (bez SDK – czysty fetch)
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',        // szybki/tani. Możesz użyć "gpt-4o".
        temperature: 0.6,
        messages: [
          { role: 'system', content: 'You are a precise workout-planning assistant. Always follow the user’s format and return a JSON code block when asked.' },
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { statusCode: resp.status, headers, body: text };
    }

    const data = await resp.json();
    const planText = data?.choices?.[0]?.message?.content || '';
    const planName = mode === 'A' ? 'Plan Treningowy' : 'Hybrydowy Plan Treningowy';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ planText, planName })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: `OpenAI error: ${e.message}` };
  }
};
