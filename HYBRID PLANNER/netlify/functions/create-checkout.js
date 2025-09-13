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
    'Content-Type': 'application/json; charset=utf-8'
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

    // Mapowanie cen: AI i Indywidualny
    const PRICE_AI     = process.env.STRIPE_PRICE_AI_ID     || process.env.STRIPE_PRICE_ID; // wsteczna zgodność
    const PRICE_CUSTOM = process.env.STRIPE_PRICE_CUSTOM_ID;

    if (!STRIPE_SECRET_KEY) {
      return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Stripe secret key missing' }) };
    }

    const { email, successUrl, cancelUrl, product } = JSON.parse(event.body || '{}');

    // Wybór priceId na podstawie produktu
    const priceId = (product === 'custom')
      ? PRICE_CUSTOM
      : PRICE_AI;

    if (!priceId) {
      return {
        statusCode: 400,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: 'Missing Stripe price id for product', details: { product } })
      };
    }

    const stripe = require('stripe')(STRIPE_SECRET_KEY);

    // Domyślne adresy powrotu (jeśli klient nie poda)
    const path = (product === 'custom') ? '/ankieta.html' : '/generator.html';
    const defSuccess = origin ? `${origin}${path}?checkout=success` : undefined;
    const defCancel  = origin ? `${origin}${path}?checkout=cancel`  : undefined;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email || undefined,
      success_url: successUrl || defSuccess,
      cancel_url:  cancelUrl  || defCancel,
      billing_address_collection: 'auto',
      allow_promotion_codes: true
    });

    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify({ url: session.url }) };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'create-checkout failed', details: String(e) }) };
  }
};
