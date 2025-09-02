// netlify/functions/generate-plan.js
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// CORS
const ALLOWED_ORIGINS = new Set([
  'https://tgmproject.net',
  'https://www.tgmproject.net',
  'http://localhost:8888',
  'http://localhost:5173',
  'http://localhost:3000'
]);
const corsHeaders = (origin) => ({
  'Access-Control-Allow-Origin': (origin && ALLOWED_ORIGINS.has(origin)) ? origin : '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
  'Content-Type': 'application/json; charset=utf-8'
});

exports.handler = async (event) => {
  const origin = event.headers?.origin || '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(origin) };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify({error:'Method not allowed'}) };

  try{
    if(!GROQ_API_KEY){
      return { statusCode:500, headers:corsHeaders(origin), body: JSON.stringify({error:'GROQ_API_KEY not set'}) };
    }

    let body = {};
    try{ body = JSON.parse(event.body||'{}'); }catch{ /*ignore*/ }
    const { mode='A', inputs={}, lang='pl' } = body;

    // Dane wejściowe
    const sessions = Number(inputs.sessionsPerWeek||0) || 4;
    const goal = String(inputs.goal||'-');
    const level = String(inputs.level||'-');
    const equipment = String(inputs.equipment||'-');
    const sex = String(inputs.sex||'-'); // NOWE

    // System + User → prosimy o TYLKO JSON
    const system = `
Jesteś doświadczonym trenerem S&C. Zwracaj TYLKO JSON, bez żadnego komentarza.
Format:
{
  "week": [
    {
      "day": "Poniedziałek|Wtorek|...|Niedziela",
      "focus": "FBW|PUSH|PULL|LEGS|UPPER|LOWER|rest|other",
      "exercises": [
        { "name":"Flat bench press", "sets":3, "reps":"8-12", "rest":"2-3min", "rir":"1-3", "rpe":"8-9", "tempo":"X", "comment":"", "series":"" }
      ]
    }
  ]
}
Zasady:
- 5–8 ćwiczeń/dzień, każde 3–4 serie, 8–12 powt., odpoczynek 2–3 min, tempo "X".
- Zachowaj przerwy 24–48 h dla tych samych grup.
- Używaj WYŁĄCZNIE tej listy ćwiczeń (po polsku/EN jak niżej):
  klatka: Flat bench press, Incline bench press, Pec deck
  plecy: Lat pulldown, Close grip horizontal row, Horizontal row 45*, Bent over row
  barki: Overhead press, Face pull, Lateral raise
  biceps: Biceps curl, Hammer curl
  triceps: Triceps extension, Triceps overhead extension
  brzuch: Hanging knee raises
  przedramię: Forearm curl
  tylna taśma: Deadlift, Leg curl
  przednia taśma: Squat, Leg extension
  łydki: Calf raises
- Kolejność: duże grupy → mniejsze → dodatkowe (brzuch/przedramię/łydki).
- Język pól ćwiczeń: zachowaj nazwy jak powyżej.
- Uzupełnij wszystkie 7 dni tygodnia.
`.trim();

    const user = `
Tryb: ${mode}
Język interfejsu: ${lang}
Cel: ${goal}
Poziom: ${level}
Sprzęt: ${equipment}
Płeć: ${sex}
Sesji/tydzień: ${sessions}

Zwróć JSON ściśle w opisanym formacie. Bez komentarza, bez markdown.
`.trim();

    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-70b-versatile',
        temperature: 0.3,
        max_tokens: 1800,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });

    const raw = await resp.text();
    if(!resp.ok){
      return { statusCode: resp.status || 500, headers: corsHeaders(origin), body: JSON.stringify({error:'Groq error', details: raw}) };
    }

    let data; try{ data = JSON.parse(raw); }catch{ data = {}; }
    const content = (data?.choices?.[0]?.message?.content || '').trim();

    // wyciągnij czysty JSON z ewentualnych odchyleń
    let jsonText = content;
    const fence = content.match(/```json([\s\S]*?)```/i);
    if(fence) jsonText = fence[1];
    // przytnij od pierwszej { do ostatniej }
    const first = jsonText.indexOf('{'); const last = jsonText.lastIndexOf('}');
    if(first>=0 && last>=0) jsonText = jsonText.slice(first, last+1);

    let planJson = null;
    try{ planJson = JSON.parse(jsonText); }catch{ planJson = null; }

    const planName = 'Plan Treningowy';

    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: JSON.stringify({ planName, planJson, planText: content })
    };
  }catch(e){
    return { statusCode:500, headers:corsHeaders(origin), body: JSON.stringify({error:'Unhandled exception', message:String(e)}) };
  }
};
