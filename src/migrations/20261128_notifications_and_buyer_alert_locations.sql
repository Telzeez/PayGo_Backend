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


-- Notify the source owner immediately when a buyer submits a connection request.
CREATE OR REPLACE FUNCTION paygo_notify_connection_request() RETURNS TRIGGER AS $$
DECLARE owner_user_id INT;
BEGIN
  SELECT owner_id INTO owner_user_id FROM energy_sources WHERE id = NEW.source_id;
  IF owner_user_id IS NOT NULL THEN
    INSERT INTO notifications (user_id, type, title, message, target_url, entity_id)
    VALUES (
      owner_user_id, 'CONNECTION_REQUEST', 'New connection request',
      'A buyer has requested a connection to your energy source.',
      '/marketplace/seller?connectionId=' || NEW.id, NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_paygo_notify_connection_request ON customer_connections;
CREATE TRIGGER trg_paygo_notify_connection_request
AFTER INSERT ON customer_connections
FOR EACH ROW EXECUTE FUNCTION paygo_notify_connection_request();

-- Notify opted-in buyers when a new active listing is published within the
-- source's service radius. Coordinates in buyer_alert_locations are approximate.
CREATE OR REPLACE FUNCTION paygo_notify_nearby_buyers() RETURNS TRIGGER AS $$
DECLARE source_record RECORD;
BEGIN
  IF NEW.status <> 'ACTIVE' THEN RETURN NEW; END IF;
  SELECT id, owner_id, name, latitude, longitude, service_radius_m
    INTO source_record
    FROM energy_sources
    WHERE id = NEW.energy_source_id AND status = 'ACTIVE';
  IF NOT FOUND THEN RETURN NEW; END IF;

  INSERT INTO notifications (user_id, type, title, message, target_url, entity_id)
  SELECT a.user_id, 'NEARBY_ENERGY', 'Energy available near you',
         source_record.name || ' has published energy within its service area.',
         '/marketplace?listingId=' || NEW.id, NEW.id
  FROM buyer_alert_locations a
  JOIN users u ON u.id = a.user_id
  WHERE a.enabled = TRUE AND u.is_buyer = TRUE
    AND a.user_id <> source_record.owner_id
    AND 6371000 * 2 * ASIN(SQRT(
      POWER(SIN(RADIANS(a.latitude::float8 - source_record.latitude::float8) / 2), 2) +
      COS(RADIANS(source_record.latitude::float8)) * COS(RADIANS(a.latitude::float8)) *
      POWER(SIN(RADIANS(a.longitude::float8 - source_record.longitude::float8) / 2), 2)
    )) <= source_record.service_radius_m;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_paygo_notify_nearby_buyers ON energy_listings;
CREATE TRIGGER trg_paygo_notify_nearby_buyers
AFTER INSERT ON energy_listings
FOR EACH ROW EXECUTE FUNCTION paygo_notify_nearby_buyers();
