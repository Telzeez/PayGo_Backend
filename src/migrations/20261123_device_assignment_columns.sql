-- Keep device assignment fields available even if the separate
-- energy-source uniqueness constraint needs legacy data cleanup.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS assignment_status VARCHAR(20) NOT NULL DEFAULT 'UNASSIGNED'
    CHECK (assignment_status IN ('UNASSIGNED', 'ASSIGNED', 'ACTIVATED', 'SUSPENDED')),
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS meter_purpose VARCHAR(20) NOT NULL DEFAULT 'GENERATION'
    CHECK (meter_purpose IN ('GENERATION', 'RECEIVING'));

CREATE TABLE IF NOT EXISTS device_activation_codes (
  id BIGSERIAL PRIMARY KEY,
  device_id VARCHAR(50) NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  owner_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  failed_attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_device_activation_owner
  ON device_activation_codes(owner_id, device_id);
CREATE INDEX IF NOT EXISTS idx_device_activation_expiry
  ON device_activation_codes(expires_at);
