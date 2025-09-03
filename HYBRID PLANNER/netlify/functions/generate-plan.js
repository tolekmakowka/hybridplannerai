// netlify/functions/generate-plan.js
'use strict';

const ExcelJS = require('exceljs');

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// CORS — dozwolone originy
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

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify({ ok:false, error:'Method not allowed' }) };
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

    // 1) Groq — plan AI zoptymalizowany pod cel
    let plan = null;
    try {
      plan = await getPlanFromGroq({ sessionsPerWeek, goal, level, equipment, gender });
    } catch (_) {
      plan = null;
    }

    // 2) Walidacja jakości + różnorodność; jeśli słabe/niepełne → heurystyczny plan “coach-grade”
    if (!isGoodPlan(plan, sessionsPerWeek)) {
      plan = buildHeuristicPlan({ sessionsPerWeek, goal, level, equipment, gender });
    }

    // 3) XLSX: jeden arkusz; tylko dni z treningami; 3 kolumny
    const { buffer, filename } = await makeSingleSheetWorkbook(plan, { level, seed: Date.now() });

    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: JSON.stringify({ ok:true, filename, fileBase64: buffer.toString('base64') })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders(origin),
      body: JSON.stringify({ ok:false, error:'generate-plan failed', details: String(err) })
    };
  }
};

/* ===================== 1) GROQ (AI) ===================== */
async function getPlanFromGroq({ sessionsPerWeek, goal, level, equipment, gender }) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY missing');

  // —— SYSTEM PROMPT: wyraźne zasady jakości i format
  const sys = `Jesteś doświadczonym trenerem S&C. Twoim zadaniem jest ułożyć
optymalny, skuteczny plan siłowy dopasowany do celu, poziomu i dostępnego sprzętu.
Zasady jakości:
- Każdy dzień ma układ "najpierw złożone ruchy (compound), potem akcesoria".
- Zachowana równowaga wzorców: przysiad, hinge, pchanie, ciągnięcie, unilateral, core.
- Dobieraj wolumen inteligentnie względem celu (siła/hipertrofia/redukcja).
- Unikaj identycznych dni; progresja bodźców w skali tygodnia.
- Uwzględniaj ograniczenia sprzętowe (np. tylko hantle/drążek → dobieraj warianty).
- Język polski, nazwy ćwiczeń po polsku lub powszechne angielskie (np. "Flat bench press").

ZWRACAJ WYŁĄCZNIE POPRAWNY JSON bez komentarzy/markdown.
FORMAT:
{
  "days": [
    {
      "day": "Poniedziałek",
      "exercises": [
        { "cwiczenie": "Flat bench press", "serie": 4, "powtorzenia": 8 }
      ]
    }
  ]
}

Wymagania dodatkowe:
- Ćwiczenia mają mieć TYLKO trzy pola: "cwiczenie" (string), "serie" (int), "powtorzenia" (int 8–12 dla hipertrofii; 3–6 dla siły; 10–15 przy redukcji – możesz adaptować).
- 5–8 ćwiczeń na dzień (zależnie od celu/poziomu).
- Zwracaj dokładnie tyle dni, ile wynosi "sesje/tydzień".`;

  // —— USER PROMPT: kontekst użytkownika
  const user = `Dane wejściowe:
- sesje/tydzień: ${sessionsPerWeek}
- cel: ${goal}
- poziom: ${level}
- sprzęt: ${equipment}
- płeć: ${gender}

Ułóż najlepszy możliwy tygodniowy plan (liczba dni == sesje/tydzień).
Pamiętaj: tylko pola "cwiczenie", "serie", "powtorzenia" – liczby całkowite.
Dni nazwij po polsku: Poniedziałek, Wtorek, Środa, Czwartek, Piątek, Sobota, Niedziela.`;

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.1-70b-versatile',
      temperature: 0.55,             // trochę kreatywności dla różnorodności
      presence_penalty: 0.3,
      frequency_penalty: 0.2,
      messages: [
        { role: 'system', content: sys },
        { role: 'user',   content: user }
      ]
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

/* ===================== 2) Walidacja jakości ===================== */
function isGoodPlan(p, sessionsPerWeek){
  if (!p || !Array.isArray(p.days)) return false;
  if (p.days.length !== Math.min(sessionsPerWeek, 7)) return false;

  // każdy dzień 4–9 ćwiczeń i poprawne pola liczbowe
  for (const d of p.days) {
    if (!Array.isArray(d.exercises) || d.exercises.length < 4 || d.exercises.length > 9) return false;
    for (const e of d.exercises) {
      if (typeof e?.cwiczenie !== 'string') return false;
      if (!Number.isFinite(Number(e?.serie))) return false;
      if (!Number.isFinite(Number(e?.powtorzenia))) return false;
    }
  }

  // zgrubna różnorodność – nie wszystkie dni identyczne
  const sigs = p.days.map(d => JSON.stringify((d.exercises||[]).map(e => (e.cwiczenie||'').toLowerCase().trim())));
  const uniq = new Set(sigs);
  return uniq.size >= Math.ceil(sigs.length * 0.6);
}

/* ===================== 3) Heurystyczny plan “coach-grade” ===================== */

function goalType(goal=''){
  const g = goal.toLowerCase();
  if (g.includes('sił') || g.includes('moc') || g.includes('strength')) return 'strength';
  if (g.includes('redukc') || g.includes('fat') || g.includes('spal')) return 'cut';
  return 'hypertrophy';
}

function equipmentProfile(eq=''){
  const s = eq.toLowerCase();
  if (s.includes('hant') && s.includes('drąż')) return 'db_bar';
  if (s.includes('hant')) return 'db';
  if (s.includes('drąż')) return 'bar';
  if (s.includes('dom')) return 'home';
  if (s.includes('pełna') || s.includes('siłownia') || s.includes('gym')) return 'gym';
  return 'gym';
}

function setRepFor(goal, isAccessory=false){
  if (goal==='strength') return { sets: isAccessory?3:5, reps: isAccessory?6:4 };
  if (goal==='cut')       return { sets: isAccessory?3:4, reps: isAccessory?12:10 };
  return                   { sets: isAccessory?3:4, reps: isAccessory?12:9 }; // hypertrofia default
}

const LIBRARY = {
  squat:      { gym:['Back squat','Front squat'], db:['Goblet squat'], home:['Goblet squat'], db_bar:['Goblet squat'], bar:['Bulgarian split squat'] },
  hinge:      { gym:['Romanian deadlift','Deadlift'], db:['DB Romanian deadlift'], home:['Hip hinge (band/DB)'], db_bar:['DB Romanian deadlift'], bar:['Hip hinge (bar)'] },
  horizontalP:{ gym:['Flat bench press','Incline bench press'], db:['DB bench press','DB incline press'], home:['Push-up (obciążony)'], db_bar:['DB bench press'], bar:['Push-up'] },
  verticalP:  { gym:['Overhead press'], db:['DB overhead press'], home:['Pike push-up'], db_bar:['DB overhead press'], bar:['Pike push-up'] },
  horizontalR:{ gym:['Barbell row','Seated cable row'], db:['DB row'], home:['Body row (stół/poręcze)'], db_bar:['DB row'], bar:['Australian pull-up'] },
  verticalR:  { gym:['Lat pulldown','Pull-up (asysta)'], db:['DB pullover'], home:['Pull-up (asysta)'], db_bar:['Pull-up (asysta)'], bar:['Pull-up (asysta)'] },
  unilateral: { gym:['Lunge (chodzony)','Bulgarian split squat'], db:['DB lunge','Bulgarian split squat'], home:['Split squat'], db_bar:['DB lunge'], bar:['Split squat'] },
  pushAcc:    { gym:['Dips (asysta)','Cable fly','Lateral raise','Triceps extension'], db:['DB lateral raise','DB triceps extension'], home:['Diamond push-up'], db_bar:['DB lateral raise'], bar:['Diamond push-up'] },
  pullAcc:    { gym:['Face pull','Rear delt fly','Biceps curl','Hammer curl'], db:['DB curl','Hammer curl'], home:['Band face pull'], db_bar:['DB curl'], bar:['Band face pull'] },
  core:       { gym:['Plank','Hanging knee raises'], db:['Hanging knee raises'], home:['Plank'], db_bar:['Hanging knee raises'], bar:['Hanging knee raises'] },
  calves:     { gym:['Calf raises'], db:['DB calf raises'], home:['Calf raises'], db_bar:['DB calf raises'], bar:['Calf raises'] },
  hipthrust:  { gym:['Hip thrust'], db:['DB hip thrust'], home:['Hip thrust (jednonóż)'], db_bar:['DB hip thrust'], bar:['Hip thrust (jednonóż)'] },
  legcurl:    { gym:['Leg curl'], db:['DB leg curl (improv)'], home:['Nordic curl (asysta)'], db_bar:['DB leg curl (improv)'], bar:['Nordic curl (asysta)'] }
};

function pick(key, prof, n=1){
  const list = LIBRARY[key]?.[prof] || LIBRARY[key]?.gym || [];
  const arr = list.slice();
  // prosta rotacja
  for (let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; }
  return arr.slice(0,n);
}

function dayUpper(goal, prof){
  const main  = [...pick('horizontalP',prof,1), ...pick('verticalP',prof,1), ...pick('horizontalR',prof,1), ...pick('verticalR',prof,1)];
  const acc   = [...pick('pushAcc',prof,2), ...pick('pullAcc',prof,1)];
  return main.concat(acc).map((name,i) => {
    const sr = setRepFor(goal, i>=3); // pierwsze 3–4 to kompoundy
    return { cwiczenie:name, serie:sr.sets, powtorzenia:sr.reps };
  });
}
function dayLower(goal, prof){
  const main  = [...pick('squat',prof,1), ...pick('hinge',prof,1), ...pick('unilateral',prof,1)];
  const acc   = [...pick('legcurl',prof,1), ...pick('hipthrust',prof,1), ...pick('calves',prof,1), ...pick('core',prof,1)];
  return main.concat(acc).map((name,i) => {
    const sr = setRepFor(goal, i>=2);
    return { cwiczenie:name, serie:sr.sets, powtorzenia:sr.reps };
  });
}
function dayPush(goal, prof){
  const main = [...pick('horizontalP',prof,1), ...pick('verticalP',prof,1)];
  const acc  = [...pick('pushAcc',prof,3)];
  return main.concat(acc).map((name,i)=>({ ...setRepFor(goal, i>=2), cwiczenie:name, serie:setRepFor(goal,i>=2).sets, powtorzenia:setRepFor(goal,i>=2).reps }));
}
function dayPull(goal, prof){
  const main = [...pick('horizontalR',prof,1), ...pick('verticalR',prof,1)];
  const acc  = [...pick('pullAcc',prof,3)];
  return main.concat(acc).map((name,i)=>({ cwiczenie:name, serie:setRepFor(goal,i>=2).sets, powtorzenia:setRepFor(goal,i>=2).reps }));
}
function dayFull(goal, prof){
  const blocks = [
    ...pick('squat',prof,1),
    ...pick('hinge',prof,1),
    ...pick('horizontalP',prof,1),
    ...pick('horizontalR',prof,1),
    ...pick('core',prof,1)
  ];
  return blocks.map((name,i)=>({ cwiczenie:name, serie:setRepFor(goal,i>=2).sets, powtorzenia:setRepFor(goal,i>=2).reps }));
}

function buildHeuristicPlan({ sessionsPerWeek=4, goal='', level='', equipment='', gender='' }){
  const g    = goalType(goal);
  const prof = equipmentProfile(equipment);
  const daysNames = ['Poniedziałek','Wtorek','Środa','Czwartek','Piątek','Sobota','Niedziela'];

  let split;
  if (sessionsPerWeek<=1) split = ['Full'];
  else if (sessionsPerWeek===2) split = ['Full','Full'];
  else if (sessionsPerWeek===3) split = ['FBW A','FBW B','FBW C'];
  else if (sessionsPerWeek===4) split = ['Upper','Lower','Upper','Lower'];
  else if (sessionsPerWeek===5) split = ['Upper','Lower','Push','Pull','Full'];
  else if (sessionsPerWeek===6) split = ['Push','Pull','Legs','Push','Pull','Legs'];
  else split = ['Upper','Lower','Push','Pull','Full','Legs','Akcesoria'];

  const days = [];
  for (let i=0;i<Math.min(sessionsPerWeek,7);i++){
    const tp = split[i % split.length];
    let exercises;
    if (tp==='Upper') exercises = dayUpper(g,prof);
    else if (tp==='Lower' || tp==='Legs') exercises = dayLower(g,prof);
    else if (tp==='Push')  exercises = dayPush(g,prof);
    else if (tp==='Pull')  exercises = dayPull(g,prof);
    else                   exercises = dayFull(g,prof);

    // urealnij długość dnia (5–8 zadań)
    if (exercises.length<5) while(exercises.length<5) exercises.push(...pick('core',prof,1).map(n=>({ cwiczenie:n, ...setRepFor(g,true), serie:setRepFor(g,true).sets, powtorzenia:setRepFor(g,true).reps })));
    if (exercises.length>8) exercises = exercises.slice(0,8);

    days.push({ day: daysNames[i], exercises });
  }
  return { days };
}

/* ===================== 4) XLSX — jeden arkusz, 3 kolumny ===================== */

function parseSeriesCount(serieOrSeries, level) {
  if (typeof serieOrSeries === 'number' && Number.isFinite(serieOrSeries)) return Math.max(1, Math.floor(serieOrSeries));
  const s = String(serieOrSeries || '').trim();
  const m = s.match(/(\d+)\s*[x×]?/i);
  if (m) return parseInt(m[1],10);
  return (String(level).toLowerCase().includes('zaaw')) ? 4 : 3;
}

async function makeSingleSheetWorkbook(plan, { level = '', seed = Date.now() } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Plan', {
    properties: { defaultRowHeight: 18 },
    views: [{ state: 'normal', topLeftCell: 'B2', zoomScale: 120 }]
  });

  // kolumny: margines + 3
  ws.columns = [
    { header: '', width: 4 },     // A margines
    { header: 'ĆWICZENIE', width: 38 },  // B
    { header: 'SERIE', width: 10 },      // C (liczba)
    { header: 'POWTÓRZENIA', width: 16 } // D (liczba)
  ];

  ws.mergeCells('B1:D1');
  const title = ws.getCell('B1');
  title.value = 'Plan Treningowy';
  title.font = { name: 'Arial', size: 16, bold: true };
  title.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.addRow([]);

  const headStyle = {
    font: { bold: true, color: { argb:'FFFFFFFF' } },
    fill: { type:'pattern', pattern:'solid', fgColor:{ argb:'FF444444' } },
    alignment: { vertical:'middle', horizontal:'center' }
  };
  const dayFill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF3E2723' } };
  const dayFont = { bold:true, size:13, color:{ argb:'FFFFFFFF' } };

  const trainingDays = (plan.days || []).filter(d => (d.exercises||[]).length>0);

  for (const d of trainingDays) {
    const r0 = ws.rowCount + 1;
    ws.mergeCells(`B${r0}:D${r0}`);
    Object.assign(ws.getCell(`B${r0}`), { value: d.day || '', font: dayFont, fill: dayFill });

    const head = ws.addRow(['','ĆWICZENIE','SERIE','POWTÓRZENIA']);
    [2,3,4].forEach(i=>{
      const c = head.getCell(i);
      c.font = headStyle.font; c.fill = headStyle.fill; c.alignment = headStyle.alignment;
      c.border = { top:{style:'thin',color:{argb:'FF666666'}}, left:{style:'thin',color:{argb:'FF666666'}},
                   bottom:{style:'thin',color:{argb:'FF666666'}}, right:{style:'thin',color:{argb:'FF666666'}} };
    });

    for (const ex of d.exercises) {
      const sets = parseSeriesCount(ex.serie ?? ex.series ?? ex.sets, level);
      const reps = Math.max(1, Math.floor(Number(ex.powtorzenia ?? ex.reps ?? 10)));
      const row = ws.addRow(['', ex.cwiczenie || '', sets, reps]);
      [3,4].forEach(i => row.getCell(i).alignment = { horizontal:'center' });
      [2,3,4].forEach(i => row.getCell(i).border = {
        top:{style:'thin',color:{argb:'FFDDDDDD'}}, left:{style:'thin',color:{argb:'FFDDDDDD'}},
        bottom:{style:'thin',color:{argb:'FFDDDDDD'}}, right:{style:'thin',color:{argb:'FFDDDDDD'}}
      });
    }

    ws.addRow([]);
  }

  ws.pageSetup = { horizontalCentered: true };

  const buffer = await wb.xlsx.writeBuffer();
  const filename = `Plan_Treningowy_${new Date().toISOString().slice(0,10)}.xlsx`;
  return { buffer, filename };
}
