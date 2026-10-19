import crypto from 'crypto';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { phone, otp, otpToken } = req.body || {};
    const cleaned = String(phone || '').replace(/\D/g, '').slice(-10);

    if (!cleaned || !otp || !otpToken) {
        return res.status(400).json({ verified: false, error: 'Missing verification fields' });
    }

    const [expiresStr, providedSignature] = String(otpToken).split('.');
    const expires = parseInt(expiresStr, 10);

    if (!expires || Date.now() > expires) {
        return res.status(400).json({ verified: false, error: 'OTP has expired. Please request a new one.' });
    }

    const secret = process.env.OTP_SECRET || process.env.RAZORPAY_KEY_SECRET || 'farx-otp-hmac-key';
    const dataToSign = `${cleaned}.${String(otp).trim()}.${expires}`;
    const expectedSignature = crypto.createHmac('sha256', secret).update(dataToSign).digest('hex');

    if (providedSignature !== expectedSignature) {
        return res.status(400).json({ verified: false, error: 'Invalid OTP code' });
    }

    return res.status(200).json({ verified: true });
}
