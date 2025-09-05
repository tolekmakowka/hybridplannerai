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

    // 3) Excel – jeden arkusz; tylko dni z treningami; 3 kolumny
    const { buffer, filename } = await makeSingleSheetWorkbook(plan);

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

  // Twarde wymagania formatu i reguł
  const sys = `Jesteś doświadczonym trenerem S&C.
ZWRACAJ WYŁĄCZNIE POPRAWNY JSON (bez komentarzy/markdown).
Masz traktować bazę ćwiczeń jako bazę WIEDZY, a nie gotowe plany – za każdym razem dobierasz zestawy na nowo.
Format odpowiedzi (tylko te pola w ćwiczeniu):
{
  "days": [
    {
      "day": "Poniedziałek",
      "exercises": [
        { "cwiczenie": "nazwa", "serie": "3", "powtorzenia": "10" }
      ]
    }
  ]
}
Zasady powtórzeń: 10 dla ćwiczeń wielostawowych, 12 dla izolowanych (liczba w polu "powtorzenia").
Podaj wyłącznie tyle dni, ile wynika z sesji/tydzień (bez pustych dni). Zapewnij zróżnicowanie między dniami.`;

  // Reguły specyficzne dla kobiet
  const femaleRules = `Jeśli płeć = "Kobieta":
- priorytet dolnych partii ciała;
- jeśli 3 sesje/tydzień: 2 dni NOGI + 1 dzień GÓRA;
- w każdym dniu NOGI ustaw ćwiczenia w tej logice:
  1) Pierwsze ćwiczenie (rotacyjnie między dniami nóg): "hip thrust", "back squat", "deadlift", "bulgarian split squats" (używaj tej kolejności rotacji między kolejnymi dniami nóg).
  2) Drugie ćwiczenie (rotacyjnie): "hip adduction machine", "hip adductor machine".
  3) Trzecie ćwiczenie (rotacyjnie): "kickback horizontal", "back extension".
  4) Uzupełnij 2 akcesoria na łydki i brzuch (np. calf raises, hanging knee raises, plank, cable crunch).
  5) Na końcu dodaj cardio: "incline treadmill walk" z "serie": "X" i "powtorzenia": "20min".
Pamiętaj o zasadzie 10/12 powtórzeń (wielostawowe/izolowane).`;

  const user = `Dane osoby:
- sesje/tydzień: ${sessionsPerWeek}
- cel: ${goal}
- poziom: ${level}
- sprzęt: ${equipment}
- płeć: ${gender}

Dni mają być po polsku (Poniedziałek..Niedziela). ${gender === 'Kobieta' ? femaleRules : 'Zadbaj o sensowny split i pozostań w formacie.'}`;

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.1-70b-versatile',
      temperature: 0.35, // umiarkowana losowość
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

  // sanity: tylko trzy pola na ćwiczeniu; mapowanie jeśli przyszły inne
  if (json && Array.isArray(json.days)) {
    json.days.forEach(d => {
      d.exercises = (d.exercises || []).map(e => ({
        cwiczenie: e.cwiczenie ?? e.exercise ?? '',
        serie: String(e.serie ?? e.series ?? e.sets ?? e['liczba serii'] ?? '3'),
        powtorzenia: String(e.powtorzenia ?? e.reps ?? '10')
      }));
    });
  }
  return json;
}

function extractJson(txt){
  const m = txt.match(/```json\s*([\s\S]*?)\s*```/i);
  const raw = m ? m[1] : txt;
  return JSON.parse(raw);
}

/* ===================== Walidacja + różnorodność ===================== */
function isValidPlan(p){
  return p && Array.isArray(p.days) && p.days.length >= 1 &&
         p.days.every(d => Array.isArray(d.exercises) && d.exercises.every(x => typeof x === 'object'));
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
function pick(arr, rnd){ return arr[Math.floor(rnd() * arr.length)] }
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

/* ===================== Klasyfikacja ćwiczeń ===================== */
function isCompound(name=''){
  const s = name.toLowerCase();
  return [
    'squat','deadlift','press','row','lunge','hip thrust','pull-up','chin-up',
    'leg press','split squat','bench','clean','snatch'
  ].some(k => s.includes(k));
}

/* ===================== Fallback: zróżnicowany plan (z zasadami dla Kobieta) ===================== */
function buildVariedPlan({ sessionsPerWeek = 4, level='', equipment='', goal='', gender='' }) {
  const dni = ['Poniedziałek','Wtorek','Środa','Czwartek','Piątek','Sobota','Niedziela'];
  const N = Math.max(1, Math.min(7, Number(sessionsPerWeek)||1));

  const seedStr = JSON.stringify({ sessionsPerWeek, level, equipment, goal, gender }) + '|' + Date.now();
  const rnd = mulberry32(cyrb53(seedStr));

  // biblioteka bazowa (góra i akcesoria)
  const UPPER = [
    'Flat bench press','Incline bench press','Overhead press',
    'Barbell row','Seated cable row','Lat pulldown',
    'Dips (asysta)','Pull-up (asysta)','Lateral raise',
    'Face pull','Biceps curl','Triceps extension'
  ];
  const CALVES = ['Standing calf raise','Seated calf raise'];
  const ABS = ['Hanging knee raises','Cable crunch','Plank'];

  // Specjalne listy dla nóg (Kobieta)
  const FEMALE_FIRST = ['hip thrust','back squat','deadlift','bulgarian split squats']; // 1. ćwiczenie
  const FEMALE_SECOND = ['hip adduction machine','hip adductor machine'];              // 2. ćwiczenie
  const FEMALE_THIRD = ['kickback horizontal','back extension'];                       // 3. ćwiczenie
  const FEMALE_CARDIO = { name: 'incline treadmill walk', serie: 'X', reps: '20min' };

  function row(name, sets=3){
    const comp = isCompound(name);
    return {
      cwiczenie: name,
      serie: String(sets),
      powtorzenia: comp ? '10' : '12'
    };
  }

  function upperDay(){
    const compoundPool = UPPER.filter(x => isCompound(x));
    const isoPool = UPPER.filter(x => !isCompound(x));
    const plan = [];
    // 2-3 wielostawowe + 2 izolacje
    shuffle(compoundPool, rnd).slice(0, 3).forEach((ex, i)=> plan.push(row(ex, i===0 ? 4 : 3)));
    shuffle(isoPool, rnd).slice(0, 2).forEach(ex => plan.push(row(ex, 3)));
    return plan;
  }

  function femaleLegDay(index){
    const plan = [];
    // 1
    const first = FEMALE_FIRST[index % FEMALE_FIRST.length];
    plan.push(row(first, 4)); // ciężkie pierwsze
    // 2
    const second = FEMALE_SECOND[index % FEMALE_SECOND.length];
    plan.push(row(second, 3));
    // 3
    const third = FEMALE_THIRD[index % FEMALE_THIRD.length];
    plan.push(row(third, 3));
    // 4-5 akcesoria: łydki + brzuch
    plan.push(row(pick(CALVES, rnd), 3));
    plan.push(row(pick(ABS, rnd), 3));
    // 6 cardio koniec
    plan.push({ cwiczenie: FEMALE_CARDIO.name, serie: FEMALE_CARDIO.serie, powtorzenia: FEMALE_CARDIO.reps });
    return plan;
  }

  function genericLegDay(){
    // dla mężczyzny lub innych – klasyczny dzień nóg
    const base = [
      'Back squat','Romanian deadlift','Leg press','Lunge (chodzony)',
      'Leg curl','Calf raises','Hip thrust','Hanging knee raises'
    ];
    const plan = [];
    const pickSeq = shuffle(base, rnd);
    pickSeq.slice(0, 5).forEach((ex, i)=> plan.push(row(ex, i<2 ? 4 : 3)));
    return plan;
  }

  const days = [];

  if (gender === 'Kobieta') {
    if (N === 3) {
      // 2x nogi + 1x góra
      days.push({ day: dni[0], exercises: femaleLegDay(0) });
      days.push({ day: dni[1], exercises: upperDay() });
      days.push({ day: dni[2], exercises: femaleLegDay(1) });
    } else {
      // Priorytet nóg: ~60–70% dni to nogi
      const legCount = Math.max(2, Math.round(N * 0.66));
      const upperCount = N - legCount;
      let dayIdx = 0;
      for (let i=0;i<legCount;i++){
        days.push({ day: dni[dayIdx++], exercises: femaleLegDay(i) });
      }
      for (let i=0;i<upperCount;i++){
        days.push({ day: dni[dayIdx++], exercises: upperDay() });
      }
    }
  } else {
    // Ogólny split dla pozostałych
    if (N <= 3) {
      // FBW z rotacją
      for (let i=0;i<N;i++){
        const exs = [
          row('Back squat', 4), row('Flat bench press', 4), row('Barbell row', 4),
          row('Romanian deadlift', 3), row('Overhead press', 3),
          row(pick(ABS, rnd), 3)
        ];
        days.push({ day: dni[i], exercises: exs });
      }
    } else {
      // Upper/Lower z dodatkami
      for (let i=0;i<N;i++){
        const isUpper = (i % 2 === 0);
        days.push({ day: dni[i], exercises: isUpper ? upperDay() : genericLegDay() });
      }
    }
  }

  return { days };
}

/* ===================== Excel – jeden arkusz (3 kolumny, wyśrodkowany widok) ===================== */
async function makeSingleSheetWorkbook(plan){
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Plan', {
    properties: { defaultRowHeight: 18 },
    views: [{ state: 'normal', topLeftCell: 'B2', zoomScale: 120 }]
  });

  // lewy margines (pusta kolumna), potem 3 kolumny docelowe
  ws.columns = [
    { header: '', width: 4 }, // margines
    { header:'ĆWICZENIE', width: 36 },
    { header:'SERIE', width: 10 },
    { header:'POWTÓRZENIA', width: 14 }
  ];

  // Tytuł
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
  const dayStyle = {
    font: { bold: true, size: 13, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3E2723' } }
  };

  // wyłącznie dni z treningami
  const trainingDays = (plan.days || []).filter(d => (d.exercises || []).length > 0);

  for (const d of trainingDays) {
    const startRow = ws.rowCount + 1;
    ws.mergeCells(`B${startRow}:D${startRow}`);
    const cell = ws.getCell(`B${startRow}`);
    cell.value = d.day || '';
    cell.font = dayStyle.font;
    cell.fill = dayStyle.fill;

    // nagłówek tabeli
    const headRow = ws.addRow(ws.columns.slice(1).map(c => c.header)); // B..D
    headRow.height = 20;
    headRow.eachCell((c) => {
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

    for (const ex of (d.exercises || [])) {
      const r = ws.addRow([
        ex.cwiczenie || '',
        ex.serie != null ? String(ex.serie) : '',
        ex.powtorzenia != null ? String(ex.powtorzenia) : ''
      ]);
      r.eachCell((c) => {
        c.border = {
          top:{style:'thin', color:{argb:'FFDDDDDD'}},
          left:{style:'thin', color:{argb:'FFDDDDDD'}},
          bottom:{style:'thin', color:{argb:'FFDDDDDD'}},
          right:{style:'thin', color:{argb:'FFDDDDDD'}}
        };
      });
    }

    ws.addRow([]); // odstęp między dniami
  }

  ws.pageSetup = { horizontalCentered: true };

  const buffer = await wb.xlsx.writeBuffer();
  const filename = `Plan_Treningowy_${new Date().toISOString().slice(0,10)}.xlsx`;
  return { buffer, filename };
}