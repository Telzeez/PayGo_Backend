# PAYGO authentication configuration

Configure these variables before deploying the authentication changes.

## Backend (Render)

- `GOOGLE_CLIENT_ID`: OAuth 2.0 Web application client ID used for Google sign-in (if enabled).
- `GMAIL_OAUTH_CLIENT_ID`: OAuth 2.0 client ID authorized to send mail through the Gmail API.
- `GMAIL_OAUTH_CLIENT_SECRET`: matching OAuth client secret.
- `GMAIL_OAUTH_REFRESH_TOKEN`: offline refresh token authorized for the `https://www.googleapis.com/auth/gmail.send` scope.
- `GMAIL_SENDER_EMAIL`: the Gmail address that authorized the Gmail API and will send PAYGO messages.
- `APP_BASE_URL`: public frontend origin, currently `https://pay-go-frontend.vercel.app`.
- `FRONTEND_URL`: optional explicit frontend origin for payment callbacks; if omitted, `APP_BASE_URL` is used.
- `ALLOWED_ORIGINS`: optional comma-separated list of additional exact browser origins (for example, temporary Vercel preview origins).
- `DATABASE_URL`: existing PostgreSQL connection string.
- `JWT_SECRET`: a long, randomly generated secret. Do not use the development fallback in production.

Do not put Gmail OAuth secrets or the refresh token in Vercel or frontend code. Store them only as Render environment variables.

## Create Gmail API credentials

PAYGO uses one Gmail account as its sender. Only that sender account needs to authorize the application; recipients can use Gmail, Yahoo, Outlook, or another valid email provider.

1. Open Google Cloud Console and create a **new project using Personal mode**: [Google Auth Platform setup](https://console.cloud.google.com/auth/overview).
2. Personal mode is intended for an app used only by its creator's Google account. That account will be the PAYGO sender. Google says Personal mode does not require OAuth app verification and is not subject to the seven-day test-token expiration. It is a one-time project choice and cannot later be changed to External or Internal.
3. Enable **Gmail API** for the project.
4. Create an OAuth 2.0 client ID. Use a Web application client if prompted.
5. Add `https://developers.google.com/oauthplayground` as an authorized redirect URI for that client.
6. Open [Google OAuth 2.0 Playground](https://developers.google.com/oauthplayground).
7. Open its settings (gear icon), enable **Use your own OAuth credentials**, and enter this project's OAuth client ID and secret.
8. In Step 1, enter the scope `https://www.googleapis.com/auth/gmail.send`, authorize using the Gmail account that will send PAYGO emails, and grant access.
9. In Step 2, exchange the authorization code. Copy the **refresh token** from the response.
10. Add the four `GMAIL_*` values to Render. Keep the refresh token private.

If Personal mode is unavailable and you instead use an External project in Testing status, Google expires authorizations and refresh tokens after seven days for scopes such as `gmail.send`; you would need to re-authorize periodically. The Gmail send scope is sensitive. Review Google's [scope classification](https://developers.google.com/workspace/gmail/api/auth/scopes) and [OAuth verification guidance](https://support.google.com/cloud/answer/13463073) before making the integration broadly available.

## Frontend (Vercel)

- `NEXT_PUBLIC_GOOGLE_CLIENT_ID`: use the exact same Google OAuth Web client ID as the backend's `GOOGLE_CLIENT_ID` for Google sign-in.

In Google Cloud Console, configure the OAuth consent screen and add the deployed frontend hostname under **Authorized JavaScript origins** for the Google sign-in client. Gmail API credentials are separate and must never be exposed to the frontend.

## Behaviour after deployment

- Email/password registration creates a pending account and sends a one-time verification link (30-minute expiry) through Gmail API.
- Password sign-in is blocked until the email is verified.
- Verification links are single-use; successful verification marks the account verified and issues a normal PAYGO session.
- Resend verification uses the same Gmail API sender and has a 60-second cooldown.
- Meter activation-code emails also use the same Gmail API sender.
- Google sign-in verifies Google's ID token and verified-email claim. A first-time Google user is created automatically; Google-verified email addresses do not receive a second verification email.

The Gmail API send endpoint is called over HTTPS. No SMTP connection or custom sending domain is required. The database migration `20261120_email_verification.sql` is applied by backend startup; do not manually edit production tables to add these columns if the migration has already run.


## Device API authentication and administrator access

- The administrator dashboard requires a PAYGO user whose database role is exactly `ADMIN`. Public registration and capability activation must never grant this role. Grant it only through a trusted database administration process.
- Device status, balance and token inspection endpoints require an authenticated administrator.
- ESP32 heartbeat, balance update, ACK, energy report and token redemption endpoints require a unique per-device `X-Device-API-Key` header.
- Generate or rotate a device key from the administrator dashboard. The raw key is displayed once; the backend stores only its SHA-256 hash.
- Put the key in that meter's local, ignored `src/DeviceConfig.h` as `PAYGO_DEVICE_API_KEY`, then reflash the ESP32. Never commit the local config or reuse a key across meters.
- Rotating a key immediately invalidates the old key. Reflash the meter with the new key before expecting its HTTPS heartbeat to work again.
- Deploy the backend and matching firmware together. Older firmware without the header will receive HTTP 401 responses.
