// /api/create-payment
// Checks the booking, works out the fare ON THE SERVER, and creates the
// payment order for exactly that amount. The browser can no longer choose
// what it pays.

const ALLOWED_ORIGIN = 'https://www.farxlogistics.com';

// ---------------------------------------------------------------------------
// FARE RULES. Keep this block identical to RATE in index.html.
// To change prices: edit the numbers here AND in index.html, then redeploy both.
// ---------------------------------------------------------------------------
const RATE = {
  baseFare: 50, // rupees, covers the first 3 km and up to 5 kg
  distanceBands: [
    { fromKm: 3, toKm: 10, perKm: 11 },
    { fromKm: 10, toKm: Infinity, perKm: 13 },
  ],
  weightSlabs: [
    { upToKg: 5, charge: 0 },
    { upToKg: 10, charge: 30 },
    { upToKg: 15, charge: 60 },
    { upToKg: 20, charge: 90 },
  ],
  maxKg: 20,
  maxLocalKm: 40,
};

// Local delivery only runs inside Kozhikode district (generous box).
const SERVICE_AREA = { minLat: 10.95, maxLat: 11.8, minLng: 75.4, maxLng: 76.2 };

function calculateFare(distanceKm, weightKg) {
  let distanceCharge = 0;
  for (const band of RATE.distanceBands) {
    if (distanceKm > band.fromKm) {
      distanceCharge += (Math.min(distanceKm, band.toKm) - band.fromKm) * band.perKm;
    }
  }
  distanceCharge = Math.round(distanceCharge);

  let slab = RATE.weightSlabs[RATE.weightSlabs.length - 1];
  for (const s of RATE.weightSlabs) {
    if (weightKg <= s.upToKg) {
      slab = s;
      break;
    }
  }
  return RATE.baseFare + distanceCharge + slab.charge;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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

function isBot(body) {
  if (!body || typeof body !== 'object') return true;
  if (body.hp) return true; // honeypot field was filled in
  if (body.ts && Date.now() - Number(body.ts) < 1200) return true; // submitted too fast
  return false;
}

function isValidIndianMobile(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!/^[6-9]\d{9}$/.test(d)) return false;
  if (/(\d)\1{5,}/.test(d)) return false; // 6+ identical digits in a row
  if (new Set(d).size < 4) return false; // e.g. 9090909090
  if (/(?:012345|123456|234567|345678|456789|987654|876543|765432|654321|543210)/.test(d)) return false; // e.g. 9876543210
  return true;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function inServiceArea(lat, lng) {
  return (
    lat >= SERVICE_AREA.minLat &&
    lat <= SERVICE_AREA.maxLat &&
    lng >= SERVICE_AREA.minLng &&
    lng <= SERVICE_AREA.maxLng
  );
}

function cleanText(v, min, max) {
  if (typeof v !== 'string') return null;
  // Remove line breaks, control characters and angle brackets, so names and addresses
  // cannot carry hidden commands or markup into the rider system.
  const t = v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length >= min && t.length <= max ? t : null;
}

// Returns { ok: true, value } or { ok: false, error }.
function validateBooking(b) {
  if (!b || typeof b !== 'object') return { ok: false, error: 'Booking details are missing.' };

  const senderName = cleanText(b.senderName, 2, 80);
  const receiverName = cleanText(b.receiverName, 2, 80);
  if (!senderName) return { ok: false, error: 'Please enter the sender name.' };
  if (!receiverName) return { ok: false, error: 'Please enter the receiver name.' };

  if (!isValidIndianMobile(b.senderPhone)) {
    return { ok: false, error: 'Please enter a valid 10-digit mobile number for the sender.' };
  }
  if (!isValidIndianMobile(b.receiverPhone)) {
    return { ok: false, error: 'Please enter a valid 10-digit mobile number for the receiver.' };
  }

  const pickupAddress = cleanText(b.pickupAddress, 5, 700);
  const dropAddress = cleanText(b.dropAddress, 5, 700);
  if (!pickupAddress || !dropAddress) {
    return { ok: false, error: 'Please select both pickup and drop locations.' };
  }

  const pLat = Number(b.pickupLat);
  const pLng = Number(b.pickupLng);
  const dLat = Number(b.dropLat);
  const dLng = Number(b.dropLng);
  if (![pLat, pLng, dLat, dLng].every(Number.isFinite)) {
    return { ok: false, error: 'Please pin both locations on the map.' };
  }
  if (!inServiceArea(pLat, pLng) || !inServiceArea(dLat, dLng)) {
    return {
      ok: false,
      error: 'Local delivery covers Kozhikode district only. For other places, use the Outstation option.',
    };
  }

  const straightKm = haversineKm(pLat, pLng, dLat, dLng);
  if (straightKm < 0.05) {
    return { ok: false, error: 'Pickup and drop cannot be the same spot.' };
  }

  const distanceKm = Number(b.distanceKm);
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    return { ok: false, error: 'Distance could not be worked out. Please pin both locations again.' };
  }
  if (distanceKm > RATE.maxLocalKm) {
    return { ok: false, error: `Local delivery covers up to ${RATE.maxLocalKm} km. Please use the Outstation option.` };
  }
  // A road is never shorter than the straight line, and rarely more than ~2.5x longer.
  if (distanceKm < straightKm * 0.97 - 0.1 || distanceKm > straightKm * 2.5 + 1) {
    return { ok: false, error: 'Distance does not match the pinned locations. Please pin both locations again.' };
  }

  const weightKg = Number(b.weightKg);
  if (!Number.isFinite(weightKg) || weightKg <= 0) {
    return { ok: false, error: 'Please enter the parcel weight.' };
  }
  if (weightKg > RATE.maxKg) {
    return { ok: false, error: `Local delivery is for parcels up to ${RATE.maxKg} kg. Please WhatsApp us for heavier shipments.` };
  }

  const contents = typeof b.contents === 'string' ? b.contents.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '';

  return {
    ok: true,
    value: {
      senderName,
      senderPhone: String(b.senderPhone).replace(/\D/g, ''),
      receiverName,
      receiverPhone: String(b.receiverPhone).replace(/\D/g, ''),
      pickupAddress,
      dropAddress,
      pLat,
      pLng,
      dLat,
      dLng,
      distanceKm,
      weightKg,
      contents,
    },
  };
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
    return { allowed: true, configured: true }; // never block customers if the limiter is down
  }
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

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rl = await checkRateLimit(req, 'create-payment', 10, 60);
  if (!rl.allowed) {
    return res.status(429).json({ error: 'Too many attempts. Please wait a minute and try again.' });
  }

  const body = readBody(req);
  if (isBot(body)) {
    return res.status(400).json({ error: 'Request could not be processed.' });
  }

  try {
    const checked = validateBooking(body.booking);
    if (!checked.ok) {
      return res.status(400).json({ error: checked.error });
    }
    const b = checked.value;

    // The fare is decided here, not by the browser.
    const fare = calculateFare(b.distanceKm, b.weightKg);

    // If the browser's figure differs, the page is out of date (or tampered with).
    const shown = Number(body.amount);
    if (Number.isFinite(shown) && Math.abs(shown - fare) > 1) {
      return res.status(409).json({
        error: 'The fare has been updated. Please refresh the page and try again.',
        fare,
      });
    }

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      console.error('create-payment: payment keys are missing in environment variables');
      return res.status(500).json({ error: 'Online payment is not available right now. Please WhatsApp us to book.' });
    }

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        amount: Math.round(fare * 100),
        currency: 'INR',
        receipt: `FX${Date.now()}`,
        // Shown in the payment dashboard, so you can match a payment to a booking
        // even if the rider order did not get created.
        notes: {
          sender: `${b.senderName} ${b.senderPhone}`.slice(0, 200),
          receiver: `${b.receiverName} ${b.receiverPhone}`.slice(0, 200),
          pickup: b.pickupAddress.slice(0, 250),
          drop: b.dropAddress.slice(0, 250),
          km: String(b.distanceKm),
          kg: String(b.weightKg),
        },
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error('create-payment: payment order failed', response.status, JSON.stringify(data));
      return res.status(502).json({ error: 'Could not start the payment. Please try again in a moment.' });
    }

    return res.status(200).json({ ...data, keyId, fare });
  } catch (err) {
    console.error('create-payment: unexpected error', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
}
