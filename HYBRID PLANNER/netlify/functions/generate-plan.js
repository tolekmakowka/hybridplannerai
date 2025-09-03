// HYBRID PLANNER/netlify/functions/generate-plan.js
const ExcelJS = require('exceljs');

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// CORS – tylko Twoje domeny i lokalne dev
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

    // 1) Pobierz plan z Groq (JSON), albo użyj fallbacku
    let plan;
    try {
      plan = await getPlanFromGroq({ sessionsPerWeek, goal, level, equipment, gender });
    } catch (e) {
      // Fallback – prosty plan na 7 dni
      plan = basicFallbackPlan();
    }

    // 2) Zrób JEDEN arkusz "Plan" (bez zakładek dla dni)
    const { buffer, filename } = await makeSingleSheetWorkbook(plan);

    // 3) Zwróć base64 do frontu
    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: JSON.stringify({
        ok: true,
        filename,
        fileBase64: buffer.toString('base64')
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders(origin),
      body: JSON.stringify({ ok:false, error: 'generate-plan failed', details: String(err) })
    };
  }
};

// ===== Helpers =====

async function getPlanFromGroq({ sessionsPerWeek, goal, level, equipment, gender }) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY is missing');

  const sys = `Jesteś doświadczonym trenerem S&C. 
Zwracasz TYLKO poprawny JSON bez komentarzy i bez dodatkowego tekstu.
Struktura:
{
  "days": [
    {
      "day": "Poniedziałek",
      "exercises": [
        { "cwiczenie": "Flat bench press", "serie": "4×8–12", "powtorzenia": "8–12", "przerwa": "2–3 min", "rir": "1–3", "rpe": "7–9", "tempo": "30X1", "komentarz": "" }
      ]
    }, ...
  ]
}
Dni w kolejności: Poniedziałek, Wtorek, Środa, Czwartek, Piątek, Sobota, Niedziela. 
Pola po polsku jak w przykładzie.`;

  const user = `Dane wejściowe:
- sesje/tydzień: ${sessionsPerWeek}
- cel: ${goal}
- poziom: ${level}
- sprzęt: ${equipment}
- płeć: ${gender}
Ułóż plan siłowy/ogólnorozwojowy zgodny z danymi. Każdy dzień ma 5–8 ćwiczeń.`;

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.1-70b-versatile',
      temperature: 0.3,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user }
      ]
    })
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Groq ${r.status}: ${t}`);
  }
  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content?.trim() || '';

  // Wyciągnij czysty JSON (obsługa ewentualnego ```json … ```)
  const json = extractJson(text);
  if (!json?.days?.length) throw new Error('Brak days w odpowiedzi modelu');
  return json;
}

function extractJson(txt){
  const m = txt.match(/```json\s*([\s\S]*?)\s*```/i);
  const raw = m ? m[1] : txt;
  return JSON.parse(raw);
}

function basicFallbackPlan(){
  const dni = ['Poniedziałek','Wtorek','Środa','Czwartek','Piątek','Sobota','Niedziela'];
  return {
    days: dni.map(d => ({
      day: d,
      exercises: [
        { cwiczenie:'Flat bench press', serie:'4×8–12', powtorzenia:'8–12', przerwa:'2–3 min', rir:'1–3', rpe:'7–9', tempo:'30X1', komentarz:'' },
        { cwiczenie:'Incline bench press', serie:'3×8–12', powtorzenia:'8–12', przerwa:'2–3 min', rir:'1–3', rpe:'7–9', tempo:'30X1', komentarz:'' },
        { cwiczenie:'Overhead press', serie:'3×8–12', powtorzenia:'8–12', przerwa:'2–3 min', rir:'1–3', rpe:'7–9', tempo:'30X1', komentarz:'' },
        { cwiczenie:'Triceps extension', serie:'3×8–12', powtorzenia:'8–12', przerwa:'2 min', rir:'1–3', rpe:'7–9', tempo:'20X1', komentarz:'' },
      ]
    }))
  };
}

async function makeSingleSheetWorkbook(plan){
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Plan', {
    properties: { defaultRowHeight: 18 }
  });

  // Kolumny – szerokości dopasowane do telefonu/desktopu
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

  // Tytuł
  ws.mergeCells('A1:H1');
  const title = ws.getCell('A1');
  title.value = 'Plan Treningowy';
  title.font = { name: 'Arial', size: 16, bold: true };
  title.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.addRow([]);

  // Kolory/nagłówki
  const headerStyle = {
    font: { bold: true, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF444444' } },
    alignment: { vertical: 'middle', horizontal: 'center' }
  };
  const dayStyle = {
    font: { bold: true, size: 13, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3E2723' } } // ciemny brąz
  };

  const order = ['Poniedziałek','Wtorek','Środa','Czwartek','Piątek','Sobota','Niedziela'];

  for (const dayName of order) {
    const day = plan.days.find(d => (d.day || '').toLowerCase() === dayName.toLowerCase());
    // Nagłówek dnia (pozioma belka przez A..H)
    const startRow = ws.rowCount + 1;
    ws.mergeCells(`A${startRow}:H${startRow}`);
    const cell = ws.getCell(`A${startRow}`);
    cell.value = dayName;
    Object.assign(cell, { style: dayStyle });

    // wiersz nagłówka tabeli
    const headRow = ws.addRow(ws.columns.map(c => c.header));
    Object.assign(headRow, { height: 20 });
    headRow.eachCell((c) => {
      c.style = headerStyle;
      c.border = {
        top:{style:'thin', color:{argb:'FF666666'}},
        left:{style:'thin', color:{argb:'FF666666'}},
        bottom:{style:'thin', color:{argb:'FF666666'}},
        right:{style:'thin', color:{argb:'FF666666'}}
      };
    });

    // ćwiczenia
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

    ws.addRow([]); // odstęp między dniami
  }

  // Zapis do bufora
  const buffer = await wb.xlsx.writeBuffer();
  const filename = `Plan_Treningowy_${new Date().toISOString().slice(0,10)}.xlsx`;
  return { buffer, filename };
}
