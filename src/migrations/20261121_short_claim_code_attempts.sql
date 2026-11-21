-- Track failed short-code attempts for the legacy activation endpoint.
ALTER TABLE device_claim_tokens
  ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0;
