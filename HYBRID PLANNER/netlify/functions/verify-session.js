// netlify/functions/verify-session.js
'use strict';

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const sessionId = new URLSearchParams(event.rawQuery || '').get('session_id');
    if (!sessionId) {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ paid:false, error:'Missing session_id' }) };
    }

    const s = await stripe.checkout.sessions.retrieve(sessionId);
    const paid = s?.payment_status === 'paid';
    const email = s?.customer_details?.email || s?.customer_email || '';
    const amount = s?.amount_total || 0;
    const currency = s?.currency || '';

    // (opcjonalnie) twarde sprawdzenie kwoty
    const correct = paid && currency === 'pln' && amount === 999;

    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: JSON.stringify({ paid: correct, email, amount, currency })
    };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ paid:false, error:String(e) }) };
  }
};
