-- Link Firebase Authentication identities to existing PAYGO profiles.
-- Existing rows and business permissions are preserved.
ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid VARCHAR(128);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_firebase_uid
  ON users(firebase_uid)
  WHERE firebase_uid IS NOT NULL;
