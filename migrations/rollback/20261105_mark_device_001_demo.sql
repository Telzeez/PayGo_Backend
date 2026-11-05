-- Run only when rolling back the demo-device classification migration.
UPDATE devices
SET is_demo = false
WHERE device_id = 'DEVICE-001'
  AND is_demo = true;

ALTER TABLE devices
  DROP COLUMN IF EXISTS is_demo;
