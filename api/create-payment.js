const ALLOWED_ORIGIN = 'https://www.farxlogistics.com';

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

function isBot(body) {
  if (!body) return true;
  if (body.hp) return true;
  if (body.ts && Date.now() - Number(body.ts) < 1200) return true;
  return false;
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

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rl = await checkRateLimit(req, 'create-payment', 10, 60); // 10 order-creates/min/IP
  if (!rl.allowed) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  }

  if (isBot(req.body)) {
    return res.status(400).json({ error: 'Request could not be processed.' });
  }

  try {
    const { amount, currency = 'INR', receipt } = req.body;

    const numericAmount = Number(amount);
    const MAX_FARE_RUPEES = 20000; // sanity ceiling — adjust to your real max
    if (!amount || !Number.isFinite(numericAmount) || numericAmount <= 0 || numericAmount > MAX_FARE_RUPEES) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      return res.status(500).json({ error: 'Razorpay keys not configured' });
    }

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        amount: Math.round(numericAmount * 100),
        currency,
        receipt: receipt || `rec_${Date.now()}`,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.description || 'Razorpay order creation failed' });
    }

    return res.status(200).json({ ...data, keyId });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
}
