// netlify/functions/generate-plan.js
export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders() };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: 'Method Not Allowed' };
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
  const RESEND_FROM = process.env.RESEND_FROM || 'HybridPlanner <no-reply@yourdomain.com>';

  if (!OPENAI_API_KEY) {
    return { statusCode: 500, headers: corsHeaders(), body: 'Missing OPENAI_API_KEY' };
  }

  let payload = {};
  try { payload = JSON.parse(event.body || '{}'); } 
  catch { return { statusCode: 400, headers: corsHeaders(), body: 'Bad JSON' }; }

  const { type = 'A', lang = 'pl', inputs = {} } = payload;

  const langSafe = String(lang).toLowerCase().startsWith('en') ? 'en' : 'pl';
  const isA = String(type).toUpperCase() === 'A';
  const planLabel = isA
    ? (langSafe==='en' ? 'Plan A — 12-week' : 'Plan A — 12 tygodni')
    : (langSafe==='en' ? 'Plan B — 4-week hybrid week' : 'Plan B — 4 tygodnie (hybrydowy tydzień)');

  const system = `
You are an elite hybrid-training coach (strength, running, climbing, conditioning).
Write in language: ${langSafe}. Be concise, practical, and structured.
This is NOT medical advice. If any pain/illness, recommend consulting a professional.

Output strictly as Markdown with these sections (use the language ${langSafe} for headings):
1) Cel (Goal) — 1–3 bullets
2) Założenia i ograniczenia (Assumptions & constraints)
3) Tygodniowy rozkład (Weekly schedule) — list days Mon..Sun for each week block
   - For 12-week plan: show Weeks 1–4, 5–8, 9–12 (with deload in week 4 and/or 8 if justified).
   - For 4-week hybrid: show Weeks 1–4 with day-by-day split.
4) Jednostki (Sessions) — name, focus, key exercises, cues
5) Objętość / Intensywność (Volume/Intensity) — sets×reps, RPE/pace/zone
6) Progresja (Progression) — microcycle + mesocycle, % changes week-to-week
7) Deload / Recovery — where and how to reduce volume/intensity
8) Modyfikacje (Modifications) — beginner / intermediate / advanced
9) Uwagi dot. kontuzji i bezpieczeństwa (Injury & safety notes) — generic cautions, scaling

Heuristics:
- Keep 24–48h between high-intensity stress on the same muscle group or system.
- Avoid conflicts (e.g., heavy lower-body strength day vs. intervals on the same/next day).
- Respect available time and equipment; prioritize main goal first.
- If hybrid, interleave strength, endurance, and climbing intelligently; add mobility/core.
- Include concrete prescriptions (RPE/zones/tempos), not vague text.
  `;

  const userA = `
[${planLabel}]
Goal: ${inputs.goal || '-'}
Level: ${inputs.level || '-'}
Time per week (h): ${inputs.time || '-'}
Equipment: ${inputs.equipment || '-'}
Limitations: ${inputs.limits || '-'}
Preferences: ${inputs.prefs || '-'}
Email (for context only): ${inputs.email || '-'}
  `;

  const userB = `
[${planLabel}]
Disciplines: ${inputs.disc || '-'}
Frequencies: ${inputs.freq || '-'}
Available days: ${inputs.days || '-'}
Level: ${inputs.level || '-'}
Session time (min): ${inputs.session || '-'}
Limitations: ${inputs.limits || '-'}
Priorities: ${inputs.prio || '-'}
Equipment: ${inputs.equipment || '-'}
Notes: ${inputs.notes || '-'}
Email (for context only): ${inputs.email || '-'}
  `;

  try {
    const oa = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.6,
        max_tokens: 2200,
        messages: [
          { role: 'system', content: system.trim() },
          { role: 'user', content: (isA ? userA : userB).trim() }
        ]
      })
    });

    if (!oa.ok) {
      const text = await oa.text();
      return { statusCode: oa.status, headers: corsHeaders(), body: `OpenAI error: ${text}` };
    }
    const data = await oa.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const userEmail = String(inputs.email || '').trim();

    // E-mail przez Resend (opcjonalnie)
    const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
    const RESEND_FROM = process.env.RESEND_FROM || 'HybridPlanner <no-reply@yourdomain.com>';
    let emailed = false, email_error = '';
    if (RESEND_API_KEY && isEmail(userEmail)) {
      try {
        const subject = (langSafe==='en'
          ? `${planLabel} — Your generated plan`
          : `${planLabel} — Twój wygenerowany plan`);
        const html = emailHtmlTemplate(planLabel, content);
        const resMail = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: RESEND_FROM, to: [userEmail], subject, text: content, html })
        });
        if (!resMail.ok) { emailed = false; email_error = await resMail.text(); } else { emailed = true; }
      } catch (e) {
        emailed = false; email_error = String(e.message || e);
      }
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: content, emailed, email_error })
    };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders(), body: 'Server error: ' + err.message };
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization'
  };
}
function isEmail(s=''){ return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(s); }
function escapeHtml(s=''){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function emailHtmlTemplate(title, md) {
  return `
  <div style="font-family:Inter,Arial,sans-serif;background:#0f0f0f;color:#ededEA;padding:16px">
    <div style="max-width:720px;margin:0 auto;background:#151515;border:1px solid #2A2A2A;border-radius:12px;padding:16px">
      <h2 style="margin:0 0 10px;color:#fff;font-weight:700">${escapeHtml(title)}</h2>
      <p style="margin:0 0 14px;color:#c9c7c2">Poniżej znajdziesz swój plan w wersji tekstowej (Markdown). Zachowaj tę wiadomość.</p>
      <pre style="white-space:pre-wrap;word-wrap:break-word;font:14px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#eee">${escapeHtml(md)}</pre>
    </div>
  </div>`;
}