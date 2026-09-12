import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, booking } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Missing verification parameters' });
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return res.status(500).json({ success: false, error: 'Razorpay secret not configured' });
    }

    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(body.toString())
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    // Payment signature confirmed
    const orderNumber = 'FX-ONL-' + Math.floor(100000 + Math.random() * 900000);

    // Calculate Next-Day Delivery Date (YYYY-MM-DD)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const expectedDate = tomorrow.toISOString().split('T')[0];

    // Push order to Shipday
    if (booking && process.env.SHIPDAY_API_KEY) {
      const apiKey = process.env.SHIPDAY_API_KEY.trim();
      
      const shipdayPayload = {
        orderNumber: orderNumber,
        customerName: booking.receiverName || 'Recipient',
        customerAddress: booking.dropAddress || 'Address Not Provided',
        customerPhoneNumber: booking.receiverPhone || '',
        customerEmail: booking.senderEmail || '',
        restaurantName: (booking.senderName || 'Sender') + ' (Pickup)',
        restaurantAddress: booking.pickupAddress || 'Address Not Provided',
        restaurantPhoneNumber: booking.senderPhone || '',
        expectedDeliveryDate: expectedDate,
        expectedDeliveryTime: '18:00:00',
        totalOrderCost: Number(booking.estimatedFare) || 0,
        deliveryFee: Number(booking.estimatedFare) || 0,
        paymentMethod: 'credit_card',
        orderItem: [
          {
            name: `Courier Freight (${booking.weightKg || 4} kg) - Paid via Razorpay (${razorpay_payment_id})`,
            unitPrice: Number(booking.estimatedFare) || 0,
            quantity: 1
          }
        ]
      };

      try {
        const shipResponse = await fetch('https://api.shipday.com/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${apiKey}`
          },
          body: JSON.stringify(shipdayPayload)
        });

        const shipData = await shipResponse.json();
        console.log('Shipday response status:', shipResponse.status, shipData);

        if (!shipResponse.ok) {
          console.error('Shipday rejection:', shipData);
        }
      } catch (shipErr) {
        console.error('Shipday request network error:', shipErr);
      }
    }

    return res.status(200).json({
      success: true,
      orderNumber: orderNumber,
      paymentId: razorpay_payment_id
    });

  } catch (err) {
    console.error('Verification handler crashed:', err);
    return res.status(500).json({ success: false, error: err.message || 'Verification error' });
  }
}
