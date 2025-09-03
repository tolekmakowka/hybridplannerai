
// netlify/functions/generate-plan.js
'use strict';

const ExcelJS = require('exceljs');

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// proste nagłówki CORS
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || '*';

  // preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin) };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders(origin),
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    if (!GROQ_API_KEY) {
      return {
        statusCode: 500,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: 'GROQ_API_KEY not set' })
      };
    }

    let payload = {};
    try { payload = JSON.parse(event.body || '{}'); }
    catch {
      return {
        statusCode: 400,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: 'Bad JSON' })
      };
    }

    const { mode = 'A', inputs = {}, lang = 'pl', prompt } = payload;

    if (!prompt || typeof prompt !== 'string') {
      return {
        statusCode: 400,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: 'Missing "prompt"' })
      };
    }

    // ====== 1) Zapytanie do GROQ ======
    const model = 'llama-3.1-70b-versatile'; // aktualny, stabilny model
    const groqResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 2200,
        messages: [
          {
            role: 'system',
            content: 'You are an experienced strength & conditioning coach. Return plain structured text only (no tables), following the user rules.'
          },
          { role: 'user', content: prompt }
        ]
      })
    });

    const raw = await groqResp.text();
    if (!groqResp.ok) {
      return {
        statusCode: groqResp.status || 500,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: 'Groq error', details: raw })
      };
    }

    let data;
    try { data = JSON.parse(raw); } catch { data = {}; }
    const planText = data?.choices?.[0]?.message?.content?.trim?.() || '';

    // ====== 2) Tworzenie XLSX (układ jak w Twoim przykładzie) ======
    // parser: prosta ekstrakcja dni i ćwiczeń (AI zwraca zwykły tekst)
    // zakładamy układ "Dzień N — Poniedziałek" i listy punktorów z ćwiczeniami.
    const dniTyg = ['Poniedziałek','Wtorek','Środa','Czwartek','Piątek','Sobota','Niedziela'];

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'HybridPlanner';
    workbook.created = new Date();

    // style ogólne
    const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCBD3DC' } }; // jasny szary/niebieskawy
    const thin = { style: 'thin', color: { argb: 'FF9AA0A6' } };
    const borderAll = { top: thin, bottom: thin, left: thin, right: thin };

    // Tablica dni → każdy dzień jako osobny arkusz (jak na screenach)
    dniTyg.forEach((dzien) => {
      const ws = workbook.addWorksheet(dzien, { properties: { defaultRowHeight: 18 } });

      // Pasek z "zakładkami" – w Excelu robi się po prostu nazwami arkuszy,
      // więc tutaj robimy tabelę ćwiczeń:
      const cols = [
        { header: 'ĆWICZENIE', key: 'cw', width: 32 },
        { header: 'SERIE', key: 'serie', width: 8 },
        { header: 'POWTÓRZENIA', key: 'powt', width: 14 },
        { header: 'PRZERWA', key: 'przerwa', width: 12 },
        { header: 'RIR', key: 'rir', width: 6 },
        { header: 'RPE', key: 'rpe', width: 6 },
        { header: 'TEMPO', key: 'tempo', width: 10 },
        { header: 'KOMENTARZ / WYKONANIE', key: 'kom', width: 26 },
        { header: 'NUMER SERII', key: 'nr', width: 12 }
      ];
      ws.columns = cols;

      // wiersz nagłówkowy (drugi wiersz – pierwszy zostawiamy pusty na tytuł)
      const headerRow = ws.addRow(cols.map(c => c.header));
      headerRow.eachCell((cell) => {
        cell.fill = headerFill;
        cell.font = { bold: true };
        cell.border = borderAll;
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      });

      // tytuł – jak w Twoim xlsx ("Plan Treningowy.xlsx" w górze – tu damy nazwę dnia nad tabelą)
      ws.mergeCells('A1:I1');
      const t = ws.getCell('A1');
      t.value = dzien;
      t.font = { size: 16, bold: true };
      t.alignment = { vertical: 'middle', horizontal: 'left' };

      // na start wrzućmy 7 przykładowych wierszy – parser docelowo nadpisze
      // (jeśli nie znajdzie nic dla tego dnia)
      const defaults = [
        ['Flat bench press','4×8–12','3min','', 'X','9','8X','',''],
        ['Incline bench press','3×8–12','3min','', 'X','8','8X','',''],
        ['Overhead press','3×8–12','3min','', 'X','8','8X','',''],
        ['Triceps extension','3×8–12','2min','', 'X','8','8X','',''],
        ['Lateral raise','3×8–12','2min','', 'X','8','8X','',''],
        ['Hanging knee raises','3×8–12','2min','', 'X','8','8X','','']
      ];
      defaults.forEach(r=>{
        const row = ws.addRow([r[0],'',r[1],r[2],r[4],r[5],r[6],r[7],r[8]]);
        row.eachCell(cell => { cell.border = borderAll; });
      });

      // lekkie formatowanie
      ws.getColumn('A').alignment = { wrapText: true };
      ws.views = [{ state: 'frozen', ySplit: 2 }]; // zamroź tytuł + header
    });

    // ====== 3) Bufor XLSX ======
    const buffer = await workbook.xlsx.writeBuffer();

    // Zwracamy base64 (frontend wyśle to mailem przez send-email)
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders(origin),
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({
        planName: 'Plan Treningowy',
        // surowy tekst AI (może przydać się do podglądu)
        planText,
        xlsxBase64: Buffer.from(buffer).toString('base64'),
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: 'Plan Treningowy.xlsx'
      })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: corsHeaders('*'),
      body: JSON.stringify({ error: 'Unhandled exception', message: String(e) })
    };
  }
};
