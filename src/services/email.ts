type EmailMessage = {
  to: string;
  subject: string;
  html: string;
};

const requiredEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Email delivery is not configured. Set ${name}.`);
  return value;
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]!);

const getGmailAccessToken = async (): Promise<string> => {
  const clientId = requiredEnv('GMAIL_OAUTH_CLIENT_ID');
  const clientSecret = requiredEnv('GMAIL_OAUTH_CLIENT_SECRET');
  const refreshToken = requiredEnv('GMAIL_OAUTH_REFRESH_TOKEN');

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const details = (await response.text()).slice(0, 300);
    throw new Error(`Gmail OAuth token refresh failed (${response.status}): ${details}`);
  }

  const payload = await response.json() as { access_token?: string };
  if (!payload.access_token) throw new Error('Google did not return a Gmail access token.');
  return payload.access_token;
};

const encodeSubject = (subject: string): string =>
  `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;

export const sendEmail = async ({ to, subject, html }: EmailMessage): Promise<void> => {
  const sender = requiredEnv('GMAIL_SENDER_EMAIL');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) {
    throw new Error('GMAIL_SENDER_EMAIL must be a valid Gmail address.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw new Error('Recipient email address is invalid.');
  }

  const accessToken = await getGmailAccessToken();
  const mimeMessage = [
    `From: PAYGO <${sender}>`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf8').toString('base64').replace(/.{1,76}/g, 'Buffer.from(html, 'utf8').toString('base64'),\r\n').trim(),
  ].join('\r\n');
  const raw = Buffer.from(mimeMessage, 'utf8').toString('base64url');

  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  if (!response.ok) {
    const details = (await response.text()).slice(0, 300);
    throw new Error(`Gmail email delivery failed (${response.status}): ${details}`);
  }
};

export const sendVerificationEmail = async (email: string, rawToken: string): Promise<void> => {
  const appUrl = (process.env.APP_BASE_URL || process.env.FRONTEND_URL || 'https://pay-go-frontend.vercel.app').replace(/\/+$/, '');
  const verifyUrl = `${appUrl}/verify-email?token=${encodeURIComponent(rawToken)}`;
  await sendEmail({
    to: email,
    subject: 'Verify your PAYGO email address',
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#18181b"><h2>Verify your PAYGO email</h2><p>Confirm this email address to activate your PAYGO account.</p><p><a href="${verifyUrl}" style="display:inline-block;padding:12px 20px;background:#f59e0b;color:#18181b;text-decoration:none;border-radius:8px;font-weight:bold">Verify email</a></p><p>This link expires in 30 minutes. If you did not create this account, ignore this message.</p></div>`,
  });
};

export const sendMeterActivationEmail = async (email: string, deviceId: string, activationCode: string): Promise<void> => {
  await sendEmail({
    to: email,
    subject: 'Your PAYGO meter activation code',
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#18181b"><h2>Activate your PAYGO meter</h2><p>Your PAYGO meter has been assigned to your account.</p><p><strong>Meter ID:</strong> ${escapeHtml(deviceId)}</p><p><strong>One-time activation code:</strong></p><p style="font-size:24px;font-weight:bold;letter-spacing:5px;background:#f4f4f5;padding:16px;border-radius:8px">${escapeHtml(activationCode)}</p><p>Enter this code in your PAYGO account. It expires in 72 hours and can only be used once. Do not share it with anyone.</p></div>`,
  });
};
