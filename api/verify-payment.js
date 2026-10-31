// /api/verify-payment
// Runs after the customer has paid. It confirms the payment really happened,
// then creates the rider order exactly once.

import crypto from 'crypto';

const ALLOWED_ORIGIN = 'https://www.farxlogistics.com';

// Websites allowed to call this server. Browsers always tell us which site made the
// call, so a call from any other site is refused. (ALLOWED_EXTRA_ORIGINS is optional,
// comma separated, and normally left unset.)
const ORIGIN_ALLOWLIST = [
  'https://www.farxlogistics.com',
  'https://farxlogistics.com',
  ...String(process.env.ALLOWED_EXTRA_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean),
];

function originBlocked(req) {
  const o = req.headers && req.headers.origin;
  return Boolean(o) && !ORIGIN_ALLOWLIST.includes(o);
}

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (originBlocked(req)) {
    res.status(403).json({ error: 'Request not allowed.' });
    return true;
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

function isValidIndianMobile(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!/^[6-9]\d{9}$/.test(d)) return false;
  if (/(\d)\1{5,}/.test(d)) return false;
  if (new Set(d).size < 4) return false; // e.g. 9090909090
  if (/(?:012345|123456|234567|345678|456789|987654|876543|765432|654321|543210)/.test(d)) return false; // e.g. 9876543210
  return true;
}

function cleanText(v, min, max) {
  if (typeof v !== 'string') return null;
  // Remove line breaks, control characters and angle brackets, so names and addresses
  // cannot carry hidden commands or markup into the rider system.
  const t = v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length >= min && t.length <= max ? t : null;
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return null;
}

async function checkRateLimit(req, keyPrefix, limit = 10, windowSeconds = 60) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { allowed: true, configured: false };

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  const key = `ratelimit:${keyPrefix}:${ip}`;

  try {
    const incrRes = await fetch(`${url}/incr/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const incrData = await incrRes.json();
    const count = incrData.result;

    if (count === 1) {
      await fetch(`${url}/expire/${encodeURIComponent(key)}/${windowSeconds}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    return { allowed: count <= limit, configured: true, count };
  } catch {
    return { allowed: true, configured: true };
  }
}

// One Redis command via Upstash's REST API. Never throws.
// Returns { configured, ok, result }.
async function redis(args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { configured: false, ok: false, result: null };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const j = await r.json();
    return { configured: true, ok: r.ok && !j.error, result: j.result ?? null };
  } catch {
    return { configured: true, ok: false, result: null };
  }
}

function signaturesMatch(expectedHex, given) {
  if (typeof given !== 'string' || given.length !== expectedHex.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expectedHex), Buffer.from(given));
}

function validateBookingForDispatch(b) {
  if (!b || typeof b !== 'object') return null;
  const senderName = cleanText(b.senderName, 2, 80);
  const receiverName = cleanText(b.receiverName, 2, 80);
  const pickupAddress = cleanText(b.pickupAddress, 5, 700);
  const dropAddress = cleanText(b.dropAddress, 5, 700);
  if (!senderName || !receiverName || !pickupAddress || !dropAddress) return null;
  if (!isValidIndianMobile(b.senderPhone) || !isValidIndianMobile(b.receiverPhone)) return null;

  const num = (v) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : null);
  return {
    senderName,
    senderPhone: String(b.senderPhone).replace(/\D/g, ''),
    receiverName,
    receiverPhone: String(b.receiverPhone).replace(/\D/g, ''),
    pickupAddress,
    dropAddress,
    pLat: num(b.pickupLat),
    pLng: num(b.pickupLng),
    dLat: num(b.dropLat),
    dLng: num(b.dropLng),
    distanceKm: num(b.distanceKm),
    weightKg: num(b.weightKg),
    contents: typeof b.contents === 'string' ? b.contents.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '',
  };
}

async function postToShipday(payload, apiKey) {
  const authHeader = apiKey.toLowerCase().startsWith('basic ') ? apiKey : `Basic ${apiKey}`;
  const r = await fetch('https://api.shipday.com/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  const text = await r.text().catch(() => '');
  return { ok: r.ok, status: r.status, text };
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const rl = await checkRateLimit(req, 'verify-payment', 15, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: 'Too many requests. Please wait a moment and try again.' });
  }

  const body = readBody(req);
  if (!body) {
    return res.status(400).json({ success: false, error: 'Missing parameters' });
  }

  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;

    // Strict format check. These values are also placed in a URL below.
    if (
      typeof razorpay_order_id !== 'string' || !/^order_[A-Za-z0-9]+$/.test(razorpay_order_id) ||
      typeof razorpay_payment_id !== 'string' || !/^pay_[A-Za-z0-9]+$/.test(razorpay_payment_id) ||
      typeof razorpay_signature !== 'string' || !/^[a-f0-9]{64}$/.test(razorpay_signature)
    ) {
      return res.status(400).json({ success: false, error: 'Missing or invalid payment details' });
    }

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      console.error('verify-payment: payment keys are missing in environment variables');
      return res.status(500).json({ success: false, error: 'Server is not set up for payments.' });
    }

    // 1. Was this payment really made through us?
    const expected = crypto
      .createHmac('sha256', keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    if (!signaturesMatch(expected, razorpay_signature)) {
      return res.status(400).json({ success: false, error: 'Payment could not be verified' });
    }

    // 2. Booking details must be usable. The money is already taken at this point,
    //    so tell the customer clearly what to do instead of failing silently.
    const b = validateBookingForDispatch(body.booking);
    if (!b) {
      return res.status(400).json({
        success: false,
        paymentVerified: true,
        paymentId: razorpay_payment_id,
        error: 'Your payment went through, but the booking details were incomplete.',
      });
    }

    // 3. One payment can create only one rider order, even if this call is repeated.
    const lockKey = `paid:${razorpay_payment_id}`;
    const claim = await redis(['SET', lockKey, 'pending', 'NX', 'EX', 172800]);
    if (claim.configured && claim.ok && claim.result === null) {
      const existing = await redis(['GET', lockKey]);
      if (typeof existing.result === 'string' && existing.result.startsWith('FX-')) {
        return res.status(200).json({ success: true, dispatched: true, orderNumber: existing.result, duplicate: true });
      }
      return res.status(409).json({
        success: false,
        paymentVerified: true,
        paymentId: razorpay_payment_id,
        error: 'Your booking is already being processed. Please wait a few seconds.',
      });
    }
    const releaseLock = () => (claim.configured && claim.ok ? redis(['DEL', lockKey]) : null);

    // 4. Use the amount Razorpay actually received, never a number sent by the browser.
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    let orderRes;
    try {
      orderRes = await fetch(`https://api.razorpay.com/v1/orders/${razorpay_order_id}`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      orderRes = null;
    }
    if (!orderRes || !orderRes.ok) {
      await releaseLock();
      return res.status(502).json({
        success: false,
        paymentVerified: true,
        paymentId: razorpay_payment_id,
        error: 'Could not confirm the amount right now. Please try again.',
      });
    }
    const orderInfo = await orderRes.json();
    const fareRupees = Number(orderInfo.amount) / 100;
    if (!Number.isFinite(fareRupees) || fareRupees <= 0) {
      await releaseLock();
      return res.status(502).json({ success: false, paymentVerified: true, paymentId: razorpay_payment_id, error: 'Could not confirm the amount.' });
    }

    // 5. Create the rider order.
    const orderNumber = 'FX-ONL-' + crypto.randomInt(100000, 1000000);
    const shipdayKey = (process.env.SHIPDAY_API_KEY || '').trim();

    let dispatched = false;
    if (shipdayKey) {
      const weightText = b.weightKg ? `${b.weightKg} kg` : 'weight not stated';
      const kmText = b.distanceKm ? `, ${b.distanceKm} km` : '';
      const basePayload = {
        orderNumber,
        customerName: b.receiverName,
        customerAddress: b.dropAddress,
        customerPhoneNumber: b.receiverPhone,
        customerEmail: '',
        restaurantName: `${b.senderName} (Pickup)`,
        restaurantAddress: b.pickupAddress,
        restaurantPhoneNumber: b.senderPhone,
        totalOrderCost: fareRupees,
        deliveryFee: fareRupees,
        paymentMethod: 'credit_card',
        orderItem: [
          {
            name: `Courier Freight (${weightText}${kmText}) - Contents: ${b.contents || 'not stated'} - PAID online (${razorpay_payment_id})`,
            unitPrice: fareRupees,
            quantity: 1,
          },
        ],
      };

      const extras = {
        deliveryInstruction: `Parcel: ${b.contents || 'not stated'}, ${weightText}. Already paid online. Sender: ${b.senderName} ${b.senderPhone}`,
        pickupInstruction: `Already paid online. Parcel: ${b.contents || 'not stated'}, ${weightText}. Receiver: ${b.receiverName} ${b.receiverPhone}`,
      };
      if ([b.pLat, b.pLng, b.dLat, b.dLng].every((v) => v !== null)) {
        extras.pickupLatitude = b.pLat;
        extras.pickupLongitude = b.pLng;
        extras.deliveryLatitude = b.dLat;
        extras.deliveryLongitude = b.dLng;
      }

      try {
        let result = await postToShipday({ ...basePayload, ...extras }, shipdayKey);
        if (!result.ok && result.status >= 400 && result.status < 500) {
          // Retry once with only the basic fields, in case an optional field was refused.
          console.error('verify-payment: dispatch refused, retrying basic', result.status, result.text.slice(0, 300));
          result = await postToShipday(basePayload, shipdayKey);
        }
        dispatched = result.ok;
        if (!result.ok) {
          console.error('verify-payment: dispatch failed', result.status, result.text.slice(0, 300), 'payment', razorpay_payment_id);
        }
      } catch (e) {
        console.error('verify-payment: dispatch error', e && e.message, 'payment', razorpay_payment_id);
      }
    } else {
      console.error('verify-payment: dispatch key is missing in environment variables');
    }

    if (dispatched) {
      await redis(['SET', lockKey, orderNumber, 'EX', 172800]);
      return res.status(200).json({ success: true, dispatched: true, orderNumber });
    }

    // Paid, but the rider order was not created. Let the customer retry safely and
    // tell them what to do. The booking is also stored in the payment's notes.
    await releaseLock();
    return res.status(200).json({
      success: true,
      dispatched: false,
      orderNumber,
      paymentId: razorpay_payment_id,
      message: 'Payment received. We could not create your pickup automatically, so our team will confirm it on WhatsApp.',
    });
  } catch (err) {
    console.error('verify-payment: unexpected error', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}
