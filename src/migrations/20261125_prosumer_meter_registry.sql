-- Secure, self-service meter claiming and prosumer-managed receiving-meter assignment.
-- Device IDs must be pre-registered in devices and paired with a one-time claim token
-- by the trusted hardware provisioning process. Never accept an unverified device ID.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS firmware_version VARCHAR(40),
  ADD COLUMN IF NOT EXISTS hardware_revision VARCHAR(40);

CREATE TABLE IF NOT EXISTS device_claim_tokens (
  id BIGSERIAL PRIMARY KEY,
  device_id VARCHAR(50) NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_device_claim_tokens_device
  ON device_claim_tokens(device_id, expires_at)
  WHERE claimed_at IS NULL;

