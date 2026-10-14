// api/track.js
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawOrderNumber = String(req.query.orderNumber || '').trim().toUpperCase();

  if (!/^[A-Z0-9\-]{4,24}$/.test(rawOrderNumber)) {
    return res.status(400).json({ error: 'Invalid order number format' });
  }

  const shipdayApiKey = process.env.SHIPDAY_API_KEY;
  if (!shipdayApiKey) {
    return res.status(500).json({ error: 'Tracking service not configured' });
  }

  try {
    const response = await fetch(`https://api.shipday.com/orders/${encodeURIComponent(rawOrderNumber)}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Basic ${shipdayApiKey}`
      }
    });

    if (!response.ok) {
      return res.status(404).json({ error: 'Order not found yet' });
    }

    const orders = await response.json();
    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orders[0];
    return res.status(200).json({
      orderNumber: order.orderNumber,
      orderState: order.orderStatus?.orderState || 'Scheduled for Dispatch',
      trackingLink: order.trackingLink || null
    });
  } catch (err) {
    console.error('Error in /api/track:', err);
    return res.status(500).json({ error: 'Unable to fetch tracking details' });
  }
};
