export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const apiKey = process.env.SHIPDAY_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Shipday API key is missing in Vercel Environment Variables.' });
    }

    const orderData = req.body;

    const response = await fetch('https://api.shipday.com/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `basic ${apiKey.trim()}`,
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
        error: data.message || data.raw || 'Shipday order dispatch failed' 
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
