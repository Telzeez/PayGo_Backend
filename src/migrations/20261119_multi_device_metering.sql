-- PAYGO multi-device ownership and non-financial meter readings.
-- Safe to run repeatedly; existing balances and financial top-ups are preserved.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS owner_id INT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_devices_owner_id ON devices(owner_id);

-- Associate existing meters with their current energy-source owner where the
-- device has one unambiguous owner. Ambiguous devices remain unassigned.
WITH unambiguous_owners AS (
  SELECT device_id, MIN(owner_id) AS owner_id
  FROM energy_sources
  GROUP BY device_id
  HAVING COUNT(DISTINCT owner_id) = 1
)
UPDATE devices d
SET owner_id = u.owner_id
FROM unambiguous_owners u
WHERE d.device_id = u.device_id
  AND d.owner_id IS NULL;

CREATE TABLE IF NOT EXISTS meter_readings (
  id BIGSERIAL PRIMARY KEY,
  device_id VARCHAR(50) NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  kwh_consumed DECIMAL(12,4) NOT NULL CHECK (kwh_consumed > 0),
  source VARCHAR(30) NOT NULL DEFAULT 'BALANCE_SYNC',
  recorded_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meter_readings_device_time
  ON meter_readings(device_id, recorded_at DESC);

-- Preserve historical consumption information by copying it into the
-- dedicated meter-reading table. Existing transaction rows are not deleted.
INSERT INTO meter_readings (device_id, kwh_consumed, source, recorded_at)
SELECT device_id, kwh_amount, 'LEGACY_TRANSACTION', timestamp
FROM transactions
WHERE type = 'consumption'
  AND kwh_amount > 0
  AND NOT EXISTS (
    SELECT 1
    FROM meter_readings mr
    WHERE mr.device_id = transactions.device_id
      AND mr.kwh_consumed = transactions.kwh_amount
      AND mr.recorded_at = transactions.timestamp
  );

-- Legacy handlers may still attempt to insert a consumption transaction.
-- Redirect those inserts into meter_readings and prevent them from entering
-- the financial transaction ledger.
CREATE OR REPLACE FUNCTION paygo_route_consumption_to_readings()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.type = 'consumption' THEN
    IF COALESCE(NEW.kwh_amount, 0) > 0 THEN
      INSERT INTO meter_readings (device_id, kwh_consumed, source, recorded_at)
      VALUES (NEW.device_id, NEW.kwh_amount, 'BALANCE_SYNC', COALESCE(NEW.timestamp, NOW()));
    END IF;
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_paygo_consumption_to_readings ON transactions;
CREATE TRIGGER trg_paygo_consumption_to_readings
BEFORE INSERT ON transactions
FOR EACH ROW
EXECUTE FUNCTION paygo_route_consumption_to_readings();

-- Backfill owner_id for the seeded prototype meter after the demo owner exists.
WITH unambiguous_owners AS (
  SELECT device_id, MIN(owner_id) AS owner_id
  FROM energy_sources
  GROUP BY device_id
  HAVING COUNT(DISTINCT owner_id) = 1
)
UPDATE devices d
SET owner_id = u.owner_id
FROM unambiguous_owners u
WHERE d.device_id = u.device_id
  AND d.owner_id IS NULL;
