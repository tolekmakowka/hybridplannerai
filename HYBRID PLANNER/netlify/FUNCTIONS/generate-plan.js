// netlify/functions/generate-plan.js
// Groq-only backend: builds a structured weekly plan -> XLSX (exceljs) -> returns base64

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const Excel = require('exceljs');

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

const DAYS = ['Poniedziałek','Wtorek','Środa','Czwartek','Piątek','Sobota','Niedziela'];
const COLUMNS = [
  { header: 'ĆWICZENIE', key: 'exercise', width: 28 },
  { header: 'SERIE', key: 'series', width: 7 },
  { header: 'POWTÓRZENIA', key: 'reps', width: 12 },
  { header: 'PRZERWA', key: 'rest', width: 10 },
  { header: 'RIR', key: 'rir', width: 6 },
  { header: 'RPE', key: 'rpe', width: 6 },
  { header: 'TEMPO', key: 'tempo', width: 10 },
  { header: 'KOMENTARZ / WYKONANIE', key: 'comment', width: 26 },
  { header: 'NUMER SERII', key: 'setNumber', width: 12 },
];

function safeNumber(v, def=0){
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function mockWeek() {
  // awaryjnie — gdyby Groq nie zwrócił JSON
  const ex = [
    ['Flat bench press','4','8–12','3min','X','9','', '', ''],
    ['Incline bench press','3','8–12','3min','X','8','', '', ''],
    ['Overhead press','3','8–12','3min','X','8','', '', ''],
    ['Triceps extension','3','8–12','2min','X','8','', '', ''],
    ['Lateral raise','3','8–12','2min','X','8','', '', ''],
    ['Hanging knee raises','3','8–12','2min','X','8','', '', ''],
  ];
  const toRows = a => a.map(r => ({
    exercise: r[0], series: r[1], reps: r[2], rest: r[3],
    rir: r[4], rpe: r[5], tempo: r[6], comment: r[7], setNumber: r[8]
  }));
  return {
    'Poniedziałek': toRows(ex),
    'Wtorek': toRows(ex),
    'Środa': toRows(ex),
    'Czwartek': toRows(ex),
    'Piątek': toRows([
      ['Squat','4','8–12','3min','X','9','','',''],
      ['Leg extension','3','8–12','2min','X','8','','',''],
      ['Deadlift','3','8–12','3min','X','9','','',''],
      ['Leg curl','3','8–12','2min','X','8','','',''],
      ['Calf raises','3','8–12','2min','X','8','','',''],
    ]),
    'Sobota': toRows(ex),
    'Niedziela': toRows(ex),
  };
}

async function callGroqJSON(prompt) {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not set');
  }
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.1-70b-versatile',
      temperature: 0.4,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are an experienced S&C coach. Output JSON only, no prose.'
        },
        { role: 'user', content: prompt }
      ]
    })
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Groq ${resp.status}: ${text}`);
  }
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error('Groq returned non-JSON');
  }
  return data;
}

function buildPrompt({ inputs }) {
  // Inputs: sessionsPerWeek, goal, level, equipment, gender
  const HARD_RULES = `
CEL: zaplanuj 1 tydzień siłowy w układzie 7 dni (Pon..Ndz), 5–8 ćwiczeń na dzień.
Używaj wyłącznie tych nazw ćwiczeń:
- klatka: Flat bench press, Incline bench press, Pec deck
- plecy: Lat pulldown, Close grip horizontal row, Horizontal row 45*, Bent over row
- barki: Overhead press, Face pull, Lateral raise
- biceps: Biceps curl, Hammer curl
- triceps: Triceps extension, Triceps overhead extension
- brzuch: Hanging knee raises
- przedramię: Forearm curl
- tylna taśma: Deadlift, Leg curl
- przednia taśma: Squat, Leg extension
- łydki: Calf raises

Zasady:
- 5–8 ćwiczeń/dzień; każde: 3–4 serie, 8–12 powtórzeń.
- Przerwy 2–3 min, RIR = "X", RPE głównie 8–9.
- Kolejność: duże partie → mniejsze → dodatki.
- Odstępy 24–48 h między ciężkimi bodźcami tych samych grup.
- Dni mogą być PULL / PUSH / UPPER / LOWER / FBW zgodnie z logiką odpowiedzi.

ZWRÓĆ TYLKO JSON o strukturze:

{
  "week": {
    "Poniedziałek": [
      {"exercise":"...", "series":3, "reps":"8-12", "rest":"2min", "rir":"X", "rpe":"8", "tempo":"", "comment":"", "setNumber":""},
      ...
    ],
    "Wtorek": [...],
    ...
    "Niedziela": [...]
  }
}
`.trim();

  const inputBlock = `
DANE:
- sesje/tydz: ${safeNumber(inputs.sessionsPerWeek, 4)}
- płeć: ${inputs.gender || '—'}
- cel: ${inputs.goal || '—'}
- poziom: ${inputs.level || '—'}
- sprzęt: ${inputs.equipment || '—'}
`.trim();

  return [inputBlock, HARD_RULES].join('\n\n');
}

async function makeWorkbook(weekJSON) {
  const wb = new Excel.Workbook();
  wb.creator = 'HybridPlanner';
  wb.created = new Date();

  const titleFont = { name: 'Calibri', size: 22, bold: true };
  const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCFD8DC' } }; // jasny szary
  const headerBorder = { style: 'thin', color: { argb: 'FF999999' } };
  const cellBorder = { style: 'thin', color: { argb: 'FFDDDDDD' } };

  for (const day of DAYS) {
    const ws = wb.addWorksheet(day);
    // Title row
    ws.mergeCells('A1:I1');
    const t = ws.getCell('A1');
    t.value = 'Plan Treningowy';
    t.font = titleFont;
    t.alignment = { vertical: 'middle' };
    ws.getRow(1).height = 28;

    // Header
    ws.columns = COLUMNS;
    const hr = ws.getRow(3);
    COLUMNS.forEach((c, i) => {
      const cell = ws.getCell(3, i + 1);
      cell.value = c.header;
      cell.fill = headerFill;
      cell.font = { bold: true };
      cell.border = {
        top: headerBorder, left: headerBorder, right: headerBorder, bottom: headerBorder
      };
      cell.alignment = { vertical: 'middle' };
    });
    ws.views = [{ state: 'frozen', ySplit: 3 }];

    const rows = weekJSON[day] || [];
    let r = 4;
    rows.forEach(obj => {
      const row = ws.getRow(r++);
      row.values = [
        obj.exercise || '',
        safeNumber(obj.series, 3),
        obj.reps || '8-12',
        obj.rest || '2min',
        obj.rir || 'X',
        obj.rpe || '8',
        obj.tempo || '',
        obj.comment || '',
        obj.setNumber || ''
      ];
      row.eachCell((cell) => {
        cell.border = { top: cellBorder, left: cellBorder, right: cellBorder, bottom: cellBorder };
      });
    });
    // trochę estetyki
    ws.getColumn('exercise').alignment = { wrapText: true };
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || '';

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Bad JSON' }) }; }

    const inputs = body.inputs || {};
    const prompt = buildPrompt({ inputs });

    // 1) Groq -> JSON
    let json;
    try {
      const res = await callGroqJSON(prompt);
      json = res?.week ? res : { week: res?.week || {} };
    } catch (e) {
      // awaryjnie makieta
      json = { week: mockWeek() };
    }

    // 2) Excel
    const xbuf = await makeWorkbook(json.week || mockWeek());
    const base64 = xbuf.toString('base64');

    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: JSON.stringify({
        ok: true,
        xlsxBase64: base64,
        xlsxFilename: 'Plan Treningowy.xlsx',
        model: 'groq:llama-3.1-70b-versatile'
      })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: corsHeaders(origin),
      body: JSON.stringify({ error: 'Unhandled', message: String(e && e.message || e) })
    };
  }
};
