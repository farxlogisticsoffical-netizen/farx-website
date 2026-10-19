import crypto from 'crypto';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { phone } = req.body || {};
    const cleaned = String(phone || '').replace(/\D/g, '').slice(-10);

    if (!/^[6-9]\d{9}$/.test(cleaned)) {
        return res.status(400).json({ error: 'Invalid 10-digit Indian mobile number' });
    }

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const expires = Date.now() + 5 * 60 * 1000; // 5 minutes
    const secret = process.env.OTP_SECRET || process.env.RAZORPAY_KEY_SECRET || 'farx-otp-hmac-key';

    // Create a stateless signed token so verify-otp.js can verify without a database
    const dataToSign = `${cleaned}.${otp}.${expires}`;
    const signature = crypto.createHmac('sha256', secret).update(dataToSign).digest('hex');
    const otpToken = `${expires}.${signature}`;

    // Optional: If you add FAST2SMS_API_KEY in your environment variables, it sends a real SMS automatically
    if (process.env.FAST2SMS_API_KEY) {
        try {
            await fetch('https://www.fast2sms.com/dev/bulkV2', {
                method: 'POST',
                headers: {
                    'authorization': process.env.FAST2SMS_API_KEY,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    route: 'otp',
                    variables_values: otp,
                    numbers: cleaned
                })
            });
            return res.status(200).json({ success: true, otpToken });
        } catch (err) {
            console.error('SMS Gateway Error:', err);
        }
    }

    // If no paid SMS key is set yet, returns devOtp so the customer can still see and verify the 4-digit code on screen
    return res.status(200).json({
        success: true,
        otpToken,
        devOtp: otp
    });
}
