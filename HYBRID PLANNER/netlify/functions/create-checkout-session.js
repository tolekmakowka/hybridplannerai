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
    const body = JSON.parse(event.body || '{}');
    const email   = (body.email || '').trim();
    const voucher = (body.voucher || '').trim().toUpperCase();

    // Voucher – bez płatności
    const VOUCHER_CODE = process.env.VOUCHER_CODE || 'TGMPRJCT';
    if (voucher && voucher === VOUCHER_CODE) {
      return {
        statusCode: 200,
        headers: cors(origin),
        body: JSON.stringify({ ok: true, voucher: true })
      };
    }

    // Normalna płatność Stripe
    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
    const STRIPE_PRICE_ID   = process.env.STRIPE_PRICE_ID;
    const PUBLIC_URL        = process.env.PUBLIC_URL || 'https://tgmproject.net';

    if (!STRIPE_SECRET_KEY) throw new Error('Missing STRIPE_SECRET_KEY');
    if (!STRIPE_PRICE_ID)   throw new Error('Missing STRIPE_PRICE_ID');

    const stripe = Stripe(STRIPE_SECRET_KEY);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      customer_email: email || undefined,
      allow_promotion_codes: true,
      success_url: `${PUBLIC_URL}/generator.html?paid=1`,
      cancel_url: `${PUBLIC_URL}/generator.html?canceled=1`
    });

    return {
      statusCode: 200,
      headers: cors(origin),
      body: JSON.stringify({ ok: true, url: session.url })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: cors(origin),
      body: JSON.stringify({ ok: false, error: String(err) })
    };
  }
};
