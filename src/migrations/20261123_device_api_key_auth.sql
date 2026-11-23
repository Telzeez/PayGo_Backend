-- Device credentials for authenticated HTTPS communication with ESP32 meters.
-- Raw credentials are never stored; only SHA-256 hashes are persisted.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS device_api_key_hash CHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_device_api_key_hash
  ON devices (device_api_key_hash)
  WHERE device_api_key_hash IS NOT NULL;
