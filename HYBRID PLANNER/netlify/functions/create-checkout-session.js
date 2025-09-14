// netlify/functions/create-checkout-session.js
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
    'Vary': 'Origin',
    'Content-Type': 'application/json; charset=utf-8'
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || '';

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify({ error:'Method not allowed' }) };
  }

  try {
    // ====== ENV ======
    const SECRET = process.env.STRIPE_SECRET_KEY;
    if (!SECRET) throw new Error('Missing STRIPE_SECRET_KEY');

    // ceny z ENV (AI ma też fallback do starego STRIPE_PRICE_ID)
    const PRICE_MAP = {
      AI: process.env.STRIPE_PRICE_AI || process.env.STRIPE_PRICE_ID || '',
      CUSTOM: process.env.STRIPE_PRICE_CUSTOM || ''
    };

    // ====== BODY ======
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch {}
    // front może wysłać: { type: 'AI'|'CUSTOM', email, successUrl, cancelUrl }
    const {
      type, plan, email = '',
      successUrl, cancelUrl,
      voucher = '',
      inputs = {},
      priceId // opcjonalny twardy override ceny (np. do testów)
    } = body;

    // normalizacja typu produktu
    const productType = String(type || plan || 'AI').toUpperCase();
    const chosenPrice = priceId || PRICE_MAP[productType];

    if (!chosenPrice) {
      throw new Error(`Missing price for type="${productType}". Set STRIPE_PRICE_${productType} in env.`);
    }

    // Voucher „TGMPRJCT” → bez płatności (np. do testów/giveaway)
    if ((voucher || '').trim().toUpperCase() === 'TGMPRJCT') {
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify({ ok:true, free:true }) };
    }

    // ====== URL-e powrotu ======
    // Preferuj absolutne URL-e z frontu; jeśli brak — buduj domyślne.
    const proto = event.headers['x-forwarded-proto'] || 'https';
    const host  = event.headers.host;
    const base  = (process.env.BASE_URL || `${proto}://${host}`).replace(/\/+$/,'');
    const defaultTarget = (productType === 'CUSTOM') ? 'ankieta.html' : 'generator.html';

    const okUrl  = (typeof successUrl === 'string' && successUrl.startsWith('http'))
      ? successUrl
      : `${base}/${defaultTarget}?checkout=success`;
    const badUrl = (typeof cancelUrl === 'string' && cancelUrl.startsWith('http'))
      ? cancelUrl
      : `${base}/${defaultTarget}?checkout=cancel`;

    // ====== Stripe ======
    const stripe = require('stripe')(SECRET);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: chosenPrice, quantity: 1 }],
      success_url: okUrl,
      cancel_url:  badUrl,
      customer_email: email || undefined,
      billing_address_collection: 'auto',
      allow_promotion_codes: true,
      metadata: {
        product_type: productType,       // 'AI' / 'CUSTOM'
        // przechowaj ewentualne dane wejściowe (krótkie!)
        inputs: (() => {
          try { return JSON.stringify(inputs || {}); } catch { return '{}'; }
        })()
      }
    });

    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify({ ok:true, url: session.url }) };
  } catch (err) {
    console.error('create-checkout-session error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders(origin),
      body: JSON.stringify({ ok:false, error:'create-checkout failed', details: String(err && err.message || err) })
    };
  }
};
