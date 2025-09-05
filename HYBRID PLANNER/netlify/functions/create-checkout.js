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
    const STRIPE_PRICE_ID   = process.env.STRIPE_PRICE_ID;
    if (!STRIPE_SECRET_KEY || !STRIPE_PRICE_ID) {
      return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Stripe env missing' }) };
    }

    const { email, successUrl, cancelUrl } = JSON.parse(event.body || '{}');
    const stripe = require('stripe')(STRIPE_SECRET_KEY);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      customer_email: email || undefined,
      success_url: successUrl || `${origin}/generator.html?checkout=success`,
      cancel_url:  cancelUrl  || `${origin}/generator.html?checkout=cancel`,
      billing_address_collection: 'auto',
      allow_promotion_codes: true
    });

    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify({ url: session.url }) };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'create-checkout failed', details: String(e) }) };
  }
};
