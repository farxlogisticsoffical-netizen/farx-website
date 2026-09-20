export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { amount, currency = 'INR', receipt } = req.body;

    // Validate amount: must be a real, positive, reasonably-sized number.
    // This alone does NOT stop someone from sending a low-but-plausible
    // number — the real protection is in verify-payment.js, which now
    // trusts only the amount Razorpay actually confirms was paid.
    const numericAmount = Number(amount);
    const MAX_FARE_RUPEES = 20000; // sanity ceiling — adjust to your real max
    if (!amount || !Number.isFinite(numericAmount) || numericAmount <= 0 || numericAmount > MAX_FARE_RUPEES) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      return res.status(500).json({ error: 'Razorpay keys not configured' });
    }

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        amount: Math.round(numericAmount * 100),
        currency,
        receipt: receipt || `rec_${Date.now()}`,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.description || 'Razorpay order creation failed' });
    }

    // Send the key_id back so the frontend never needs its own copy of it.
    return res.status(200).json({ ...data, keyId });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
}
