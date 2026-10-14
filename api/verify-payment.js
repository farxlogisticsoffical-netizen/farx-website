// api/verify-payment.js
const crypto = require('crypto');
const processedOrders = new Set();

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      booking
    } = req.body || {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !booking) {
      return res.status(400).json({ error: 'Missing payment verification details.' });
    }

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const shipdayApiKey = process.env.SHIPDAY_API_KEY;

    if (!keyId || !keySecret || !shipdayApiKey) {
      return res.status(500).json({ error: 'Server credentials not configured.' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    const sigBuffer = Buffer.from(String(razorpay_signature), 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

    if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      return res.status(400).json({ error: 'Invalid payment signature.' });
    }

    const orderSuffix = String(razorpay_order_id).replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase();
    const orderNumber = `FX-ONL-${orderSuffix}`;

    if (processedOrders.has(orderNumber)) {
      return res.status(200).json({ success: true, orderNumber, verifiedFare: booking.estimatedFare || '' });
    }

    const authHeader = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const orderCheckRes = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(razorpay_order_id)}`, {
      method: 'GET',
      headers: { 'Authorization': `Basic ${authHeader}` }
    });

    if (!orderCheckRes.ok) {
      return res.status(502).json({ error: 'Could not verify order with payment gateway.' });
    }

    const rzpOrderData = await orderCheckRes.json();
    const paidAmountInr = Math.round((rzpOrderData.amount || 0) / 100);
    const notes = rzpOrderData.notes || {};
    const lockedFareInr = parseInt(notes.verifiedFareInr, 10) || paidAmountInr;
    const lockedKm = notes.verifiedKm || '0';
    const lockedWeightKg = notes.weightKg || '0';
    const lockedPickupCoord = notes.pickupCoord || '';
    const lockedDropCoord = notes.dropCoord || '';

    if (paidAmountInr < lockedFareInr || paidAmountInr < 50) {
      return res.status(400).json({ error: 'Paid amount does not match verified route fare.' });
    }

    const existingCheck = await fetch(`https://api.shipday.com/orders/${encodeURIComponent(orderNumber)}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'Authorization': `Basic ${shipdayApiKey}` }
    });
    if (existingCheck.ok) {
      const existingArr = await existingCheck.json();
      if (Array.isArray(existingArr) && existingArr.length > 0) {
        processedOrders.add(orderNumber);
        return res.status(200).json({ success: true, orderNumber, verifiedFare: paidAmountInr });
      }
    }

    const senderName = cleanStr(booking.senderName, 80);
    const receiverName = cleanStr(booking.receiverName, 80);
    const pickupAddress = cleanStr(booking.pickupAddress, 250);
    const dropAddress = cleanStr(booking.dropAddress, 250);
    const senderEmail = cleanStr(booking.senderEmail, 100);
    const senderPhone = cleanPhone(booking.senderPhone);
    const receiverPhone = cleanPhone(booking.receiverPhone);

    const pickupGpsUrl = lockedPickupCoord ? `https://maps.google.com/?q=${lockedPickupCoord}` : '';
    const dropGpsUrl = lockedDropCoord ? `https://maps.google.com/?q=${lockedDropCoord}` : '';

    const shipdayPayload = {
      orderNumber,
      customerName: receiverName,
      customerAddress: dropAddress,
      customerPhoneNumber: receiverPhone,
      customerEmail: senderEmail,
      restaurantName: `${senderName} (Pickup)`,
      restaurantAddress: pickupAddress,
      restaurantPhoneNumber: senderPhone,
      totalOrderCost: paidAmountInr,
      deliveryFee: paidAmountInr,
      paymentMethod: 'credit_card',
      deliveryInstruction: `PREPAID (DO NOT COLLECT CASH) — Paid ₹${paidAmountInr} [PayID: ${razorpay_payment_id}] | Verified Distance: ${lockedKm} km | Weight: ${lockedWeightKg} kg | Pickup Pin: ${pickupGpsUrl} | Drop Pin: ${dropGpsUrl}`,
      orderItem: [
        {
          name: `Prepaid Intra-District Courier (${lockedWeightKg} kg, ${lockedKm} km) - Paid ₹${paidAmountInr} [${razorpay_payment_id}]`,
          unitPrice: paidAmountInr,
          quantity: 1
        }
      ]
    };

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
      console.error('Shipday dispatch error after payment:', errText);
      return res.status(502).json({ error: 'Payment verified, but dispatch registration failed.' });
    }

    processedOrders.add(orderNumber);

    return res.status(200).json({
      success: true,
      orderNumber,
      verifiedFare: paidAmountInr
    });
  } catch (err) {
    console.error('Error in /api/verify-payment:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

function cleanStr(val, maxLen) {
  return String(val || '').replace(/[\r\n<>]/g, ' ').trim().slice(0, maxLen);
}

function cleanPhone(phone) {
  return String(phone || '').replace(/[\s\-+]/g, '').replace(/^91/, '').slice(0, 12);
}
