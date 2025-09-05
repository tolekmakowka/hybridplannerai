// netlify/functions/generate-plan.js
'use strict';

const ExcelJS = require('exceljs');
const GROQ_API_KEY = process.env.GROQ_API_KEY;

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
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(origin) };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify({ ok:false, error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const inputs = body?.inputs || {};
    const {
      sessionsPerWeek = 3,
      goal = '',
      level = '',
      equipment = '',
      gender = ''
    } = inputs;

    let plan = null;
    try {
      plan = await getPlanFromGroq({ sessionsPerWeek, goal, level, equipment, gender });
    } catch (_) { plan = null; }

    // Regułowa wersja – twarde zasady dla kobiet
    const isFemale = String(gender || '').toLowerCase().includes('kobiet');
    if (!isValidPlan(plan) || !hasDiversity(plan) || isFemale) {
      plan = buildRuleBasedPlan({ sessionsPerWeek, level, equipment, goal, gender });
    }

    const { buffer, filename } = await makeSingleSheetWorkbook(plan);
    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: JSON.stringify({ ok:true, filename, fileBase64: buffer.toString('base64') })
    };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ ok:false, error: 'generate-plan failed', details: String(err) }) };
  }
};

/* ===================== Groq ===================== */
async function getPlanFromGroq({ sessionsPerWeek, goal, level, equipment, gender }) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY missing');

  const sys = `Jesteś doświadczonym trenerem S&C.
ZWRACAJ WYŁĄCZNIE POPRAWNY JSON (bez komentarzy/markdown).
Masz traktować bazę ćwiczeń jako bazę WIEDZY, a nie gotowe plany. Za każdym razem dobieraj zestawy i kolejność na nowo.
Struktura:
{ "days": [ { "day": "Poniedziałek", "exercises": [ { "cwiczenie": "...", "serie": "3×10", "powtorzenia": "10" } ] } ] }
Każdy dzień 5–8 ćwiczeń. Nazwy pól jak w przykładzie (po polsku).
Jeżeli liczba sesji < 7, podaj tylko tyle dni ile jest sesji.`;

  const user = `Dane:
- sesje/tydzień: ${sessionsPerWeek}
- cel: ${goal}
- poziom: ${level}
- sprzęt: ${equipment}
- płeć: ${gender}
Zwróć JSON zgodny ze strukturą, z realną różnorodnością między dniami.`;

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.1-70b-versatile',
      temperature: 0.35,
      messages: [{ role:'system', content: sys }, { role:'user', content: user }]
    })
  });

  if (!r.ok) throw new Error(`Groq ${r.status}: ${await r.text()}`);
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
function isValidPlan(p){ return p && Array.isArray(p.days) && p.days.length >= 1 && p.days.every(d => Array.isArray(d.exercises)); }
function hasDiversity(p){
  const sigs = (p.days || []).map(d => JSON.stringify((d.exercises||[]).map(e => (e.cwiczenie||'').toLowerCase().trim())));
  return new Set(sigs).size >= Math.ceil(sigs.length * 0.6);
}

/* ===================== Regułowy plan – priorytet dla kobiet ===================== */
function buildRuleBasedPlan({ sessionsPerWeek = 3, level='', equipment='', goal='', gender='' }) {
  const isFemale = String(gender || '').toLowerCase().includes('kobiet');
  const dni = ['Poniedziałek','Wtorek','Środa','Czwartek','Piątek','Sobota','Niedziela'];

  const multi = new Set(['hip thrust','back squat','deadlift','bulgarian split squats','flat bench press','incline bench press','overhead press','barbell row','lat pulldown','pull-up']);
  const iso   = (name) => !multi.has(name.toLowerCase());

  const R = {
    // core bank
    calves: ['Standing calf raise','Seated calf raise'],
    abs:    ['Plank','Hanging knee raises','Cable crunch'],
    upperA: ['Flat bench press','Lat pulldown','Overhead press','Barbell row','Lateral raise','Triceps extension','Biceps curl'],
    upperB: ['Incline bench press','Seated cable row','Face pull','Push-up (obciążony)','Hammer curl','Triceps rope pressdown']
  };

  const LEG_PRIMARY = ['hip thrust','back squat','deadlift','bulgarian split squats'];
  const LEG_SECOND  = ['hip adduction machine','hip adductor machine']; // naprzemiennie
  const LEG_THIRD   = ['kickback horizontal','back extension'];         // naprzemiennie

  const rep = (n) => (iso(n) ? '12' : '10');    // 10 wielostaw, 12 izolowane
  const ser = (n) => '3×' + rep(n);             // 3 serie (wymóg)

  function legDay(idx){
    const p1 = LEG_PRIMARY[idx % LEG_PRIMARY.length];
    const p2 = LEG_SECOND[idx % LEG_SECOND.length];
    const p3 = LEG_THIRD[idx % LEG_THIRD.length];

    const extras = [
      R.calves[idx % R.calves.length],
      R.abs[idx % R.abs.length],
    ];

    const rows = []
      .concat([p1, p2, p3].map(n => ({ cwiczenie: title(n), serie: ser(n), powtorzenia: rep(n) })))
      .concat(extras.map(n => ({ cwiczenie: n, serie: ser(n), powtorzenia: rep(n) })))
      .concat([{ cwiczenie: 'Incline treadmill walk', serie: 'X', powtorzenia: '20min' }]);

    return rows;
  }

  function upperDay(idx){
    const bank = (idx % 2 === 0 ? R.upperA : R.upperB).slice(0, 5);
    return bank.map(n => ({ cwiczenie: n, serie: ser(n), powtorzenia: rep(n) }));
  }

  function title(n){ return n.replace(/\b\w/g, m => m.toUpperCase()); }

  const days = [];
  const ses = Math.min(Math.max(1, sessionsPerWeek|0), 7);

  if (isFemale && ses === 3) {
    // 2× nogi + 1× góra
    const order = [legDay(0), upperDay(0), legDay(1)];
    for (let i=0;i<ses;i++){
      days.push({ day: dni[i], exercises: order[i] });
    }
  } else if (isFemale) {
    // ogólnie: priorytet nóg – co najmniej połowa dni to nogi
    const legCount = Math.ceil(ses * 0.5);
    for (let i=0;i<ses;i++){
      const exs = (i < legCount) ? legDay(i) : upperDay(i);
      days.push({ day: dni[i], exercises: exs });
    }
  } else {
    // wariant uniwersalny (nie-kobiety) – prosty UL/PPL/FBW
    const base = [['Upper'],['Lower'],['Upper'],['Lower'],['Push'],['Pull'],['Full']];
    const planNames = base.slice(0, ses).map(x=>x[0]);
    for (let i=0;i<ses;i++){
      const exs = (planNames[i] === 'Lower')
        ? legDay(i) // zadziała sensownie też dla mężczyzn
        : upperDay(i);
      days.push({ day: dni[i], exercises: exs });
    }
  }

  return { days };
}

/* ===================== Excel – tylko 3 kolumny ===================== */
async function makeSingleSheetWorkbook(plan){
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Plan', {
    properties: { defaultRowHeight: 18 },
    views: [{ state: 'normal', topLeftCell: 'B2', zoomScale: 120 }]
  });

  ws.columns = [
    { header: '', width: 4 },         // lewy margines
    { header:'ĆWICZENIE', width: 36 },
    { header:'SERIE', width: 10 },
    { header:'POWTÓRZENIA', width: 14 }
  ];

  ws.mergeCells('B1:D1');
  const t = ws.getCell('B1');
  t.value = 'Plan Treningowy';
  t.font = { name: 'Arial', size: 16, bold: true };
  t.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.addRow([]);

  const headStyle = {
    font: { bold:true, color:{argb:'FFFFFFFF'} },
    fill: { type:'pattern', pattern:'solid', fgColor:{ argb:'FF444444' } },
    alignment: { vertical:'middle', horizontal:'center' }
  };
  const dayStyle = {
    font:{ bold:true, size:13, color:{argb:'FFFFFFFF'} },
    fill:{ type:'pattern', pattern:'solid', fgColor:{ argb:'FF3E2723' } }
  };

  const trainingDays = (plan.days || []).filter(d => (d.exercises||[]).length > 0);

  for (const d of trainingDays) {
    const startRow = ws.rowCount + 1;
    ws.mergeCells(`B${startRow}:D${startRow}`);
    const cell = ws.getCell(`B${startRow}`);
    cell.value = d.day || '';
    cell.font = dayStyle.font;
    cell.fill = dayStyle.fill;

    const head = ws.addRow(ws.columns.map(c => c.header));
    head.eachCell((c, idx)=>{
      if (idx === 1) return;
      c.font = headStyle.font;
      c.fill = headStyle.fill;
      c.alignment = headStyle.alignment;
    });

    for (const ex of (d.exercises || [])) {
      ws.addRow(['', ex.cwiczenie||'', ex.serie||'', ex.powtorzenia||'']);
    }
    ws.addRow([]);
  }

  ws.pageSetup = { horizontalCentered: true };
  const buffer = await wb.xlsx.writeBuffer();
  const filename = `Plan_Treningowy_${new Date().toISOString().slice(0,10)}.xlsx`;
  return { buffer, filename };
}
