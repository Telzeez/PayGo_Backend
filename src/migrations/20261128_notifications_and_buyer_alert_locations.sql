-- Persistent in-app notifications and opt-in approximate buyer locations for nearby energy alerts.
CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(40) NOT NULL,
  title VARCHAR(160) NOT NULL,
  message VARCHAR(500) NOT NULL,
  target_url VARCHAR(500) NOT NULL,
  entity_id BIGINT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread_created
  ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications(user_id, created_at DESC);

-- Only users who explicitly opt in are included in background proximity matching.
-- Coordinates are rounded to 3 decimal places (~100 m); exact GPS is not retained.
CREATE TABLE IF NOT EXISTS buyer_alert_locations (
  user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  latitude NUMERIC(6,3) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude NUMERIC(7,3) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_buyer_alert_locations_enabled
  ON buyer_alert_locations(enabled) WHERE enabled = TRUE;
