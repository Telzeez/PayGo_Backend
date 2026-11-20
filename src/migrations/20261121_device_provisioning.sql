-- PAYGO controlled meter provisioning and one-time owner activation
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS assignment_status VARCHAR(20) NOT NULL DEFAULT 'UNASSIGNED'
    CHECK (assignment_status IN ('UNASSIGNED', 'ASSIGNED', 'ACTIVATED', 'SUSPENDED')),
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

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

-- A physical generation meter can be linked to only one energy source.
CREATE UNIQUE INDEX IF NOT EXISTS uq_energy_sources_device_active
  ON energy_sources(device_id) WHERE status <> 'DECOMMISSIONED';
