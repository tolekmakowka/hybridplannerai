// netlify/functions/generate-plan.js
export async function handler(event) {
  // CORS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      }
    };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return { statusCode: 500, body: 'Missing OPENAI_API_KEY' };
    }

    const payload = JSON.parse(event.body || '{}');
    const { mode, title, inputs } = payload || {};
    if (!mode || !inputs) return { statusCode: 400, body: 'Bad payload' };

    const {
      // Plan A (5 pytań)
      sessionsPerWeek,        // Ile razy w tygodniu chcesz ćwiczyć
      goal,                   // Cel główny
      level,                  // Poziom aktywności
      equipment,              // Sprzęt
      splitPreference,        // FBW/PPL/UpperLower/Arnold/Auto
      // Plan B (hybrydowy)
      disciplines, prio1, prio2, sessionsPerWeek: spwB, days, minPerSession,
      notes
    } = inputs;

    const exercises = `
Używaj WYŁĄCZNIE tych ćwiczeń:
- Klatka: Flat bench press, Incline bench press, Pec deck
- Plecy: Lat pulldown, Close grip horizontal row, Horizontal row 45*, Bent over row
- Barki: Overhead press, Face pull, Lateral raise
- Biceps: Biceps curl, Hammer curl
- Triceps: Triceps extension, Triceps overhead extension
- Brzuch: Hanging knee raises
- Przedramię: Forearm curl
- Tylna taśma KD: Deadlift, Leg curl
- Przednia taśma KD: Squat, Leg extension
- Łydki: Calf raises
`;

    const commonRules = `
FORMAT planu treningowego:
- Każdy dzień treningowy ma mieć oznaczenie dnia tygodnia (np. "Poniedziałek").
- Każdy dzień ma 5–8 ćwiczeń.
- Każde ćwiczenie ma zakres: 3–4 serie × 8–12 powtórzeń.
- Dobieraj ćwiczenia zgodnie z cyklem dnia:
  • PUSH: klatka, barki, triceps, + brzuch (opcjonalnie)
  • PULL: plecy, biceps, przedramię, + brzuch (opcjonalnie)
  • UPPER: klatka, plecy, barki, biceps, triceps, brzuch
  • LOWER/LEGS: przednia taśma KD, tylna taśma KD, łydki
  • FBW: klatka, plecy, barki, biceps, triceps, brzuch, przednia i tylna taśma KD
- Na rozległe partie (klatka, plecy) – 3 ćwiczenia; na mniejsze (biceps, triceps, barki, przednia/tylna taśma KD) – 2; + 1 na partię dodatkową (brzuch/przedramię/łydki).
- Zachowaj 24–48 h przerwy pomiędzy bodźcami tej samej partii.
- Kolejność w dniu: najpierw duże partie, potem mniejsze, na końcu dodatkowe.
${exercises}
`;

    const promptA = `
Jesteś doświadczonym trenerem S&C. Na podstawie danych ułóż uporządkowany PLAN na 12 tygodni w języku polskim.

DANE:
- Sesje/tydzień: ${sessionsPerWeek}
- Cel: ${goal}
- Poziom: ${level}
- Sprzęt: ${equipment}
- Preferowany split: ${splitPreference || 'dopasowany automatycznie'}

Wytyczne:
- Split dopasuj do preferencji użytkownika (FBW/PPL/Upper Lower/Arnold Split lub dopasuj automatycznie jeśli podano "dopasowany").
- Plan rozpisz tydzień po tygodniu (Tydzień 1 ... Tydzień 12), z dniami tygodnia i ćwiczeniami.
${commonRules}
Zwróć czysty plan bez komentarzy i bez powtarzania reguł.
`;

    const promptB = `
Jesteś doświadczonym trenerem S&C. Ułóż HYBRYDOWY plan tygodniowy (4 tygodnie) w języku polskim.

DANE:
- Dyscypliny: ${disciplines || '-'}
- Priorytet 1: ${prio1 || '-'}
- Priorytet 2: ${prio2 || '-'}
- Jednostek/tydzień: ${spwB || sessionsPerWeek || '-'}
- Dostępne dni: ${days || '-'}
- Czas na jednostkę (min): ${minPerSession || '-'}
- Poziom: ${level || '-'}
- Sprzęt: ${equipment || '-'}

Wytyczne:
- Wyraźny podział na dni treningowe i nietreningowe.
- Dni siłowni opisz jako np. UPPER/LOWER/PUSH/PULL/LEGS/FBW i rozpisz ćwiczenia zgodnie z regułami doboru z listy dostępnych ćwiczeń.
- Zachowaj 24–48 h przerwy między podobnymi bodźcami.
${commonRules}
Zwróć czysty plan bez komentarzy i bez powtarzania reguł.
`;

    const system = { role: 'system', content: 'Jesteś skrupulatnym trenerem siłowym i kondycyjnym. Zwracaj wyłącznie finalny plan w języku polskim.' };
    const user = { role: 'user', content: mode === 'A' ? promptA : promptB };

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.4,
        messages: [system, user]
      })
    });

    const data = await resp.json();
    if (!resp.ok) {
      return { statusCode: resp.status, body: JSON.stringify(data) };
    }

    const planText = data.choices?.[0]?.message?.content?.trim() || 'Brak treści';
    const planName = title || (mode === 'A' ? 'Plan Treningowy (12 tygodni)' : 'Hybrydowy Plan Treningowy (4 tygodnie)');

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ planText, planName })
    };
  } catch (e) {
    return { statusCode: 500, body: String(e) };
  }
}