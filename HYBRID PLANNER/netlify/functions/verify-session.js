'use strict';

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
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || '';

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin) };
  }
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify({ ok:false, error:'Method not allowed' }) };
  }

  try {
    const SECRET = process.env.STRIPE_SECRET_KEY;
    if (!SECRET) {
      return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ ok:false, error:'Missing STRIPE_SECRET_KEY' }) };
    }
    const stripe = require('stripe')(SECRET);

    // session id z POST body lub z query string
    let id = '';
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      id = (body.session_id || body.id || body.sessionId || '').trim();
      if (!id) id = (event.queryStringParameters?.id || event.queryStringParameters?.session_id || '').trim();
    } else {
      id = (event.queryStringParameters?.id || event.queryStringParameters?.session_id || '').trim();
    }

    if (!id) {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ ok:false, error:'Missing session id' }) };
    }

    const s = await stripe.checkout.sessions.retrieve(id);
    const paid = s?.payment_status === 'paid' || s?.status === 'complete';
    const email = s?.customer_details?.email || s?.customer_email || '';
    const amount = typeof s?.amount_total === 'number' ? s.amount_total : null;
    const currency = s?.currency || null;

    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: JSON.stringify({
        ok: true,
        paid,
        email,
        amount_total: amount,
        currency,
        metadata: s?.metadata || {},
        id: s?.id
      })
    };
  } catch (e) {
    console.error('verify-session error', e);
    const msg = (e && e.raw && e.raw.message) ? e.raw.message : (e.message || String(e));
    return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ ok:false, error:'verify-session failed', details: msg }) };
  }
};
