-- Additive, reversible classification for the shared prototype device.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

UPDATE devices
SET is_demo = true
WHERE device_id = 'DEVICE-001';
