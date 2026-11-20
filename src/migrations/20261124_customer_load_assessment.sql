-- PAYGO customer load assessment and source capacity allocation.
-- This migration is additive: existing sources, meters, purchases and balances remain intact.

ALTER TABLE energy_sources
  ADD COLUMN IF NOT EXISTS max_capacity_w NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS max_capacity_va NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS max_surge_va NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS safety_margin_pct NUMERIC(5,2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'energy_sources_capacity_positive') THEN
    ALTER TABLE energy_sources ADD CONSTRAINT energy_sources_capacity_positive
      CHECK (
        (max_capacity_w IS NULL OR max_capacity_w > 0) AND
        (max_capacity_va IS NULL OR max_capacity_va > 0) AND
        (max_surge_va IS NULL OR max_surge_va > 0) AND
        (safety_margin_pct IS NULL OR (safety_margin_pct >= 0 AND safety_margin_pct <= 100))
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS appliance_catalogue (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE,
  category VARCHAR(60) NOT NULL,
  rated_power_w NUMERIC(10,2) NOT NULL CHECK (rated_power_w > 0),
  power_factor NUMERIC(4,3) NOT NULL DEFAULT 1 CHECK (power_factor > 0 AND power_factor <= 1),
  starting_surge_multiplier NUMERIC(6,2) NOT NULL DEFAULT 1 CHECK (starting_surge_multiplier >= 1),
  is_estimate BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO appliance_catalogue (name, category, rated_power_w, power_factor, starting_surge_multiplier)
VALUES
  ('LED bulb', 'Lighting', 10, 0.90, 1.0),
  ('Ceiling fan', 'Cooling', 75, 0.80, 1.5),
  ('Television', 'Electronics', 100, 0.90, 1.0),
  ('Laptop', 'Electronics', 65, 0.90, 1.0),
  ('Phone charger', 'Electronics', 15, 0.90, 1.0),
  ('Refrigerator', 'Cooling', 200, 0.80, 3.0),
  ('Electric iron', 'Heating', 1000, 1.00, 1.0),
  ('Water pump', 'Motor', 750, 0.80, 3.0),
  ('Microwave oven', 'Kitchen', 1200, 0.90, 1.2),
  ('1 HP air conditioner', 'Cooling', 1000, 0.85, 3.0)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS customer_connections (
  id BIGSERIAL PRIMARY KEY,
  source_id INT NOT NULL REFERENCES energy_sources(id) ON DELETE RESTRICT,
  customer_id INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  receiving_device_id VARCHAR(50) REFERENCES devices(device_id) ON DELETE RESTRICT,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'PENDING_REVISION', 'REJECTED', 'CANCELLED')),
  requested_power_w NUMERIC(12,2) NOT NULL CHECK (requested_power_w > 0),
  requested_apparent_va NUMERIC(12,2) NOT NULL CHECK (requested_apparent_va > 0),
  requested_starting_surge_va NUMERIC(12,2) NOT NULL CHECK (requested_starting_surge_va > 0),
  approved_power_w NUMERIC(12,2),
  approved_apparent_va NUMERIC(12,2),
  approved_starting_surge_va NUMERIC(12,2),
  safety_margin_pct NUMERIC(5,2) NOT NULL CHECK (safety_margin_pct >= 0 AND safety_margin_pct <= 100),
  decision_note TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (approved_power_w IS NULL AND approved_apparent_va IS NULL AND approved_starting_surge_va IS NULL)
    OR
    (approved_power_w IS NOT NULL AND approved_power_w > 0
     AND approved_apparent_va IS NOT NULL AND approved_apparent_va > 0
     AND approved_starting_surge_va IS NOT NULL AND approved_starting_surge_va > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_connection_device_active
  ON customer_connections(receiving_device_id)
  WHERE receiving_device_id IS NOT NULL
    AND status IN ('APPROVED', 'PENDING_REVISION');

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_connection_customer_source_active
  ON customer_connections(source_id, customer_id)
  WHERE status IN ('PENDING', 'APPROVED', 'PENDING_REVISION');

CREATE INDEX IF NOT EXISTS idx_customer_connections_source_status
  ON customer_connections(source_id, status);

CREATE INDEX IF NOT EXISTS idx_customer_connections_customer
  ON customer_connections(customer_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS customer_connection_appliances (
  id BIGSERIAL PRIMARY KEY,
  connection_id BIGINT NOT NULL REFERENCES customer_connections(id) ON DELETE CASCADE,
  appliance_id BIGINT NOT NULL REFERENCES appliance_catalogue(id) ON DELETE RESTRICT,
  quantity INT NOT NULL CHECK (quantity > 0),
  simultaneous_quantity INT NOT NULL CHECK (simultaneous_quantity > 0 AND simultaneous_quantity <= quantity),
  rated_power_override_w NUMERIC(10,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (rated_power_override_w IS NULL OR rated_power_override_w > 0),
  UNIQUE(connection_id, appliance_id)
);

CREATE INDEX IF NOT EXISTS idx_connection_appliances_connection
  ON customer_connection_appliances(connection_id);

-- No customer connection or device is auto-created for legacy DEVICE-001 data.
