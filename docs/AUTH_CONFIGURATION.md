# PAYGO authentication configuration

Configure these variables before deploying the authentication changes.

## Backend (Render)

- `GOOGLE_CLIENT_ID`: OAuth 2.0 Web application client ID from Google Cloud.
- `RESEND_API_KEY`: API key from Resend.
- `EMAIL_FROM`: verified sender, for example `PAYGO <no-reply@your-verified-domain.com>`.
- `APP_BASE_URL`: public frontend origin, for example `https://your-paygo-frontend.vercel.app`.
- `DATABASE_URL`: existing PostgreSQL connection string.
- `JWT_SECRET`: a long, randomly generated secret. Do not use the development fallback in production.

## Frontend (Vercel)

- `NEXT_PUBLIC_GOOGLE_CLIENT_ID`: use the exact same Google OAuth Web client ID as the backend's `GOOGLE_CLIENT_ID`.

In Google Cloud Console, configure the OAuth consent screen and add the deployed frontend hostname under **Authorized JavaScript origins**. The Google client ID must be a Web application client ID and must match on both services.

In Resend, verify the sending domain before using it in `EMAIL_FROM`. The verification email link is built from `APP_BASE_URL` and opens the frontend route `/verify-email`.

## Behaviour after deployment

- Email/password registration creates a pending account and sends a one-time verification link (30-minute expiry).
- Password sign-in is blocked until the email is verified.
- Google sign-in verifies Google's ID token and verified-email claim. A first-time Google user is created automatically using the selected account type; no separate registration form is required.
- Google OAuth sign-in itself verifies the Gmail address, so it does not send a second verification email.

The database migration `20261120_email_verification.sql` is applied by backend startup. Do not manually edit production tables to add these columns if the migration has already run.
