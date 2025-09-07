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
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify({ ok:false, error:'Method not allowed' }) };
  }

  try {
    // ====== ENV sprawdzenie ======
    const SECRET = process.env.STRIPE_SECRET_KEY;
    const PRICE  = process.env.STRIPE_PRICE_ID;
    if (!SECRET) throw new Error('Missing STRIPE_SECRET_KEY');
    if (!PRICE)  throw new Error('Missing STRIPE_PRICE_ID');

    // Stripe init
    const stripe = require('stripe')(SECRET);

    // ====== body ======
    const body = JSON.parse(event.body || '{}');
    const { email = '', voucher = '', inputs = {} } = body;

    // Voucher „TGMPRJCT” → bez płatności
    if ((voucher || '').trim().toUpperCase() === 'TGMPRJCT') {
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify({ ok:true, free:true }) };
    }

    // Success/Cancel URL
    const proto = event.headers['x-forwarded-proto'] || 'https';
    const host  = event.headers.host;
    const base  = (process.env.BASE_URL || `${proto}://${host}`).replace(/\/+$/,'');
    const success_url = `${base}/generator.html?session_id={CHECKOUT_SESSION_ID}`;
    const cancel_url  = `${base}/generator.html?cancelled=1`;

    // ====== tworzymy sesję ======
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: PRICE, quantity: 1 }],
      success_url,
      cancel_url,
      customer_email: email || undefined,
      // zachowaj odpowiedzi, żeby po płatności wiedzieć co generować
      metadata: { inputs: JSON.stringify(inputs || {}) },
      allow_promotion_codes: true
    });

    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: JSON.stringify({ ok:true, url: session.url })
    };
  } catch (err) {
    console.error('create-checkout error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin || ''),
      body: JSON.stringify({ ok:false, error:'create-checkout failed', details: String(err && err.message || err) })
    };
  }
};
