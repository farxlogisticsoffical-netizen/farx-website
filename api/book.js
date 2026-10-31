// /api/book
// Cash-on-delivery booking is switched off.
//
// This endpoint used to create rider orders WITHOUT any payment. The website now
// books only through /api/create-payment and /api/verify-payment.
// (Kept as a small file so old links return a clear message instead of an error.)

export default function handler(req, res) {
  res.setHeader('Allow', 'POST');
  return res.status(410).json({
    error: 'Cash on delivery booking is not available. Please book online, or WhatsApp us.',
  });
}
