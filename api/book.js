export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const rawKey = process.env.SHIPDAY_API_KEY;
    if (!rawKey) {
      return res.status(500).json({ error: 'Shipday API key is missing in Vercel Environment Variables.' });
    }

    const apiKey = rawKey.trim();
    const orderData = req.body;

    // Basic input validation: reject requests missing the fields we
    // actually need, instead of forwarding garbage straight to Shipday.
    const requiredFields = [
      'orderNumber',
      'customerName',
      'customerAddress',
      'customerPhoneNumber',
      'restaurantAddress',
      'restaurantPhoneNumber',
      'totalOrderCost',
    ];
    const missing = requiredFields.filter((f) => !orderData || !orderData[f]);
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
      // Don't echo Shipday's raw response text back to the caller —
      // it can contain internal details we don't want exposed publicly.
      return res.status(response.status).json({
        error: 'Could not create the delivery order. Please try again or contact support.',
      });
    }

    return res.status(200).json(data || {});
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
}
