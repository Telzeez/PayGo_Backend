# PAYGO authentication configuration

Configure these variables before deploying the authentication changes.

## Backend (Render)

- `GOOGLE_CLIENT_ID`: OAuth 2.0 Web application client ID used for Google sign-in (if enabled).
- `GMAIL_OAUTH_CLIENT_ID`: OAuth 2.0 client ID authorized to send mail through the Gmail API.
- `GMAIL_OAUTH_CLIENT_SECRET`: matching OAuth client secret.
- `GMAIL_OAUTH_REFRESH_TOKEN`: offline refresh token authorized for the `https://www.googleapis.com/auth/gmail.send` scope.
- `GMAIL_SENDER_EMAIL`: the Gmail address that authorized the Gmail API and will send PAYGO messages.
- `APP_BASE_URL`: public frontend origin, currently `https://pay-go-frontend.vercel.app`.
- `DATABASE_URL`: existing PostgreSQL connection string.
- `JWT_SECRET`: a long, randomly generated secret. Do not use the development fallback in production.

Do not put Gmail OAuth secrets or the refresh token in Vercel or frontend code. Store them only as Render environment variables.

## Create Gmail API credentials

1. Open Google Cloud Console and select or create a project.
2. Enable **Gmail API** for that project.
3. Configure the OAuth consent screen. Add the Gmail account that will send PAYGO emails as a test user while the app is in Testing.
4. Create an OAuth 2.0 Client ID with application type **Web application**.
5. Add `https://developers.google.com/oauthplayground` as an authorized redirect URI for that OAuth client.
6. Open Google OAuth 2.0 Playground: `https://developers.google.com/oauthplayground`.
7. Open its settings (gear icon), enable **Use your own OAuth credentials**, and enter the OAuth client ID and secret.
8. In Step 1, enter the scope `https://www.googleapis.com/auth/gmail.send`, authorize the Gmail account that PAYGO will send from, and grant access.
9. In Step 2, exchange the authorization code. Copy the **refresh token** from the response.
10. Add the four `GMAIL_*` values to Render. Keep the refresh token private.

Google's OAuth consent-screen **Testing** status can cause refresh tokens to expire after seven days for external apps. This is suitable for an initial test, but not a set-and-forget production configuration. For ongoing use, review Google's publishing and sensitive-scope verification requirements for the Gmail send scope.

## Frontend (Vercel)

- `NEXT_PUBLIC_GOOGLE_CLIENT_ID`: use the exact same Google OAuth Web client ID as the backend's `GOOGLE_CLIENT_ID` for Google sign-in.

In Google Cloud Console, configure the OAuth consent screen and add the deployed frontend hostname under **Authorized JavaScript origins** for the Google sign-in client.

## Behaviour after deployment

- Email/password registration creates a pending account and sends a one-time verification link (30-minute expiry) through Gmail API.
- Password sign-in is blocked until the email is verified.
- Verification links are single-use; successful verification marks the account verified and issues a normal PAYGO session.
- Resend verification uses the same Gmail API sender and has a 60-second cooldown.
- Meter activation-code emails also use the same Gmail API sender.
- Google sign-in verifies Google's ID token and verified-email claim. A first-time Google user is created automatically; Google-verified email addresses do not receive a second verification email.

The Gmail API send endpoint is called over HTTPS. No SMTP connection or custom sending domain is required. The database migration `20261120_email_verification.sql` is applied by backend startup; do not manually edit production tables to add these columns if the migration has already run.
