// HYBRID PLANNER/netlify/functions/generate-plan.js
// Groq + ExcelJS — generacja XLSX i zwrot base64

const ExcelJS = require('exceljs');

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// CORS (zostawiamy, ale korzystamy z wywołania same-origin, więc i tak nie będzie potrzebny)
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
      body: JSON.stringify({ ok: false, error: 'Method not allowed' })
    };
  }

  try {
    if (!GROQ_API_KEY) {
      return {
        statusCode: 500,
        headers: corsHeaders(origin),
        body: JSON.stringify({ ok: false, error: 'GROQ_API_KEY not set' })
      };
    }

    // Odczyt payloadu z frontu
    let payload = {};
    try { payload = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ ok:false, error:'Bad JSON' })}; }

    const { lang = 'pl', type = 'A', inputs = {} } = payload;

    // Budujemy prompt -> chcemy CZYSTY JSON (dni tygodnia => lista ćwiczeń)
    const system = `You are an experienced strength & conditioning coach. 
Return ONLY strict JSON (no markdown, no code fences).
JSON schema:
{
 "Poniedziałek":[{"cwiczenie":"","serie":"","powt":"","przerwa":"","rir":"","rpe":"","tempo":"","komentarz":""}, ...],
 "Wtorek":[ ... ],
 "Środa":[ ... ],
 "Czwartek":[ ... ],
 "Piątek":[ ... ],
 "Sobota":[ ... ],
 "Niedziela":[ ... ]
}
- Language of fields and exercise names: ${lang.toLowerCase().startsWith('en') ? 'English' : 'Polish'}.
- Exercises must use ONLY this allowed pool:
  klatka: Flat bench press, Incline bench press, Pec deck
  plecy: Lat pulldown, Close grip horizontal row, Horizontal row 45*, Bent over row
  barki: Overhead press, Face pull, Lateral raise
  biceps: Biceps curl, Hammer curl
  triceps: Triceps extension, Triceps overhead extension
  brzuch: Hanging knee raises
  przedramię: Forearm curl
  tylna taśma kończyn dolnych: Deadlift, Leg curl
  przednia taśma kończyn dolnych: Squat, Leg extension
  łydki: Calf raises
- Each training day must include 5–8 exercises.
- Each exercise: reps 8–12, sets 3–4.
- Keep 24–48h spacing for same muscle groups.
- Choose split based on inputs.
- Do not include any text outside JSON.`;

    const user = `
[Inputs]
sessionsPerWeek: ${inputs.sessionsPerWeek ?? '-'}
goal: ${inputs.goal ?? '-'}
level: ${inputs.level ?? '-'}
equipment: ${inputs.equipment ?? '-'}
sex: ${inputs.sex ?? '-'}
language: ${lang}
    `.trim();

    // WOŁANIE GROQ (chat.completions-compat)
    let planJSON = null;
    try {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.1-70b-versatile',
          temperature: 0.4,
          max_tokens: 1800,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ]
        })
      });

      const raw = await resp.text();
      if (!resp.ok) {
        throw new Error(`Groq HTTP ${resp.status}: ${raw.slice(0,300)}`);
      }
      let data; try { data = JSON.parse(raw); } catch { data = {}; }
      let text = data?.choices?.[0]?.message?.content || '';
      // usuwanie ewentualnych fence'ów
      text = text.replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
      planJSON = JSON.parse(text);
    } catch (e) {
      // fallback prosty szkic (żeby front nie wybuchał)
      planJSON = {
        "Poniedziałek": [
          {"cwiczenie":"Flat bench press","serie":"4","powt":"8–12","przerwa":"3min","rir":"1","rpe":"8","tempo":"2-0-2","komentarz":""},
          {"cwiczenie":"Incline bench press","serie":"3","powt":"8–12","przerwa":"2min","rir":"1","rpe":"8","tempo":"2-0-2","komentarz":""},
          {"cwiczenie":"Overhead press","serie":"3","powt":"8–12","przerwa":"2min","rir":"1","rpe":"8","tempo":"2-0-2","komentarz":""},
          {"cwiczenie":"Triceps extension","serie":"3","powt":"8–12","przerwa":"2min","rir":"1","rpe":"8","tempo":"2-0-2","komentarz":""},
          {"cwiczenie":"Lateral raise","serie":"3","powt":"8–12","przerwa":"2min","rir":"1","rpe":"8","tempo":"2-0-2","komentarz":""},
          {"cwiczenie":"Hanging knee raises","serie":"3","powt":"8–12","przerwa":"2min","rir":"1","rpe":"8","tempo":"2-0-2","komentarz":""}
        ],
        "Wtorek": [],
        "Środa": [
          {"cwiczenie":"Lat pulldown","serie":"4","powt":"8–12","przerwa":"3min","rir":"1","rpe":"8","tempo":"2-0-2","komentarz":""},
          {"cwiczenie":"Horizontal row 45*","serie":"3","powt":"8–12","przerwa":"2min","rir":"1","rpe":"8","tempo":"2-0-2","komentarz":""},
          {"cwiczenie":"Bent over row","serie":"3","powt":"8–12","przerwa":"2min","rir":"1","rpe":"8","tempo":"2-0-2","komentarz":""},
          {"cwiczenie":"Biceps curl","serie":"3","powt":"8–12","przerwa":"2min","rir":"1","rpe":"8","tempo":"2-0-2","komentarz":""},
          {"cwiczenie":"Hammer curl","serie":"3","powt":"8–12","przerwa":"2min","rir":"1","rpe":"8","tempo":"2-0-2","komentarz":""},
          {"cwiczenie":"Forearm curl","serie":"3","powt":"8–12","przerwa":"2min","rir":"1","rpe":"8","tempo":"2-0-2","komentarz":""}
        ],
        "Czwartek": [],
        "Piątek": [
          {"cwiczenie":"Squat","serie":"4","powt":"8–12","przerwa":"3min","rir":"1","rpe":"9","tempo":"2-0-2","komentarz":""},
          {"cwiczenie":"Leg extension","serie":"3","powt":"8–12","przerwa":"2min","rir":"1","rpe":"8","tempo":"2-0-2","komentarz":""},
          {"cwiczenie":"Deadlift","serie":"3","powt":"8–12","przerwa":"3min","rir":"1","rpe":"9","tempo":"2-0-2","komentarz":""},
          {"cwiczenie":"Leg curl","serie":"3","powt":"8–12","przerwa":"2min","rir":"1","rpe":"8","tempo":"2-0-2","komentarz":""},
          {"cwiczenie":"Calf raises","serie":"3","powt":"8–12","przerwa":"2min","rir":"1","rpe":"8","tempo":"2-0-2","komentarz":""}
        ],
        "Sobota": [],
        "Niedziela": []
      };
    }

    // === XLSX ===
    const wb = new ExcelJS.Workbook();
    wb.creator = 'HybridPlanner';
    wb.created = new Date();

    const dni = ["Poniedziałek","Wtorek","Środa","Czwartek","Piątek","Sobota","Niedziela"];
    const header = ["ĆWICZENIE","SERIE","POWTÓRZENIA","PRZERWA","RIR","RPE","TEMPO","KOMENTARZ / WYKONANIE","NUMER SERII"];

    for (const dzien of dni) {
      const ws = wb.addWorksheet(dzien, { views: [{ state:'frozen', ySplit:1 }] });

      // wiersz nagłówkowy
      ws.addRow(header);
      const h = ws.getRow(1);
      h.font = { bold: true };
      h.alignment = { vertical:'middle', horizontal:'center' };

      ws.columns = [
        { key:'cw', width:28 },
        { key:'se', width:8 },
        { key:'po', width:14 },
        { key:'pr', width:10 },
        { key:'rir', width:6 },
        { key:'rpe', width:6 },
        { key:'te', width:10 },
        { key:'ko', width:34 },
        { key:'ns', width:12 },
      ];

      const lista = Array.isArray(planJSON?.[dzien]) ? planJSON[dzien] : [];
      for (const ex of lista) {
        ws.addRow([
          ex.cwiczenie ?? '',
          String(ex.serie ?? ''),
          String(ex.powt ?? ''),
          String(ex.przerwa ?? ''),
          String(ex.rir ?? ''),
          String(ex.rpe ?? ''),
          String(ex.tempo ?? ''),
          ex.komentarz ?? '',
          ''
        ]);
      }

      // delikatna ramka wokół danych
      const lastRow = ws.lastRow?.number || 1;
      for (let r=1; r<=lastRow; r++){
        for (let c=1; c<=header.length; c++){
          const cell = ws.getCell(r,c);
          cell.border = { top:{style:'thin',color:{argb:'FFDDDDDD'}},
                          left:{style:'thin',color:{argb:'FFDDDDDD'}},
                          right:{style:'thin',color:{argb:'FFDDDDDD'}},
                          bottom:{style:'thin',color:{argb:'FFDDDDDD'}} };
        }
      }
    }

    const filename = lang.toLowerCase().startsWith('en') ? 'Training Plan.xlsx' : 'Plan Treningowy.xlsx';
    const buf = await wb.xlsx.writeBuffer();
    const base64 = Buffer.from(buf).toString('base64');

    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: JSON.stringify({ ok: true, filename, fileBase64: base64 })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: corsHeaders(origin),
      body: JSON.stringify({ ok:false, error: String(e && e.message ? e.message : e) })
    };
  }
};
