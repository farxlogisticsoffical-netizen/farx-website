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

    // Payment signature is valid! Generate an order ID
    const orderNumber = 'FX-ONL-' + Math.floor(100000 + Math.random() * 900000);

    // Push the order directly to Shipday if booking details are provided
    if (booking && process.env.SHIPDAY_API_KEY) {
      try {
        const shipdayPayload = {
          orderNumber: orderNumber,
          customerName: booking.receiverName,
          customerAddress: booking.dropAddress,
          customerPhoneNumber: booking.receiverPhone,
          customerEmail: booking.senderEmail || '',
          restaurantName: booking.senderName + ' (Pickup)',
          restaurantAddress: booking.pickupAddress,
          restaurantPhoneNumber: booking.senderPhone,
          totalOrderCost: booking.estimatedFare,
          deliveryFee: booking.estimatedFare,
          paymentMethod: 'credit_card',
          orderItem: [
            {
              name: `Prepaid Courier (${booking.weightKg || 4} kg) - Paid via Razorpay (${razorpay_payment_id})`,
              unitPrice: booking.estimatedFare,
              quantity: 1
            }
          ]
        };

        await fetch('https://api.shipday.com/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `basic ${process.env.SHIPDAY_API_KEY}`
          },
          body: JSON.stringify(shipdayPayload)
        });
      } catch (shipErr) {
        console.error('Shipday forward failed:', shipErr);
      }
    }

    // Return success: true and orderNumber so the frontend confirms the booking!
    return res.status(200).json({
      success: true,
      orderNumber: orderNumber,
      paymentId: razorpay_payment_id
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message || 'Verification error' });
  }
}
