export const sendMeterActivationEmail = async (email: string, deviceId: string, activationCode: string) => {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) throw new Error('Email delivery is not configured. Set RESEND_API_KEY and EMAIL_FROM.');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [email],
      subject: 'Your PAYGO meter activation code',
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#18181b"><h2>Activate your PAYGO meter</h2><p>Your PAYGO meter has been assigned to your account.</p><p><strong>Meter ID:</strong> ${deviceId}</p><p><strong>One-time activation code:</strong></p><p style="font-size:24px;font-weight:bold;letter-spacing:5px;background:#f4f4f5;padding:16px;border-radius:8px">${activationCode}</p><p>Enter this code in your PAYGO account. It expires in 72 hours and can only be used once. Do not share it with anyone.</p></div>`
    })
  });
  if (!response.ok) throw new Error(`Activation email delivery failed: ${response.status}`);
};
