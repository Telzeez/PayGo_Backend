-- Deliberately non-destructive rollback.
-- New audit, pairing, operation, and purchase-snapshot data must not be dropped.
-- Reverting application code is safe while retaining these additive schema changes.
BEGIN;

ALTER TABLE energy_sources
  DROP CONSTRAINT IF EXISTS energy_sources_meter_assignment_owner_device_fk;
ALTER TABLE marketplace_purchases
  DROP CONSTRAINT IF EXISTS marketplace_purchases_buyer_meter_snapshot_fk;
ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_marketplace_purchase_fk;

-- Keep additive columns, tables, demo archives, and role migration data intact.
COMMIT;
