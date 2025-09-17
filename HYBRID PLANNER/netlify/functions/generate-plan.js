// netlify/functions/generate-plan.js
'use strict';

const ALLOWED_ORIGINS = new Set([
  'https://tgmproject.net',
  'https://www.tgmproject.net',
  'http://localhost:8888',
  'http://localhost:5173',
  'http://localhost:3000'
]);

const headers = (o)=>({
  'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(o) ? o : '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
  'Content-Type': 'application/json; charset=utf-8'
});

exports.handler = async (event) => {
  const origin = event.headers?.origin || '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers(origin) };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: headers(origin), body: JSON.stringify({ ok:false, error:'Method not allowed' }) };

  try{
    const ExcelJS = require('exceljs');

    const body    = JSON.parse(event.body || '{}');
    const lang    = (body.lang || 'pl').toLowerCase();
    const inputs  = body.inputs || {};
    const ses     = Number(inputs.sessionsPerWeek || 3);
    const split   = String(inputs.split || '').toUpperCase();   // FBW | PPL | UL | PPL_FBW | PPL_ARNOLD | PPLPP
    const gender  = String(inputs.gender || '');
    const isFemale= /kobiet|kobieta|female|woman/i.test(gender || '');

    // ---------- BANK ĆWICZEŃ ----------
    const bank = {
      BACK:      ['Lat pulldown','Barbell row','Seated cable row','Pull-up'],
      CHEST:     ['Flat bench press','Incline bench press','Dumbbell bench press','Machine chest press'],
      SHOULDERS: ['Dumbbell shoulder press','Lateral raise','Machine shoulder press','Cable lateral raise'],
      BICEPS:    ['Barbell curl','Dumbbell curl','EZ-bar curl','Cable curl'],
      TRICEPS:   ['Cable pushdown','Overhead rope extension','Close-grip bench press','Dips (assisted)'],
      QUADS:     ['Back squat','Leg press','Goblet squat','Split squat (DB)'],
      POSTERIOR: ['Romanian deadlift','Hip thrust','Seated leg curl','Lying leg curl'],
      CALVES:    ['Standing calf raise','Seated calf raise'],
      // ABS zostaje w banku, ale nie używamy go w głównych schematach — akcesorium jest zawsze na końcu
      ABS:       ['Hanging knee raises','Cable crunch','Ab wheel rollout','Plank 60s']
    };

    // ---------- LOSOWANIE BEZ POWTÓRZEŃ W TYGODNIU ----------
    const usedGlobal = Object.fromEntries(Object.keys(bank).map(k => [k, new Set()]));
    function randomPick(arr, usedSet){
      if (!arr || arr.length === 0) return '';
      const pool = arr.filter(x => !usedSet.has(x));
      const choiceList = pool.length ? pool : arr;
      const idx = Math.floor(Math.random() * choiceList.length);
      const pick = choiceList[idx];
      if (!pool.length) usedSet.clear();
      usedSet.add(pick);
      return pick;
    }
    function pickUnique(cat){
      const list = bank[cat] || [];
      return randomPick(list, usedGlobal[cat] || (usedGlobal[cat] = new Set()));
    }

    // reps & sets – wg Twoich zasad
    const SETS_ALWAYS = '3'; // w kolumnie SERIE wpisujemy wyłącznie tę liczbę dla głównych ćwiczeń
    function repsFor(cat){
      return (cat === 'BACK' || cat === 'CHEST') ? '8' : '10';
    }

    // Dni tygodnia
    const dniPL = ['Poniedziałek','Wtorek','Środa','Czwartek','Piątek','Sobota','Niedziela'];
    const dniEN = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    const dni = (lang==='en'?dniEN:dniPL);

    // ========== AKCESORIA NA KONIEC DNIA ==========
    // Mężczyźni: jedna pozycja z puli, zawsze 2×10
    const maleAccessoryPool = [
      'Knee raises',
      'tuck hanging side swings',
      'Hollow body',
      'forearm curl',
      'forearm extension'
    ];
    const usedMaleAccessory = new Set();
    function appendMaleAccessory(rows){
      const name = randomPick(maleAccessoryPool, usedMaleAccessory);
      rows.push({ cwiczenie: name, serie: '2', powtorzenia: '10' });
    }

    // Kobiety: jedna pozycja z opisanej bazy obiektów
    const femaleAccessoryPool = [
      { cwiczenie:'incline treadmill walk', serie:'X', powtorzenia:'20min' },
      { cwiczenie:'stair master',          serie:'X', powtorzenia:'10min' },
      { cwiczenie:'Knee raises',           serie:'2', powtorzenia:'max'   }
    ];
    const usedFemaleAccessory = new Set();
    function appendFemaleAccessory(rows){
      // losujemy według cwiczenie (unikalność po nazwie)
      const names = femaleAccessoryPool.map(x=>x.cwiczenie);
      const choiceName = randomPick(names, usedFemaleAccessory);
      const obj = femaleAccessoryPool.find(x=>x.cwiczenie===choiceName) || femaleAccessoryPool[0];
      rows.push({ cwiczenie: obj.cwiczenie, serie: obj.serie, powtorzenia: obj.powtorzenia });
    }

    // ========== RULESET DLA KOBIET (bez ABS; akcesorium na końcu) ==========
    function buildRuleBasedPlan_Women({ sessionsPerWeek = 3 }) {

      // Leg day: QUADS, POSTERIOR, CALVES
      function legDay(){
        const rows = [];
        const c1 = 'QUADS';     rows.push({ cwiczenie: pickUnique(c1), serie: SETS_ALWAYS, powtorzenia: repsFor(c1) });
        const c2 = 'POSTERIOR'; rows.push({ cwiczenie: pickUnique(c2), serie: SETS_ALWAYS, powtorzenia: repsFor(c2) });
        const c3 = 'CALVES';    rows.push({ cwiczenie: pickUnique(c3), serie: SETS_ALWAYS, powtorzenia: repsFor(c3) });
        // akcesorium jako ostatnia pozycja
        appendFemaleAccessory(rows);
        return rows;
      }

      // Upper day: CHEST, BACK, SHOULDERS, BICEPS, TRICEPS (bez ABS)
      function upperDay(){
        const cats = ['CHEST','BACK','SHOULDERS','BICEPS','TRICEPS'];
        const rows = cats.map(cat => ({
          cwiczenie: pickUnique(cat),
          serie: SETS_ALWAYS,
          powtorzenia: repsFor(cat)
        }));
        appendFemaleAccessory(rows);
        return rows;
      }

      const days = [];
      const s = Math.min(Math.max(1, sessionsPerWeek|0), 7);

      if (s === 3) {
        const order = [legDay(), upperDay(), legDay()];
        for (let i=0;i<s;i++) days.push({ day: dni[i], exercises: order[i] });
      } else {
        // co najmniej połowa dni to nogi
        const legCount = Math.ceil(s * 0.5);
        for (let i=0;i<s;i++){
          const exs = (i < legCount) ? legDay() : upperDay();
          days.push({ day: dni[i], exercises: exs });
        }
      }
      return { days };
    }

    // ========== TWARDY SCHEMAT (wszyscy poza „kobiet…”) – bez ABS; akcesorium na końcu ==========
    function scheme3_FBW(){ return [
      ['BACK','CHEST','QUADS','TRICEPS','BICEPS'],
      ['BACK','CHEST','QUADS','TRICEPS','BICEPS'],
      ['BACK','CHEST','POSTERIOR','TRICEPS','BICEPS'],
    ]; }
    function scheme3_PPL(){ return [
      ['CHEST','CHEST','SHOULDERS','TRICEPS','TRICEPS'],
      ['BACK','BACK','BICEPS','BICEPS'],                 // usunięto ABS
      ['QUADS','POSTERIOR','CALVES','QUADS','POSTERIOR'],
    ]; }
    function scheme4_PPL_FBW(){ return [
      ['CHEST','CHEST','SHOULDERS','TRICEPS','TRICEPS'],
      ['BACK','BACK','BICEPS','BICEPS'],                 // usunięto ABS
      ['QUADS','POSTERIOR','CALVES','QUADS','POSTERIOR'],
      ['BACK','CHEST','QUADS'],
    ]; }
    function scheme4_UL(){ return [
      ['BACK','CHEST','BACK','SHOULDERS','BICEPS','TRICEPS'],
      ['QUADS','POSTERIOR','CALVES','QUADS','POSTERIOR'],
      ['CHEST','BACK','CHEST','SHOULDERS','BICEPS','TRICEPS'],
      ['QUADS','POSTERIOR','CALVES','QUADS','POSTERIOR'],
    ]; }
    function scheme5_PPLPP(){ return [
      ['CHEST','CHEST','SHOULDERS','TRICEPS','TRICEPS'],
      ['BACK','BACK','BICEPS','BICEPS'],                 // usunięto ABS
      ['QUADS','POSTERIOR','CALVES','QUADS','POSTERIOR'],
      ['CHEST','CHEST','SHOULDERS','TRICEPS','TRICEPS'],
      ['BACK','BACK','BICEPS','BICEPS'],                 // usunięto ABS
    ]; }
    function scheme5_PPL_ARNOLD(){ return [
      ['CHEST','CHEST','SHOULDERS','TRICEPS','TRICEPS'],
      ['BACK','BACK','BICEPS','BICEPS'],                 // usunięto ABS
      ['QUADS','POSTERIOR','CALVES','QUADS','POSTERIOR'],
      ['CHEST','BACK','CHEST','BACK','CHEST','BACK'],
      ['SHOULDERS','SHOULDERS','BICEPS','BICEPS','TRICEPS','TRICEPS'],
    ]; }

    function buildStrictPlan_Others({ sessionsPerWeek = 3, split = '' }){
      let layout;
      if (sessionsPerWeek === 3) {
        layout = (split==='PPL') ? scheme3_PPL() : scheme3_FBW();
      } else if (sessionsPerWeek === 4) {
        layout = (split==='UL' || split==='UPPER_LOWER' || split==='UPPER/LOWER') ? scheme4_UL() : scheme4_PPL_FBW();
      } else if (sessionsPerWeek === 5) {
        layout = (split==='PPLPP' || split==='PPL+PP') ? scheme5_PPLPP() : scheme5_PPL_ARNOLD();
      } else {
        layout = scheme3_FBW();
      }

      const days = [];
      layout.forEach((cats, i)=>{
        const rows = cats.map(cat=>{
          const ex = pickUnique(cat);
          return { cwiczenie: ex, serie: SETS_ALWAYS, powtorzenia: repsFor(cat) };
        });
        // akcesorium jako ostatnia pozycja
        appendMaleAccessory(rows);
        days.push({ day: dni[i], exercises: rows });
      });
      return { days };
    }

    // ========== Workbook (ExcelJS) – 3 kolumny, SERIE = sama liczba ==========
    async function makeWorkbook3Cols(plan){
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Plan', {
        properties: { defaultRowHeight: 18 },
        views: [{ state: 'normal', topLeftCell: 'B2', zoomScale: 120 }]
      });

      const H1 = (lang==='en'?'Training Plan':'Plan Treningowy');
      const HEX = (lang==='en'
        ? ['EXERCISE','SETS','REPS']
        : ['ĆWICZENIE','SERIE','POWTÓRZENIA']
      );

      ws.columns = [{ header:'', width:4 }, { header:HEX[0], width:36 }, { header:HEX[1], width:10 }, { header:HEX[2], width:14 }];

      ws.mergeCells('B1:D1');
      const t = ws.getCell('B1');
      t.value = H1;
      t.font = { name:'Arial', size:16, bold:true };
      t.alignment = { vertical:'middle', horizontal:'center' };
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
      const filename = (lang==='en'
        ? `Training_Plan_${new Date().toISOString().slice(0,10)}.xlsx`
        : `Plan_Treningowy_${new Date().toISOString().slice(0,10)}.xlsx`
      );
      return { buffer, filename };
    }

    // ========== ZŁOŻENIE ==========
    const plan = isFemale
      ? buildRuleBasedPlan_Women({ sessionsPerWeek: ses })
      : buildStrictPlan_Others({ sessionsPerWeek: ses, split });

    const { buffer, filename } = await makeWorkbook3Cols(plan);
    const base64 = Buffer.from(buffer).toString('base64');

    return { statusCode: 200, headers: headers(origin), body: JSON.stringify({ ok:true, fileBase64: base64, filename, meta:{ sessions: ses, split, isFemale } }) };
  }catch(e){
    console.error('generate-plan error', e);
    return { statusCode: 500, headers: headers(origin), body: JSON.stringify({ ok:false, error:'generate-plan failed', details:String(e.message||e) }) };
  }
};