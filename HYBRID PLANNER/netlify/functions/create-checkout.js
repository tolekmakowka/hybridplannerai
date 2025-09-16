// netlify/functions/create-checkout.js
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
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
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
    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

    // === CENY ===
    // AI: STRIPE_PRICE_AI (głównie), z fallbackiem do *_AI_ID i historycznego STRIPE_PRICE_ID
    // CUSTOM (indywidualny): STRIPE_PRICE_CUSTOM (głównie), z fallbackiem do *_CUSTOM_ID
    const PRICE_AI =
      process.env.STRIPE_PRICE_AI ||
      process.env.STRIPE_PRICE_AI_ID ||
      process.env.STRIPE_PRICE_ID || // backward compatibility
      '';

    const PRICE_CUSTOM =
      process.env.STRIPE_PRICE_CUSTOM ||
      process.env.STRIPE_PRICE_CUSTOM_ID ||
      '';

    if (!STRIPE_SECRET_KEY) {
      return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Stripe secret key missing' }) };
    }

    const body = JSON.parse(event.body || '{}');

    // akceptuj zarówno "product" jak i "plan"
    const planOrProduct = (body.product || body.plan || 'ai').toString().toLowerCase();
    const email      = body.email || '';
    const successUrl = body.successUrl || '';
    const cancelUrl  = body.cancelUrl  || '';
    const successPath = body.successPath || ''; // np. wysyłane z index.html (opcjonalnie)

    // wybór priceId wg produktu
    const priceId = (planOrProduct === 'custom') ? PRICE_CUSTOM : PRICE_AI;
    if (!priceId) {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Missing Stripe price id for selected product', details: { plan: planOrProduct } }) };
    }

    // bazowy adres (gdy origin nie jest dostępny)
    const proto = event.headers['x-forwarded-proto'] || 'https';
    const host  = event.headers['x-forwarded-host'] || event.headers.host || '';
    const baseFromHeaders = (host ? `${proto}://${host}` : '');

    // domyślne ścieżki powrotu
    const defaultPath = planOrProduct === 'custom' ? '/ankieta.html' : '/generator.html';
    const base = origin || baseFromHeaders;

    // helper do łączenia query
    const withParams = (u, params) => u + (u.includes('?') ? '&' : '?') + params;

    // success/cancel URL
    const finalSuccess = successUrl
      ? (successUrl.includes('{CHECKOUT_SESSION_ID}')
          ? successUrl
          : withParams(successUrl, 'session_id={CHECKOUT_SESSION_ID}&checkout=success'))
      : withParams(`${base}${successPath || defaultPath}`, 'session_id={CHECKOUT_SESSION_ID}&checkout=success');

    const finalCancel = cancelUrl
      ? (cancelUrl.includes('checkout=') ? cancelUrl : withParams(cancelUrl, 'checkout=cancel'))
      : withParams(`${base}${successPath || defaultPath}`, 'checkout=cancel');

    const stripe = require('stripe')(STRIPE_SECRET_KEY);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email || undefined,
      success_url: finalSuccess,
      cancel_url:  finalCancel,
      billing_address_collection: 'auto',
      allow_promotion_codes: true,
      metadata: {
        product: planOrProduct // 'ai' | 'custom'
      }
    });

    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify({ url: session.url }) };
  } catch (e) {
    console.error('create-checkout failed', e);
    const msg = (e && e.raw && e.raw.message) ? e.raw.message : (e.message || String(e));
    return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'create-checkout failed', details: msg }) };
  }
};
