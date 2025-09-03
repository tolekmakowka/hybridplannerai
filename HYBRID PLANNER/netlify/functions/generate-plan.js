// netlify/functions/generate-plan.js
'use strict';

const ExcelJS = require('exceljs');

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Dozwolone originy (CORS)
const ALLOWED_ORIGINS = new Set([
  'https://tgmproject.net',
  'https://www.tgmproject.net',
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
      body: JSON.stringify({ ok:false, error: 'Method not allowed' })
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const inputs = body?.inputs || {};
    const {
      sessionsPerWeek = 4,
      goal = '',
      level = '',
      equipment = '',
      gender = ''
    } = inputs;

    // 1) Spróbuj Groq
    let plan = null;
    try {
      plan = await getPlanFromGroq({ sessionsPerWeek, goal, level, equipment, gender });
    } catch (_) {
      plan = null;
    }

    // 2) Walidacja + różnorodność; jeśli coś nie gra → fallback
    if (!isValidPlan(plan) || !hasDiversity(plan)) {
      plan = buildVariedPlan({ sessionsPerWeek, level, equipment, goal, gender });
    }

    // 3) Excel – jeden arkusz; tylko dni z treningami, 3 kolumny
    const { buffer, filename } = await makeSingleSheetWorkbook(plan, { level, seed: Date.now() });

    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: JSON.stringify({ ok:true, filename, fileBase64: buffer.toString('base64') })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin || ''),
      body: JSON.stringify({ ok:false, error: 'generate-plan failed', details: String(err) })
    };
  }
};

/* ===================== Groq ===================== */
async function getPlanFromGroq({ sessionsPerWeek, goal, level, equipment, gender }) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY missing');

  const sys = `Jesteś doświadczonym trenerem S&C.
ZWRACAJ WYŁĄCZNIE POPRAWNY JSON (bez komentarzy/markdown).
Masz traktować bazę ćwiczeń jako bazę WIEDZY (zestaw typowych ruchów i wariantów), a nie gotowe plany.
Za każdym razem dobieraj zestawy i kolejność na nowo (rzeczywista różnorodność).
Struktura:
{
  "days": [
    {
      "day": "Poniedziałek",
      "exercises": [
        { "cwiczenie": "...", "serie": "4×8–12", "powtorzenia": "8–12", "przerwa": "2–3 min", "rir": "1–3", "rpe": "7–9", "tempo": "30X1", "komentarz": "" }
      ]
    }
  ]
}
Wygeneruj ZRÓŻNICOWANY układ w skali tygodnia (np. PPL/UL/FBW – bez powtarzania identycznych zestawów).
Każdy dzień 5–8 ćwiczeń. Nazwy pól jak w przykładzie (po polsku).
Jeżeli liczba sesji jest mniejsza niż 7, podaj tylko tyle dni ile jest sesji.`;

  const user = `Dane:
- sesje/tydzień: ${sessionsPerWeek}
- cel: ${goal}
- poziom: ${level}
- sprzęt: ${equipment}
- płeć: ${gender}
Dni w kolejności: Poniedziałek, Wtorek, Środa, Czwartek, Piątek, Sobota, Niedziela.
Nie kopiuj sztywnego schematu – dobieraj ćwiczenia na podstawie wytycznych.`;

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.1-70b-versatile',
      temperature: 0.35, // trochę większa losowość
      messages: [
        { role:'system', content: sys },
        { role:'user',   content: user }
      ]
    })
  });

  if (!r.ok) {
    throw new Error(`Groq ${r.status}: ${await r.text()}`);
  }
  const data = await r.json();
  const txt  = data?.choices?.[0]?.message?.content?.trim() || '';
  const json = extractJson(txt);
  return json;
}

function extractJson(txt){
  const m = txt.match(/```json\s*([\s\S]*?)\s*```/i);
  const raw = m ? m[1] : txt;
  return JSON.parse(raw);
}

/* ===================== Walidacja + różnorodność ===================== */
function isValidPlan(p){
  return p && Array.isArray(p.days) && p.days.length >= 1 && p.days.every(d => Array.isArray(d.exercises));
}

function hasDiversity(p){
  const sigs = (p.days || []).map(d => {
    const names = (d.exercises || []).map(e => (e.cwiczenie||'').toLowerCase().trim()).filter(Boolean);
    return JSON.stringify(names);
  });
  const uniq = new Set(sigs);
  return uniq.size >= Math.ceil(sigs.length * 0.6); // >≈40% powtórek → za mała różnorodność
}

/* ===================== PRNG do kontrolowanej losowości ===================== */
function cyrb53(str, seed=0){
  let h1=0xdeadbeef ^ seed, h2=0x41c6ce57 ^ seed;
  for (let i=0; i<str.length; i++){
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1>>>16), 2246822507) ^ Math.imul(h2 ^ (h2>>>13), 3266489909);
  h2 = Math.imul(h2 ^ (h2>>>16), 2246822507) ^ Math.imul(h1 ^ (h1>>>13), 3266489909);
  return (h2>>>0) * 4294967296 + (h1>>>0);
}
function mulberry32(a){
  return function(){
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rnd){
  const a = arr.slice();
  for (let i=a.length-1; i>0; i--){
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function rotate(arr, k){
  const a = arr.slice();
  const n = a.length; if (!n) return a;
  k = ((k % n) + n) % n;
  return a.slice(k).concat(a.slice(0, k));
}

/* ===================== Fallback: zróżnicowany plan ===================== */
function buildVariedPlan({ sessionsPerWeek = 4, level='', equipment='', goal='', gender='' }) {
  const dni = ['Poniedziałek','Wtorek','Środa','Czwartek','Piątek','Sobota','Niedziela'];

  // PRNG: różny plan przy tych samych odpowiedziach
  const seedStr = JSON.stringify({ sessionsPerWeek, level, equipment, goal, gender }) + '|' + Date.now();
  const rnd = mulberry32(cyrb53(seedStr));

  // Dobór splitu – realne klucze + losowa rotacja
  let split;
  if (sessionsPerWeek <= 3) split = ['FBW A','FBW B','FBW C'];
  else if (sessionsPerWeek === 4) split = ['Upper','Lower','Upper','Lower'];
  else if (sessionsPerWeek === 5) split = ['Upper','Lower','Push','Pull','Full'];
  else if (sessionsPerWeek === 6) split = ['Push','Pull','Legs','Push','Pull','Legs'];
  else split = ['Upper','Lower','Push','Pull','Full','Legs','Akcesoria/Core'];
  split = rotate(split, Math.floor(rnd() * split.length));

  // biblioteka ćwiczeń
  const LIB = {
    Push: [
      'Flat bench press','Incline bench press','Overhead press',
      'Dips (asysta w razie potrzeby)','Lateral raise','Triceps extension','Cable fly','Push-up (obciążony)'
    ],
    Pull: [
      'Lat pulldown','Barbell row','Seated cable row',
      'Face pull','Biceps curl','Hammer curl','Pull-up (asysta)'
    ],
    Legs: [
      'Back squat','Romanian deadlift','Leg press',
      'Lunge (chodzony)','Leg curl','Calf raises','Hip thrust'
    ],
    Upper: [
      'Flat bench press','Overhead press','Lat pulldown',
      'Barbell row','Lateral raise','Face pull','Biceps curl','Triceps extension'
    ],
    Lower: [
      'Back squat','Romanian deadlift','Leg press',
      'Leg curl','Calf raises','Hanging knee raises','Hip thrust'
    ],
    Full: [
      'Back squat','Flat bench press','Barbell row',
      'Hip thrust','Lat pulldown','Plank'
    ],
    'Akcesoria/Core': [
      'Back extension','Hip thrust','Face pull',
      'Lateral raise','Biceps curl','Triceps extension','Plank'
    ],
    'FBW A': [
      'Back squat','Flat bench press','Lat pulldown',
      'Romanian deadlift','Overhead press','Plank'
    ],
    'FBW B': [
      'Deadlift (sub: RDL)','Incline bench press','Barbell row',
      'Lunge (chodzony)','Dips (asysta)','Hanging knee raises'
    ],
    'FBW C': [
      'Front squat','Overhead press','Seated cable row',
      'Hip thrust','Pull-ups (asysta)','Side plank'
    ]
  };

  function baseKey(n){
    const s = String(n).toLowerCase();
    if (s.startsWith('upper')) return 'Upper';
    if (s.startsWith('lower')) return 'Lower';
    if (s.startsWith('push'))  return 'Push';
    if (s.startsWith('pull'))  return 'Pull';
    if (s.startsWith('legs'))  return 'Legs';
    if (s.startsWith('full'))  return 'Full';
    if (s.includes('akcesoria')) return 'Akcesoria/Core';
    if (s.startsWith('fbw a')) return 'FBW A';
    if (s.startsWith('fbw b')) return 'FBW B';
    if (s.startsWith('fbw c')) return 'FBW C';
    return n;
  }

  function row(name){
    const zaaw = level.toLowerCase().includes('zaaw');
    return {
      cwiczenie: name,
      serie: zaaw ? '4×6–10' : '3×8–12',
      powtorzenia: zaaw ? '6–10' : '8–12',
      przerwa: '2–3 min',
      rir: '1–3',
      rpe: '7–9',
      tempo: '30X1',
      komentarz: ''
    };
  }

  function pack(name){
    const key  = baseKey(name);
    const base = LIB[key] || [];
    const cnt  = 5 + Math.floor(rnd() * 4); // 5–8 ćwiczeń
    const picks = shuffle(base, rnd).slice(0, cnt);
    return picks.map(x => row(x));
  }

  // pierwsze N dni to trening; reszta pomijana (nie będziemy ich dodawać do Excela)
  const days = [];
  for (let i = 0; i < Math.min(sessionsPerWeek, 7); i++){
    const dayName = ['Poniedziałek','Wtorek','Środa','Czwartek','Piątek','Sobota','Niedziela'][i];
    const tp = split[i % split.length];
    days.push({ day: dayName, exercises: pack(tp) });
  }

  return { days };
}

/* ===================== Pomocnicze: parsowanie serii / dokładna liczba powt. ===================== */
function parseSeriesCount(serieStr, level) {
  if (typeof serieStr === 'string') {
    // szukamy liczby przed znakiem x/× (np. "4×8–12", "3x10")
    const m = serieStr.match(/(\d+)\s*[x×]/i);
    if (m) return parseInt(m[1], 10);
    // czasem ktoś poda samo "4"
    const m2 = serieStr.match(/^\s*(\d+)\s*$/);
    if (m2) return parseInt(m2[1], 10);
  }
  // domyślnie wg poziomu
  return (String(level).toLowerCase().includes('zaaw')) ? 4 : 3;
}

/* ===================== Excel – jeden arkusz (wyśrodkowany widok, 3 kolumny) ===================== */
async function makeSingleSheetWorkbook(plan, { level = '', seed = Date.now() } = {}) {
  const rnd = mulberry32(cyrb53(String(seed)));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Plan', {
    properties: { defaultRowHeight: 18 },
    views: [{ state: 'normal', topLeftCell: 'B2', zoomScale: 120 }]
  });

  // lewy margines (pusta kolumna), potem właściwa tabela
  ws.columns = [
    { header: '', width: 4 }, // margines z lewej (A)
    { header:'ĆWICZENIE', width: 36 },   // B
    { header:'SERIE', width: 10 },       // C
    { header:'POWTÓRZENIA', width: 16 }  // D
  ];

  // tytuł na środku „bloku”
  ws.mergeCells('B1:D1');
  const title = ws.getCell('B1');
  title.value = 'Plan Treningowy';
  title.font = { name: 'Arial', size: 16, bold: true };
  title.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.addRow([]);

  const headerStyle = {
    font: { bold: true, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF444444' } },
    alignment: { vertical: 'middle', horizontal: 'center' }
  };
  const dayFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3E2723' } };
  const dayFont = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };

  // wyłącznie dni z treningami
  const trainingDays = (plan.days || []).filter(d => (d.exercises || []).length > 0);

  for (const d of trainingDays) {
    const startRow = ws.rowCount + 1;
    ws.mergeCells(`B${startRow}:D${startRow}`);
    const cell = ws.getCell(`B${startRow}`);
    cell.value = d.day || '';
    cell.font = dayFont;
    cell.fill = dayFill;
    cell.alignment = { vertical: 'middle', horizontal: 'left' };

    // nagłówek tabeli
    const headRow = ws.addRow(['', 'ĆWICZENIE', 'SERIE', 'POWTÓRZENIA']);
    headRow.height = 20;
    // stylujemy tylko kolumny B–D (2–4)
    [2,3,4].forEach(col => {
      const c = headRow.getCell(col);
      c.font = headerStyle.font;
      c.fill = headerStyle.fill;
      c.alignment = headerStyle.alignment;
      c.border = {
        top:{style:'thin', color:{argb:'FF666666'}},
        left:{style:'thin', color:{argb:'FF666666'}},
        bottom:{style:'thin', color:{argb:'FF666666'}},
        right:{style:'thin', color:{argb:'FF666666'}}
      };
    });

    // wiersze ćwiczeń
    for (const ex of (d.exercises || [])) {
      // SERIE: tylko liczba
      const seriesCount = parseSeriesCount(ex.serie || ex.series || '', level);
      // POWTÓRZENIA: dokładna liczba 8–12 (lekka losowość)
      const reps = 8 + Math.floor(rnd() * 5); // 8..12

      const r = ws.addRow(['', ex.cwiczenie || '', seriesCount, reps]);
      [2,3,4].forEach(col => {
        const c = r.getCell(col);
        c.border = {
          top:{style:'thin', color:{argb:'FFDDDDDD'}},
          left:{style:'thin', color:{argb:'FFDDDDDD'}},
          bottom:{style:'thin', color:{argb:'FFDDDDDD'}},
          right:{style:'thin', color:{argb:'FFDDDDDD'}}
        };
        if (col !== 2) c.alignment = { horizontal: 'center' };
      });
    }

    ws.addRow([]); // odstęp między dniami
  }

  // wyśrodkowanie podczas druku (opcjonalnie)
  ws.pageSetup = { horizontalCentered: true };

  const buffer = await wb.xlsx.writeBuffer();
  const filename = `Plan_Treningowy_${new Date().toISOString().slice(0,10)}.xlsx`;
  return { buffer, filename };
}
