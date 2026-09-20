// ---- Shared anti-abuse helpers (also duplicated in create-payment.js and
// verify-payment.js since these are standalone serverless functions) ----

const ALLOWED_ORIGIN = 'https://www.farxlogistics.com';

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true; // caller should stop here
  }
  return false;
}

function isBot(body) {
  // hp = honeypot field, invisible to real users, bots tend to fill it in.
  // ts = timestamp (ms) from when the form was rendered; a real human
  // can't fill and submit a form in under ~1.2 seconds.
  if (!body) return true;
  if (body.hp) return true;
  if (body.ts && Date.now() - Number(body.ts) < 1200) return true;
  return false;
}

// Sliding-window rate limit via Upstash Redis REST API (no npm package
// needed — plain fetch calls). Set UPSTASH_REDIS_REST_URL and
// UPSTASH_REDIS_REST_TOKEN in your Vercel env vars (free tier at
// upstash.com works fine). If those aren't set, this fails OPEN
// (doesn't block anyone) so you're never locked out by a misconfig —
// but you won't actually be rate limited until you add them.
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
    // If Upstash itself is down, fail open rather than blocking real customers.
    return { allowed: true, configured: true };
  }
}

// ---- End shared helpers ----

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rl = await checkRateLimit(req, 'book', 8, 60); // 8 bookings/min/IP
  if (!rl.allowed) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  }

  if (isBot(req.body)) {
    // Respond as if it worked so bots don't learn to route around this check.
    return res.status(200).json({ success: true });
  }

  try {
    const rawKey = process.env.SHIPDAY_API_KEY;
    if (!rawKey) {
      return res.status(500).json({ error: 'Shipday API key is missing in Vercel Environment Variables.' });
    }

    const apiKey = rawKey.trim();
    // Strip the anti-bot fields before forwarding the order to Shipday.
    const { hp, ts, ...orderData } = req.body || {};

    const requiredFields = [
      'orderNumber',
      'customerName',
      'customerAddress',
      'customerPhoneNumber',
      'restaurantAddress',
      'restaurantPhoneNumber',
      'totalOrderCost',
    ];
    const missing = requiredFields.filter((f) => !orderData[f]);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required field(s): ${missing.join(', ')}` });
    }
    if (typeof orderData.totalOrderCost !== 'number' || !Number.isFinite(orderData.totalOrderCost) || orderData.totalOrderCost <= 0) {
      return res.status(400).json({ error: 'Invalid order cost' });
    }

    const authHeader = apiKey.toLowerCase().startsWith('basic ')
      ? apiKey
      : `Basic ${apiKey}`;

    const response = await fetch('https://api.shipday.com/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify(orderData),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'Could not create the delivery order. Please try again or contact support.',
      });
    }

    return res.status(200).json(data || {});
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
}
