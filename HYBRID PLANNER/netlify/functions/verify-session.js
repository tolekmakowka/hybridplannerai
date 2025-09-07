'use strict';

const ALLOWED_ORIGINS = new Set([
  'https://tgmproject.net',
  'https://www.tgmproject.net',
  'http://localhost:8888',
  'http://localhost:5173',
  'http://localhost:3000'
]);
const headers = (o)=>({
  'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(o) ? o : '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
  'Content-Type': 'application/json; charset=utf-8'
});

exports.handler = async (event) => {
  const origin = event.headers?.origin || '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers(origin) };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: headers(origin), body: JSON.stringify({ ok:false, error:'Method not allowed' }) };

  try{
    const SECRET = process.env.STRIPE_SECRET_KEY;
    if (!SECRET) throw new Error('Missing STRIPE_SECRET_KEY');
    const stripe = require('stripe')(SECRET);

    const id = (event.queryStringParameters?.id || '').trim();
    if (!id) throw new Error('Missing session id');

    const s = await stripe.checkout.sessions.retrieve(id);
    const paid = s?.payment_status === 'paid';
    const email = s?.customer_details?.email || s?.customer_email || '';
    return { statusCode: 200, headers: headers(origin), body: JSON.stringify({ ok:true, paid, email, metadata: s?.metadata || {} }) };
  }catch(e){
    console.error('verify-session error', e);
    return { statusCode: 500, headers: headers(origin), body: JSON.stringify({ ok:false, error:'verify-session failed', details:String(e.message||e) }) };
  }
};
