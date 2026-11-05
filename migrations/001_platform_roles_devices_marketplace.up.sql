BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS admin_mfa_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS admin_mfa_secret_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS admin_mfa_pending_secret_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS admin_mfa_pending_expires_at TIMESTAMPTZ;

UPDATE users u
SET is_seller = true,
    role = CASE WHEN u.role = 'OWNER' THEN 'USER' ELSE u.role END
WHERE u.role = 'OWNER'
  AND (
    u.is_seller = true
    OR EXISTS (SELECT 1 FROM energy_sources s WHERE s.owner_id = u.id)
    OR EXISTS (SELECT 1 FROM energy_listings l WHERE l.seller_id = u.id)
  );

-- OWNER was shared by sellers and platform operators. Do not silently grant
-- administrative privileges to any legacy account.
UPDATE users SET role = 'USER' WHERE role = 'OWNER';

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS registration_status VARCHAR(24) NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN IF NOT EXISTS pairing_code_hash BYTEA,
  ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ;

ALTER TABLE devices
  DROP CONSTRAINT IF EXISTS devices_registration_status_check;
ALTER TABLE devices
  ADD CONSTRAINT devices_registration_status_check
  CHECK (registration_status IN ('LEGACY', 'UNPAIRED', 'PAIRED', 'REVOKED'));

UPDATE devices
SET is_demo = true,
    registration_status = 'LEGACY',
    pairing_code_hash = NULL
WHERE device_id = 'DEVICE-001';

ALTER TABLE user_devices
  ADD COLUMN IF NOT EXISTS unlinked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS linked_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS link_method VARCHAR(24) NOT NULL DEFAULT 'LEGACY';

ALTER TABLE user_devices
  DROP CONSTRAINT IF EXISTS user_devices_device_id_key;
ALTER TABLE user_devices
  DROP CONSTRAINT IF EXISTS user_devices_user_id_device_id_key;
ALTER TABLE user_devices
  DROP INDEX IF EXISTS idx_user_devices_selected;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_devices_active_device
  ON user_devices(device_id) WHERE unlinked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_devices_active_user_device
  ON user_devices(user_id, device_id) WHERE unlinked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_devices_active_selected
  ON user_devices(user_id) WHERE is_selected = true AND unlinked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_devices_user_active
  ON user_devices(user_id, linked_at) WHERE unlinked_at IS NULL;

ALTER TABLE energy_sources
  ADD COLUMN IF NOT EXISTS meter_assignment_id INTEGER,
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

ALTER TABLE user_devices
  ADD CONSTRAINT user_devices_id_user_device_unique UNIQUE (id, user_id, device_id);

ALTER TABLE energy_sources
  ADD CONSTRAINT energy_sources_meter_assignment_owner_device_fk
  FOREIGN KEY (meter_assignment_id, owner_id, device_id)
  REFERENCES user_devices(id, user_id, device_id)
  NOT VALID;

ALTER TABLE energy_listings
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

UPDATE energy_sources
SET is_demo = true,
    archived_at = COALESCE(archived_at, NOW()),
    status = 'DECOMMISSIONED'
WHERE device_id = 'DEVICE-001'
   OR name IN ('Rooftop Solar Home A', 'Solar Microgrid B', 'Distant Solar Array C');

UPDATE energy_listings l
SET is_demo = true,
    archived_at = COALESCE(l.archived_at, NOW()),
    status = 'PAUSED'
FROM energy_sources s
WHERE l.energy_source_id = s.id
  AND (s.is_demo = true OR s.device_id = 'DEVICE-001');

UPDATE energy_sources s
SET meter_assignment_id = ud.id
FROM user_devices ud
WHERE s.meter_assignment_id IS NULL
  AND s.owner_id = ud.user_id
  AND s.device_id = ud.device_id
  AND ud.unlinked_at IS NULL
  AND s.is_demo = false;

ALTER TABLE marketplace_purchases
  ADD COLUMN IF NOT EXISTS buyer_assignment_id INTEGER;

ALTER TABLE marketplace_purchases
  ADD CONSTRAINT marketplace_purchases_buyer_meter_snapshot_fk
  FOREIGN KEY (buyer_assignment_id, buyer_id, device_id)
  REFERENCES user_devices(id, user_id, device_id)
  NOT VALID;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS marketplace_purchase_id INTEGER,
  ADD COLUMN IF NOT EXISTS operation_source VARCHAR(24) NOT NULL DEFAULT 'SYSTEM';

ALTER TABLE transactions
  ADD CONSTRAINT transactions_marketplace_purchase_fk
  FOREIGN KEY (marketplace_purchase_id)
  REFERENCES marketplace_purchases(id)
  ON DELETE RESTRICT
  NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_marketplace_purchase
  ON transactions(marketplace_purchase_id)
  WHERE marketplace_purchase_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS platform_admin_audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(80) NOT NULL,
  target_type VARCHAR(40) NOT NULL,
  target_id VARCHAR(120),
  reason TEXT NOT NULL,
  outcome VARCHAR(24) NOT NULL,
  before_state JSONB,
  after_state JSONB,
  request_id VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_admin_audit_actor_time
  ON platform_admin_audit_log(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_admin_audit_target_time
  ON platform_admin_audit_log(target_type, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS device_pairing_challenges (
  id BIGSERIAL PRIMARY KEY,
  device_id VARCHAR(50) NOT NULL REFERENCES devices(device_id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_hash BYTEA NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_device_pairing_challenges_device
  ON device_pairing_challenges(device_id, expires_at);

CREATE TABLE IF NOT EXISTS hardware_operations (
  id BIGSERIAL PRIMARY KEY,
  device_id VARCHAR(50) NOT NULL REFERENCES devices(device_id) ON DELETE RESTRICT,
  transaction_id VARCHAR(100),
  operation VARCHAR(40) NOT NULL,
  status VARCHAR(24) NOT NULL,
  requested_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  acknowledgement JSONB,
  server_balance_before NUMERIC(12,4),
  server_balance_after NUMERIC(12,4),
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_hardware_operations_device_time
  ON hardware_operations(device_id, requested_at DESC);

COMMIT;
