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
      data = { raw: text };
    }

    if (!response.ok) {
      return res.status(response.status).json({ 
        error: data.message || data.raw || `Shipday rejected with status ${response.status}` 
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
