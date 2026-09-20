import crypto from 'crypto';

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

  // Not a bot-facing form submission (it only fires after a real Razorpay
  // checkout completes), so no honeypot here — but still rate limited,
  // since a stolen/replayed signature attempt could still hammer this.
  const rl = await checkRateLimit(req, 'verify-payment', 15, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: 'Too many requests. Please wait a moment and try again.' });
  }

  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, booking } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Missing parameters' });
    }

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      return res.status(500).json({ success: false, error: 'Razorpay keys not configured' });
    }

    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(body.toString())
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    // Trust only what Razorpay confirms was actually paid — not any
    // client-supplied fare — when booking the delivery.
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const orderRes = await fetch(`https://api.razorpay.com/v1/orders/${razorpay_order_id}`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!orderRes.ok) {
      return res.status(502).json({ success: false, error: 'Could not confirm payment with Razorpay' });
    }
    const orderInfo = await orderRes.json();
    const confirmedFareRupees = orderInfo.amount / 100;

    const orderNumber = 'FX-ONL-' + Math.floor(100000 + Math.random() * 900000);

    if (booking && process.env.SHIPDAY_API_KEY) {
      const requiredFields = ['receiverName', 'dropAddress', 'receiverPhone', 'pickupAddress', 'senderName', 'senderPhone'];
      const missing = requiredFields.filter((f) => !booking[f]);
      if (missing.length) {
        return res.status(400).json({ success: false, error: `Missing booking field(s): ${missing.join(', ')}` });
      }

      const shipdayPayload = {
        orderNumber: orderNumber,
        customerName: booking.receiverName,
        customerAddress: booking.dropAddress,
        customerPhoneNumber: booking.receiverPhone,
        customerEmail: booking.senderEmail || '',
        restaurantName: booking.senderName + ' (Pickup)',
        restaurantAddress: booking.pickupAddress,
        restaurantPhoneNumber: booking.senderPhone,
        totalOrderCost: confirmedFareRupees,
        deliveryFee: confirmedFareRupees,
        paymentMethod: 'credit_card',
        orderItem: [
          {
            name: `Courier Freight (${booking.weightKg || 4} kg) - Paid Prepaid (${razorpay_payment_id})`,
            unitPrice: confirmedFareRupees,
            quantity: 1,
          },
        ],
      };

      await fetch('https://api.shipday.com/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${process.env.SHIPDAY_API_KEY.trim()}`,
        },
        body: JSON.stringify(shipdayPayload),
      });
    }

    return res.status(200).json({
      success: true,
      orderNumber: orderNumber,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}
