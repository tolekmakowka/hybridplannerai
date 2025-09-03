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

    // ★ NORMALIZACJA: rep-rule (10/12) + dociążenie dolnej części dla Kobiety
    plan = finalizePlan(plan, { gender });

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

  // —— SYSTEM PROMPT (doprecyzowany o płeć + regułę 10/12)
  const sys = `Jesteś doświadczonym trenerem S&C. Twoim zadaniem jest ułożyć
optymalny, skuteczny plan siłowy dopasowany do celu, poziomu i dostępnego sprzętu.
Zasady jakości:
- Każdy dzień: najpierw złożone ruchy (compound), potem akcesoria (isolation).
- Równowaga wzorców: przysiad, hinge, pchanie, ciągnięcie, unilateral, core.
- Unikaj identycznych dni; progresja bodźców w skali tygodnia.
- Uwzględniaj ograniczenia sprzętowe.
- Jeśli płeć to kobieta: PRIORYTETEM są nogi i pośladki — zadbaj o większą obecność wzorców squat/hinge/hip-thrust i unilateral; przynajmniej 2 mocne bodźce dolnej części w każdej jednostce oraz hip thrust lub jego wariant ≥2x/tydz.
- Język polski; nazwy ćwiczeń po polsku lub powszechne angielskie.

ZWRACAJ WYŁĄCZNIE POPRAWNY JSON (bez komentarzy/markdown).
FORMAT:
{
  "days": [
    {
      "day": "Poniedziałek",
      "exercises": [
        { "cwiczenie": "Flat bench press", "serie": 4, "powtorzenia": 10 }
      ]
    }
  ]
}

Dodatkowe wymogi danych wyjściowych:
- Każde ćwiczenie ma TYLKO trzy pola: "cwiczenie" (string), "serie" (int), "powtorzenia" (int).
- Reguła powtórzeń: 10 w ćwiczeniach wielostawowych (compound), 12 w izolowanych (isolation).
- 5–8 ćwiczeń na dzień (zależnie od celu/poziomu).
- Zwracaj dokładnie tyle dni, ile wynosi "sesje/tydzień".`;

  const user = `Dane wejściowe:
- sesje/tydzień: ${sessionsPerWeek}
- cel: ${goal}
- poziom: ${level}
- sprzęt: ${equipment}
- płeć: ${gender}

Ułóż najlepszy możliwy tygodniowy plan (liczba dni == sesje/tydzień).
Pamiętaj o regule powtórzeń: 10 (compound) / 12 (isolation) oraz priorytecie nóg/pośladków, gdy płeć to kobieta.
Dni: Poniedziałek, Wtorek, Środa, Czwartek, Piątek, Sobota, Niedziela.`;

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.1-70b-versatile',
      temperature: 0.55,
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

  for (const d of p.days) {
    if (!Array.isArray(d.exercises) || d.exercises.length < 4 || d.exercises.length > 9) return false;
    for (const e of d.exercises) {
      if (typeof e?.cwiczenie !== 'string') return false;
      if (!Number.isFinite(Number(e?.serie))) return false;
      if (!Number.isFinite(Number(e?.powtorzenia))) return false;
    }
  }
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

// ——— klasyfikacja compound/iso
const COMPOUND_KW = [
  'squat','deadlift','romanian','hinge','press','row','pulldown','pull-up','lunge','split squat','leg press','hip thrust','good morning','clean','snatch'
];
const ISOLATION_KW = [
  'curl','extension','raise','fly','calf','face pull','rear delt','adduction','abduction'
];
function isCompound(name=''){
  const n = name.toLowerCase();
  if (COMPOUND_KW.some(k=>n.includes(k))) return true;
  if (ISOLATION_KW.some(k=>n.includes(k))) return false;
  return true; // domyślnie traktuj jako compound
}
function isLowerBody(name=''){
  const n = name.toLowerCase();
  return ['squat','deadlift','romanian','hinge','lunge','split squat','leg press','hip thrust','glute','calf'].some(k=>n.includes(k));
}
function isFemale(gender=''){ return String(gender).toLowerCase().includes('kob'); }

function setSets(goal, isAccessory=false){
  if (goal==='strength') return isAccessory ? 3 : 5;
  if (goal==='cut')       return isAccessory ? 3 : 4;
  return                   isAccessory ? 3 : 4; // hypertrofia
}
function repsByRule(name){
  return isCompound(name) ? 10 : 12;
}

function pick(listKey, prof, n=1){
  const list = LIBRARY[listKey]?.[prof] || LIBRARY[listKey]?.gym || [];
  const arr = list.slice();
  for (let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; }
  return arr.slice(0,n);
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

function makeExercise(name, goal, isAccessory, gender){
  const setsBase = setSets(goal, isAccessory);
  // ★ reps z reguły 10/12
  const reps = repsByRule(name);
  // ★ jeśli Kobieta i dolna część — +1 seria (cap 6)
  const sets = (isFemale(gender) && isLowerBody(name)) ? Math.min(6, setsBase + 1) : setsBase;
  return { cwiczenie: name, serie: sets, powtorzenia: reps };
}

function dayUpper(goal, prof, gender){
  const main  = [...pick('horizontalP',prof,1), ...pick('verticalP',prof,1), ...pick('horizontalR',prof,1), ...pick('verticalR',prof,1)];
  const acc   = [...pick('pushAcc',prof,2), ...pick('pullAcc',prof,1)];
  return main.concat(acc).map((name,i) => makeExercise(name, goal, i>=3, gender));
}
function dayLower(goal, prof, gender){
  // ★ wymuszamy hip thrust w dniu nóg
  const main  = [...pick('squat',prof,1), ...pick('hinge',prof,1), ...pick('unilateral',prof,1), ...pick('hipthrust',prof,1)];
  const acc   = [...pick('legcurl',prof,1), ...pick('calves',prof,1), ...pick('core',prof,1)];
  return main.concat(acc).map((name,i) => makeExercise(name, goal, i>=3, gender));
}
function dayPush(goal, prof, gender){
  const main = [...pick('horizontalP',prof,1), ...pick('verticalP',prof,1)];
  const acc  = [...pick('pushAcc',prof,3)];
  return main.concat(acc).map((name,i)=> makeExercise(name, goal, i>=2, gender));
}
function dayPull(goal, prof, gender){
  const main = [...pick('horizontalR',prof,1), ...pick('verticalR',prof,1)];
  const acc  = [...pick('pullAcc',prof,3)];
  return main.concat(acc).map((name,i)=> makeExercise(name, goal, i>=2, gender));
}
function dayFull(goal, prof, gender){
  const blocks = [
    ...pick('squat',prof,1),
    ...pick('hinge',prof,1),
    ...pick('horizontalP',prof,1),
    ...pick('horizontalR',prof,1),
    ...pick('core',prof,1)
  ];
  return blocks.map((name,i)=> makeExercise(name, goal, i>=2, gender));
}

function buildHeuristicPlan({ sessionsPerWeek=4, goal='', level='', equipment='', gender='' }){
  const g    = goalType(goal);
  const prof = equipmentProfile(equipment);
  const daysNames = ['Poniedziałek','Wtorek','Środa','Czwartek','Piątek','Sobota','Niedziela'];

  // ★ Split z priorytetem dolnej części dla Kobiety
  let split;
  if (isFemale(gender)) {
    if (sessionsPerWeek<=1) split = ['Lower'];
    else if (sessionsPerWeek===2) split = ['Lower','Upper'];
    else if (sessionsPerWeek===3) split = ['Lower','Upper','Lower'];
    else if (sessionsPerWeek===4) split = ['Lower','Upper','Lower','Full'];
    else if (sessionsPerWeek===5) split = ['Lower','Upper','Lower','Push','Pull'];
    else if (sessionsPerWeek===6) split = ['Lower','Upper','Lower','Push','Pull','Full'];
    else split = ['Lower','Upper','Lower','Push','Pull','Full','Lower'];
  } else {
    if (sessionsPerWeek<=1) split = ['Full'];
    else if (sessionsPerWeek===2) split = ['Full','Full'];
    else if (sessionsPerWeek===3) split = ['FBW A','FBW B','FBW C'];
    else if (sessionsPerWeek===4) split = ['Upper','Lower','Upper','Lower'];
    else if (sessionsPerWeek===5) split = ['Upper','Lower','Push','Pull','Full'];
    else if (sessionsPerWeek===6) split = ['Push','Pull','Legs','Push','Pull','Legs'];
    else split = ['Upper','Lower','Push','Pull','Full','Legs','Akcesoria'];
  }

  const days = [];
  for (let i=0;i<Math.min(sessionsPerWeek,7);i++){
    const tp = split[i % split.length];
    let exercises;
    if (tp==='Upper') exercises = dayUpper(g,prof,gender);
    else if (tp==='Lower' || tp==='Legs') exercises = dayLower(g,prof,gender);
    else if (tp==='Push')  exercises = dayPush(g,prof,gender);
    else if (tp==='Pull')  exercises = dayPull(g,prof,gender);
    else                   exercises = dayFull(g,prof,gender);

    if (exercises.length<5) {
      while(exercises.length<5){
        const extra = pick('core',prof,1).map(n=> makeExercise(n,g,true,gender));
        exercises.push(...extra);
      }
    }
    if (exercises.length>8) exercises = exercises.slice(0,8);

    days.push({ day: daysNames[i], exercises });
  }
  return { days };
}

/* ★★★ NORMALIZACJA: egzekwuj 10/12 reps + dopal nogi/pośladki u kobiet ★★★ */
function finalizePlan(plan, { gender='' } = {}){
  const female = isFemale(gender);
  const out = { days: [] };

  for (const d of (plan?.days || [])) {
    const fixed = (d.exercises || []).map((e, idx) => {
      const name = e?.cwiczenie || '';
      const reps = repsByRule(name); // 10 compound / 12 isolation
      let sets = Number(e?.serie);
      if (!Number.isFinite(sets) || sets < 1) sets = 3;
      // +1 seria dla dolnej części ciała u kobiet (limit 6)
      if (female && isLowerBody(name)) sets = Math.min(6, sets + 1);
      // traktuj 1–2 pierwsze jako compound (jeśli AI nie rozpoznało), ale reps mamy z nazwy
      return { cwiczenie: name, serie: sets, powtorzenia: reps };
    });
    out.days.push({ day: d.day, exercises: fixed });
  }
  return out;
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
