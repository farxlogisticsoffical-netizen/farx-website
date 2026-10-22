import crypto from 'crypto';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { phone } = req.body || {};
    const cleaned = String(phone || '').replace(/\D/g, '').slice(-10);

    // Block invalid Indian mobile numbers and repeating fake digits
    if (!/^[6-9]\d{9}$/.test(cleaned) || /(\d)\1{5,}/.test(cleaned)) {
        return res.status(400).json({ error: 'Please enter a valid 10-digit Indian mobile number.' });
    }

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const expires = Date.now() + 5 * 60 * 1000; // Valid for 5 minutes
    const secret = process.env.OTP_SECRET || process.env.RAZORPAY_KEY_SECRET || 'farx-default-secret-2026';

    // Create a stateless cryptographic signature so Vercel doesn't need a database
    const dataToSign = `${cleaned}.${otp}.${expires}`;
    const signature = crypto.createHmac('sha256', secret).update(dataToSign).digest('hex');
    const otpToken = `${expires}.${signature}`;

    try {
        // OPTION 1: 2Factor.in SMS Gateway
        if (process.env.TWOFACTOR_API_KEY) {
            const tfUrl = `https://2factor.in/API/V1/${process.env.TWOFACTOR_API_KEY}/SMS/+91${cleaned}/${otp}/OTP1`;
            const tfRes = await fetch(tfUrl);
            const tfData = await tfRes.json();
            if (tfData.Status !== 'Success') {
                throw new Error(tfData.Details || '2Factor SMS delivery failed');
            }
            return res.status(200).json({ success: true, otpToken });
        }

        // OPTION 2: Fast2SMS Gateway
        if (process.env.FAST2SMS_API_KEY) {
            const f2sRes = await fetch('https://www.fast2sms.com/dev/bulkV2', {
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
            const f2sData = await f2sRes.json();
            if (!f2sData.return) {
                throw new Error(f2sData.message || 'Fast2SMS delivery failed');
            }
            return res.status(200).json({ success: true, otpToken });
        }

        return res.status(500).json({
            error: 'SMS Gateway not connected in Vercel yet. Please choose Pay Online (Prepaid) to book immediately.'
        });
    } catch (err) {
        console.error('OTP Error:', err);
        return res.status(500).json({ error: 'Failed to send SMS OTP. Please try again.' });
    }
}
