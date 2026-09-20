import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
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

    // The signature only proves the payment is genuine — it does NOT prove
    // the amount matches what the browser told us. Fetch the order back
    // from Razorpay directly and use THAT amount as the source of truth,
    // instead of trusting booking.estimatedFare from the client. This is
    // what stops someone from paying ₹1 and getting a full delivery booked.
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
      // Basic sanity check on the booking payload before we forward it.
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
        // Use the amount Razorpay actually confirmed, not the client-supplied figure.
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
