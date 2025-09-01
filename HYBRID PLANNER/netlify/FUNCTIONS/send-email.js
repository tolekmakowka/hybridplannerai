// netlify/functions/send-email.js
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const ALLOWED_ORIGINS = new Set([
  'https://tgmproject.net',
  'https://www.tgmproject.net',
  'https://hybridplannerai.netlify.app',
  'http://localhost:8888',
  'http://localhost:5173',
  'http://localhost:3000'
]);

function corsHeaders(origin) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || '';

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    if (!RESEND_API_KEY) {
      return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'RESEND_API_KEY not set' }) };
    }

    const { to, subject, html, attachmentBase64, filename } = JSON.parse(event.body || '{}');
    if (!to) {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Missing "to"' }) };
    }

    const from = 'no-reply@tgmproject.net';
    const payload = {
      from,
      to,
      subject: subject || 'Twój plan treningowy',
      html: html || '<p>W załączniku Twój plan.</p>',
      attachments: (attachmentBase64 && filename) ? [{ content: attachmentBase64, filename }] : []
    };

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,   // << poprawka
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    if (!r.ok) {
      return { statusCode: r.status || 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Resend error', details: text }) };
    }

    return { statusCode: 200, headers: corsHeaders(origin), body: text };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Unhandled exception', message: String(e) }) };
  }
};
