-- PAYGO location lifecycle and seller verification.
-- Reuse energy_sources latitude/longitude/service_radius_m and existing listing status.
ALTER TABLE energy_sources ADD COLUMN IF NOT EXISTS location_set_at TIMESTAMP;
ALTER TABLE energy_sources ADD COLUMN IF NOT EXISTS location_accuracy_m DECIMAL(8,2);
ALTER TABLE energy_sources ADD COLUMN IF NOT EXISTS location_verified_at TIMESTAMP;

-- Extend the existing listing status constraint to represent a revoked offer.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'energy_listings'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE energy_listings DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE energy_listings
  ADD CONSTRAINT energy_listings_status_check
  CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED', 'SOLD_OUT', 'EXPIRED', 'REVOKED'));

-- No suitable listing-location audit table exists; retain status/location changes here.
CREATE TABLE IF NOT EXISTS energy_source_location_events (
  id BIGSERIAL PRIMARY KEY,
  energy_source_id INT NOT NULL REFERENCES energy_sources(id) ON DELETE CASCADE,
  actor_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  event_type VARCHAR(24) NOT NULL CHECK (event_type IN ('LOCATION_SET', 'LOCATION_UPDATED', 'PAUSED', 'REVOKED', 'RELISTED')),
  latitude DECIMAL(10,8),
  longitude DECIMAL(11,8),
  accuracy_m DECIMAL(8,2),
  distance_from_previous_m INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_energy_source_location_events_source_created
  ON energy_source_location_events(energy_source_id, created_at DESC);
