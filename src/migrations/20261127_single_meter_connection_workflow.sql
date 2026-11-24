-- Prototype connection lifecycle: one prosumer-owned generation meter and one connected buyer.
-- Buyer coordinates are rounded before persistence and shown only to the source owner.
ALTER TABLE customer_connections
  ADD COLUMN IF NOT EXISTS buyer_latitude NUMERIC(10,3),
  ADD COLUMN IF NOT EXISTS buyer_longitude NUMERIC(11,3),
  ADD COLUMN IF NOT EXISTS buyer_distance_m INT,
  ADD COLUMN IF NOT EXISTS installation_confirmed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customer_connections_buyer_location_pair'
      AND conrelid = 'customer_connections'::regclass
  ) THEN
    ALTER TABLE customer_connections
      ADD CONSTRAINT customer_connections_buyer_location_pair
      CHECK (
        (buyer_latitude IS NULL AND buyer_longitude IS NULL)
        OR (buyer_latitude IS NOT NULL AND buyer_longitude IS NOT NULL
          AND buyer_latitude BETWEEN -90 AND 90 AND buyer_longitude BETWEEN -180 AND 180)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customer_connections_buyer_distance_nonnegative'
      AND conrelid = 'customer_connections'::regclass
  ) THEN
    ALTER TABLE customer_connections
      ADD CONSTRAINT customer_connections_buyer_distance_nonnegative
      CHECK (buyer_distance_m IS NULL OR buyer_distance_m >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_customer_connections_source_lifecycle
  ON customer_connections(source_id, status, requested_at DESC);

-- Enforce one installed buyer connection per physical source meter.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_connections_one_installed_buyer_per_source
  ON customer_connections(source_id)
  WHERE status IN ('APPROVED', 'PENDING_REVISION')
    AND installation_confirmed_at IS NOT NULL;

-- The physical meter remains registered to the prosumer. No buyer receiving
-- meter is created or assigned by this prototype workflow.
