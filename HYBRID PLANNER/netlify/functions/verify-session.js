'use strict';

const Stripe = require('stripe');

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || '*';

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(origin) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors(origin), body: 'Method not allowed' };
  }

  try {
    const { sessionId } = JSON.parse(event.body || '{}');
    if (!sessionId) throw new Error('sessionId missing');

    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
    if (!STRIPE_SECRET_KEY) throw new Error('Missing STRIPE_SECRET_KEY');

    const stripe = Stripe(STRIPE_SECRET_KEY);
    const s = await stripe.checkout.sessions.retrieve(sessionId);

    return {
      statusCode: 200,
      headers: cors(origin),
      body: JSON.stringify({ ok: true, paid: s.payment_status === 'paid', status: s.payment_status })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: cors(origin),
      body: JSON.stringify({ ok: false, error: String(err) })
    };
  }
};
