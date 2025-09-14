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
    const isFemale= gender.toLowerCase().includes('kobiet');

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
      ABS:       ['Hanging knee raises','Cable crunch','Ab wheel rollout','Plank 60s']
    };

    const dniPL = ['Poniedziałek','Wtorek','Środa','Czwartek','Piątek','Sobota','Niedziela'];
    const dniEN = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    const dni = (lang==='en'?dniEN:dniPL);

    // ========== RULESET DLA KOBIET (Twoje wytyczne) ==========
    function buildRuleBasedPlan_Women({ sessionsPerWeek = 3 }) {
      const multi = new Set(['hip thrust','back squat','deadlift','bulgarian split squats','flat bench press','incline bench press','overhead press','barbell row','lat pulldown','pull-up']);
      const iso   = (name) => !multi.has(name.toLowerCase());
      const R = {
        calves: ['Standing calf raise','Seated calf raise'],
        abs:    ['Plank','Hanging knee raises','Cable crunch'],
        upperA: ['Flat bench press','Lat pulldown','Overhead press','Barbell row','Lateral raise','Triceps extension','Biceps curl'],
        upperB: ['Incline bench press','Seated cable row','Face pull','Push-up (obciążony)','Hammer curl','Triceps rope pressdown']
      };
      const LEG_PRIMARY = ['hip thrust','back squat','deadlift','bulgarian split squats'];
      const LEG_SECOND  = ['hip adduction machine','hip adductor machine'];
      const LEG_THIRD   = ['kickback horizontal','back extension'];

      const rep = (n) => (iso(n) ? '12' : '10');
      const ser = (n) => '3×' + rep(n);
      const title = (n)=> n.replace(/\b\w/g, m => m.toUpperCase());

      function legDay(idx){
        const p1 = LEG_PRIMARY[idx % LEG_PRIMARY.length];
        const p2 = LEG_SECOND [idx % LEG_SECOND .length];
        const p3 = LEG_THIRD  [idx % LEG_THIRD  .length];
        const extras = [ R.calves[idx % R.calves.length], R.abs[idx % R.abs.length] ];

        const rows = []
          .concat([p1,p2,p3].map(n => ({ cwiczenie: title(n), serie: ser(n), powtorzenia: rep(n) })))
          .concat(extras.map(n => ({ cwiczenie: n, serie: ser(n), powtorzenia: rep(n) })))
          .concat([{ cwiczenie: (lang==='en'?'Incline treadmill walk':'Incline treadmill walk'), serie:'X', powtorzenia:'20min' }]);

        return rows;
      }
      function upperDay(idx){
        const bankU = (idx % 2 === 0 ? R.upperA : R.upperB).slice(0,5);
        return bankU.map(n => ({ cwiczenie:n, serie:'3×' + (n.match(/press|row|pulldown|push-up|overhead/i)?'10':'12'), powtorzenia:(n.match(/press|row|pulldown|push-up|overhead/i)?'10':'12') }));
      }

      const days = [];
      const s = Math.min(Math.max(1, sessionsPerWeek|0), 7);

      if (s === 3) {
        const order = [legDay(0), upperDay(0), legDay(1)];
        for (let i=0;i<s;i++) days.push({ day: dni[i], exercises: order[i] });
      } else {
        const legCount = Math.ceil(s * 0.5);
        for (let i=0;i<s;i++){
          const exs = (i < legCount) ? legDay(i) : upperDay(i);
          days.push({ day: dni[i], exercises: exs });
        }
      }
      return { days };
    }

    // ========== TWARDY SCHEMAT (wszyscy poza „kobiet…”) ==========
    function pick(cat, used) {
      const list = bank[cat] || [];
      for (const ex of list) if (!used.has(ex)) { used.add(ex); return ex; }
      return list[0] || cat;
    }
    const setStr = (cat)=> (cat==='CALVES'||cat==='ABS') ? '3×12' : '3×10';
    const repsStr= (cat)=> (cat==='CALVES'||cat==='ABS') ? '12'   : '10';

    function scheme3_FBW(){ return [
      ['BACK','CHEST','QUADS','TRICEPS','BICEPS'],
      ['BACK','CHEST','QUADS','TRICEPS','BICEPS'],
      ['BACK','CHEST','POSTERIOR','TRICEPS','BICEPS'],
    ]; }
    function scheme3_PPL(){ return [
      ['CHEST','CHEST','SHOULDERS','TRICEPS','TRICEPS'],
      ['BACK','BACK','BICEPS','BICEPS','ABS'],
      ['QUADS','POSTERIOR','CALVES','QUADS','POSTERIOR'],
    ]; }
    function scheme4_PPL_FBW(){ return [
      ['CHEST','CHEST','SHOULDERS','TRICEPS','TRICEPS'],
      ['BACK','BACK','BICEPS','BICEPS','ABS'],
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
      ['BACK','BACK','BICEPS','BICEPS','ABS'],
      ['QUADS','POSTERIOR','CALVES','QUADS','POSTERIOR'],
      ['CHEST','CHEST','SHOULDERS','TRICEPS','TRICEPS'],
      ['BACK','BACK','BICEPS','BICEPS','ABS'],
    ]; }
    function scheme5_PPL_ARNOLD(){ return [
      ['CHEST','CHEST','SHOULDERS','TRICEPS','TRICEPS'],
      ['BACK','BACK','BICEPS','BICEPS','ABS'],
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
        const used = new Set();
        const rows = cats.map(cat=>{
          const ex = pick(cat, used);
          return { cwiczenie: ex, serie: setStr(cat), powtorzenia: repsStr(cat) };
        });
        days.push({ day: dni[i], exercises: rows });
      });
      return { days };
    }

    // ========== Workbook (ExcelJS) ==========
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
