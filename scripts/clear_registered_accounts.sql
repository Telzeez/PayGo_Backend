-- PAYGO account-only demo reset.
-- BACK UP THE DATABASE BEFORE RUNNING THIS SCRIPT.
-- Removes all registered accounts and user-owned marketplace setup.
-- Preserves devices, meter readings, financial transactions, prepaid tokens,
-- device balances, and meter reset audit rows.

BEGIN;

DELETE FROM marketplace_purchases;
DELETE FROM energy_listings;
DELETE FROM energy_sources;
DELETE FROM user_locations;
DELETE FROM users;

-- Defensive cleanup for devices that may have been associated with users
-- in installations where the FK was not migrated with ON DELETE SET NULL.
UPDATE devices SET owner_id = NULL WHERE owner_id IS NOT NULL;

COMMIT;

-- Expected after execution: users = 0; marketplace user setup = 0.
-- Device registry, balances, transactions, readings, and token history remain.
