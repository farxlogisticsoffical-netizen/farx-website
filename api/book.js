// api/book.js
const rateLimitMap = new Map();

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const clientIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    if (isRateLimited(clientIp, 6, 5 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many booking attempts. Please wait a few minutes or message us on WhatsApp.' });
    }

    const body = req.body || {};

    if (body.hp && String(body.hp).trim() !== '') {
      return res.status(400).json({ error: 'Invalid request' });
    }
    const now = Date.now();
    const openedAt = Number(body.ts) || 0;
    if (!openedAt || now - openedAt < 1500 || now - openedAt > 6 * 3600 * 1000) {
      return res.status(400).json({ error: 'Session expired or submitted too fast. Please recalculate and try again.' });
    }

    const b = body.booking || {};

    const senderName = cleanStr(b.senderName, 80);
    const receiverName = cleanStr(b.receiverName, 80);
    const pickupAddress = cleanStr(b.pickupAddress, 250);
    const dropAddress = cleanStr(b.dropAddress, 250);
    const senderEmail = cleanStr(b.senderEmail, 100);
    const senderPhone = cleanPhone(b.senderPhone);
    const receiverPhone = cleanPhone(b.receiverPhone);

    if (!senderName || !receiverName || !pickupAddress || !dropAddress) {
      return res.status(400).json({ error: 'Missing required name or address fields.' });
    }
    if (!isValidIndianPhone(senderPhone) || !isValidIndianPhone(receiverPhone)) {
      return res.status(400).json({ error: 'Invalid 10-digit mobile number.' });
    }

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
    const serverFare = calculateServerFare(verifiedKm, weightKg);

    const orderNumber = 'FX-COD-' + Math.floor(100000 + Math.random() * 900000);
    const pickupGpsUrl = `https://maps.google.com/?q=${pickupLat.toFixed(5)},${pickupLon.toFixed(5)}`;
    const dropGpsUrl = `https://maps.google.com/?q=${dropLat.toFixed(5)},${dropLon.toFixed(5)}`;

    const shipdayPayload = {
      orderNumber,
      customerName: receiverName,
      customerAddress: dropAddress,
      customerPhoneNumber: receiverPhone,
      customerEmail: senderEmail,
      restaurantName: `${senderName} (Pickup)`,
      restaurantAddress: pickupAddress,
      restaurantPhoneNumber: senderPhone,
      totalOrderCost: serverFare,
      deliveryFee: serverFare,
      paymentMethod: 'cash',
      deliveryInstruction: `COD Freight: Collect ₹${serverFare} | Verified Distance: ${verifiedKm.toFixed(1)} km | Weight: ${weightKg} kg | Pickup Pin: ${pickupGpsUrl} | Drop Pin: ${dropGpsUrl}`,
      orderItem: [
        {
          name: `Intra-District Courier (${weightKg} kg, ${verifiedKm.toFixed(1)} km) - COD ₹${serverFare}`,
          unitPrice: serverFare,
          quantity: 1
        }
      ]
    };

    const shipdayApiKey = process.env.SHIPDAY_API_KEY;
    if (!shipdayApiKey) {
      return res.status(500).json({ error: 'Dispatch API key is not configured.' });
    }

    const shipdayRes = await fetch('https://api.shipday.com/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${shipdayApiKey}`
      },
      body: JSON.stringify(shipdayPayload)
    });

    if (!shipdayRes.ok) {
      const errText = await shipdayRes.text();
      console.error('Shipday API error:', errText);
      return res.status(502).json({ error: 'Could not register order with dispatch system.' });
    }

    return res.status(200).json({
      success: true,
      orderNumber,
      verifiedFare: serverFare,
      verifiedKm: Number(verifiedKm.toFixed(1))
    });
  } catch (err) {
    console.error('Error in /api/book:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

function cleanStr(val, maxLen) {
  return String(val || '').replace(/[\r\n<>]/g, ' ').trim().slice(0, maxLen);
}

function cleanPhone(phone) {
  return String(phone || '').replace(/[\s\-+]/g, '').replace(/^91/, '');
}

function isValidIndianPhone(phone) {
  return /^[6-9]\d{9}$/.test(phone);
}

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
