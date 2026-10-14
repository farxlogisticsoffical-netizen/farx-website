// api/create-payment.js
const rateLimitMap = new Map();

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const clientIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    if (isRateLimited(clientIp, 10, 5 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many payment attempts. Please wait a moment.' });
    }

    const body = req.body || {};

    if (body.hp && String(body.hp).trim() !== '') {
      return res.status(400).json({ error: 'Invalid request' });
    }
    const now = Date.now();
    const openedAt = Number(body.ts) || 0;
    if (!openedAt || now - openedAt < 1500 || now - openedAt > 6 * 3600 * 1000) {
      return res.status(400).json({ error: 'Session expired. Please recalculate the fare and try again.' });
    }

    const b = body.booking || {};
    const pickupLat = parseFloat(b.pickupLat);
    const pickupLon = parseFloat(b.pickupLon);
    const dropLat = parseFloat(b.dropLat);
    const dropLon = parseFloat(b.dropLon);

    if (!isValidKeralaCoord(pickupLat, pickupLon) || !isValidKeralaCoord(dropLat, dropLon)) {
      return res.status(400).json({ error: 'Pickup and drop locations must be within active Kerala service limits.' });
    }

    const verifiedKm = await getVerifiedRoadDistanceKm(
      { lat: pickupLat, lon: pickupLon },
      { lat: dropLat, lon: dropLon }
    );

    if (verifiedKm <= 0 || verifiedKm > 50) {
      return res.status(400).json({ error: `Route distance (${verifiedKm.toFixed(1)} km) exceeds our 50 km local limit.` });
    }

    const weightKg = Math.min(Math.max(parseFloat(b.weightKg) || 0.5, 0.5), 20);
    const serverFareInr = calculateServerFare(verifiedKm, weightKg);
    const amountInPaise = serverFareInr * 100;

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      return res.status(500).json({ error: 'Payment gateway credentials not configured.' });
    }

    const authHeader = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${authHeader}`
      },
      body: JSON.stringify({
        amount: amountInPaise,
        currency: 'INR',
        receipt: 'farx_rcpt_' + Date.now(),
        notes: {
          verifiedKm: String(verifiedKm.toFixed(2)),
          weightKg: String(weightKg),
          verifiedFareInr: String(serverFareInr),
          pickupCoord: `${pickupLat.toFixed(5)},${pickupLon.toFixed(5)}`,
          dropCoord: `${dropLat.toFixed(5)},${dropLon.toFixed(5)}`
        }
      })
    });

    const rzpOrder = await rzpRes.json();

    if (!rzpRes.ok || !rzpOrder.id) {
      console.error('Razorpay order error:', rzpOrder);
      return res.status(502).json({ error: 'Could not initialize payment order.' });
    }

    return res.status(200).json({
      orderId: rzpOrder.id,
      id: rzpOrder.id,
      amount: rzpOrder.amount,
      currency: rzpOrder.currency,
      keyId: keyId,
      key: keyId
    });
  } catch (err) {
    console.error('Error in /api/create-payment:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

function isValidKeralaCoord(lat, lon) {
  return !isNaN(lat) && !isNaN(lon) && lat >= 8.0 && lat <= 13.5 && lon >= 74.5 && lon <= 77.8;
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function getVerifiedRoadDistanceKm(a, b) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const url = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error('OSRM error');
    const data = await res.json();
    if (!data.routes || !data.routes.length) throw new Error('No route');
    return data.routes[0].distance / 1000;
  } catch (e) {
    return haversineKm(a, b) * 1.3;
  }
}

function calculateServerFare(distanceKm, weightKg) {
  const BASE_FARE = 50, BASE_KM = 3, TIER1_MAX_KM = 10, TIER1_RATE = 10, TIER2_RATE = 12, BASE_KG = 5;
  let rawDistanceCharge = 0;
  if (distanceKm > BASE_KM) {
    if (distanceKm <= TIER1_MAX_KM) {
      rawDistanceCharge = (distanceKm - BASE_KM) * TIER1_RATE;
    } else {
      rawDistanceCharge = ((TIER1_MAX_KM - BASE_KM) * TIER1_RATE) + ((distanceKm - TIER1_MAX_KM) * TIER2_RATE);
    }
  }
  let weightCharge = 0;
  if (weightKg > BASE_KG) {
    if (weightKg <= 10) weightCharge = 25;
    else if (weightKg <= 15) weightCharge = 50;
    else weightCharge = 80;
  }
  return BASE_FARE + Math.round(rawDistanceCharge) + weightCharge;
}

function isRateLimited(ip, maxReqs, windowMs) {
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - record.start > windowMs) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return false;
  }
  record.count += 1;
  rateLimitMap.set(ip, record);
  return record.count > maxReqs;
}
