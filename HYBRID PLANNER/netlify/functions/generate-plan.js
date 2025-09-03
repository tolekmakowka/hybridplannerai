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

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify({ ok:false, error: 'Method not allowed' }) };
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
    let plan;
    try {
      plan = await getPlanFromGroq({ sessionsPerWeek, goal, level, equipment, gender });
    } catch (_) {
      plan = null;
    }

    // 2) Walidacja i różnorodność
    if (!isValidPlan(plan) || !hasDiversity(plan)) {
      plan = buildVariedPlan({ sessionsPerWeek, level, equipment, goal, gender });
    }

    // 3) Excel – jeden arkusz "Plan"
    const { buffer, filename } = await makeSingleSheetWorkbook(plan);

    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: JSON.stringify({ ok:true, filename, fileBase64: buffer.toString('base64') })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders(origin),
      body: JSON.stringify({ ok:false, error: 'generate-plan failed', details: String(err) })
    };
  }
};

/* ===================== Groq ===================== */
async function getPlanFromGroq({ sessionsPerWeek, goal, level, equipment, gender }) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY missing');

  const sys = `Jesteś doświadczonym trenerem S&C.
ZWRACAJ WYŁĄCZNIE POPRAWNY JSON (bez komentarzy/markdown).
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
Każdy dzień 5–8 ćwiczeń. Nazwy pól jak w przykładzie (po polsku).`;

  const user = `Dane:
- sesje/tydzień: ${sessionsPerWeek}
- cel: ${goal}
- poziom: ${level}
- sprzęt: ${equipment}
- płeć: ${gender}
Dni w kolejności: Poniedziałek, Wtorek, Środa, Czwartek, Piątek, Sobota, Niedziela.`;

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.1-70b-versatile',
      temperature: 0.25,
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

/* ===================== Walidacja i różnorodność ===================== */
function isValidPlan(p){
  return p && Array.isArray(p.days) && p.days.length >= 3 && p.days.every(d => Array.isArray(d.exercises));
}

function hasDiversity(p){
  // liczymy unikalne „podpisy” zestawów ćwiczeń w dniach
  const sigs = (p.days || []).map(d => {
    const names = (d.exercises || []).map(e => (e.cwiczenie||'').toLowerCase().trim()).filter(Boolean);
    return JSON.stringify(names);
  });
  const uniq = new Set(sigs);
  // jeżeli >60% dni to identyczne zestawy -> brak różnorodności
  return uniq.size >= Math.ceil(sigs.length * 0.6);
}

/* ===================== Regułowy plan zróżnicowany ===================== */
function buildVariedPlan({ sessionsPerWeek = 4, level='', equipment='', goal='', gender='' }) {
  const dni = ['Poniedziałek','Wtorek','Środa','Czwartek','Piątek','Sobota','Niedziela'];

  // Dobór splitu
  let split;
  if (sessionsPerWeek <= 3) split = ['FBW A','FBW B','FBW C'];
  else if (sessionsPerWeek === 4) split = ['Upper A','Lower A','Upper B','Lower B'];
  else if (sessionsPerWeek === 5) split = ['Upper','Lower','Push','Pull','Full'];
  else if (sessionsPerWeek === 6) split = ['Push','Pull','Legs','Push','Pull','Legs'];
  else split = ['Upper','Lower','Push','Pull','Full','Legs','Akcesoria/Core'];

  // biblioteka ćwiczeń (bazowe, bez sprzętu – można rozbudować pod equipment)
  const LIB = {
    Push: [
      'Flat bench press','Incline bench press','Overhead press',
      'Dips (asysta w razie potrzeby)','Lateral raise','Triceps extension'
    ],
    Pull: [
      'Lat pulldown','Barbell row','Seated cable row',
      'Face pull','Biceps curl','Hammer curl'
    ],
    Legs: [
      'Back squat','Romanian deadlift','Leg press',
      'Lunge (chodzony)','Leg curl','Calf raises'
    ],
    Upper: [
      'Flat bench press','Overhead press','Lat pulldown',
      'Barbell row','Lateral raise','Face pull','Biceps curl','Triceps extension'
    ],
    Lower: [
      'Back squat','Romanian deadlift','Leg press',
      'Leg curl','Calf raises','Hanging knee raises'
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

  function pack(name){
    const base = LIB[name] || [];
    return base.slice(0, 6).map(x => row(x));
  }
  function row(name){
    return {
      cwiczenie: name,
      serie: level.toLowerCase().includes('zaaw') ? '4×6–10' : '3×8–12',
      powtorzenia: level.toLowerCase().includes('zaaw') ? '6–10' : '8–12',
      przerwa: '2–3 min',
      rir: '1–3',
      rpe: '7–9',
      tempo: '30X1',
      komentarz: ''
    };
  }

  // rozkład po tygodniu – pierwsze N dni to trening, reszta puste (albo „regeneracja”)
  const days = dni.map((day, i) => {
    const tp = split[i % split.length];
    if (i < Math.min(sessionsPerWeek, 7)) {
      return { day, exercises: pack(tp) };
    } else {
      return { day, exercises: [] }; // dzień bez treningu
    }
  });

  return { days };
}

/* ===================== Excel (jeden arkusz) ===================== */
async function makeSingleSheetWorkbook(plan){
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Plan', { properties: { defaultRowHeight: 18 } });

  ws.columns = [
    { header:'ĆWICZENIE', width: 32 },
    { header:'SERIE', width: 10 },
    { header:'POWTÓRZENIA', width: 14 },
    { header:'PRZERWA', width: 11 },
    { header:'RIR', width: 6 },
    { header:'RPE', width: 6 },
    { header:'TEMPO', width: 8 },
    { header:'KOMENTARZ / WYKONANIE', width: 36 }
  ];

  ws.mergeCells('A1:H1');
  const title = ws.getCell('A1');
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

  const order = ['Poniedziałek','Wtorek','Środa','Czwartek','Piątek','Sobota','Niedziela'];

  for (const dayName of order) {
    const day = plan.days.find(d => (d.day || '').toLowerCase() === dayName.toLowerCase());

    const startRow = ws.rowCount + 1;
    ws.mergeCells(`A${startRow}:H${startRow}`);
    const cell = ws.getCell(`A${startRow}`);
    cell.value = dayName;
    Object.assign(cell, { style: dayStyle });

    // nagłówek tabeli
    const headRow = ws.addRow(ws.columns.map(c => c.header));
    headRow.height = 20;
    headRow.eachCell((c) => {
      c.style = headerStyle;
      c.border = {
        top:{style:'thin', color:{argb:'FF666666'}},
        left:{style:'thin', color:{argb:'FF666666'}},
        bottom:{style:'thin', color:{argb:'FF666666'}},
        right:{style:'thin', color:{argb:'FF666666'}}
      };
    });

    const list = day?.exercises || [];
    for (const ex of list) {
      const r = ws.addRow([
        ex.cwiczenie || '',
        ex.serie || '',
        ex.powtorzenia || '',
        ex.przerwa || '',
        ex.rir || '',
        ex.rpe || '',
        ex.tempo || '',
        ex.komentarz || ''
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

    ws.addRow([]);
  }

  const buffer = await wb.xlsx.writeBuffer();
  const filename = `Plan_Treningowy_${new Date().toISOString().slice(0,10)}.xlsx`;
  return { buffer, filename };
}
