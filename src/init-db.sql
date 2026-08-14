-- Table for storing registered users (Buyers & Solar Owners)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(50),
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'USER',
  is_buyer BOOLEAN DEFAULT true,
  is_seller BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_buyer BOOLEAN DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_seller BOOLEAN DEFAULT false;

-- Table for storing generated tokens
CREATE TABLE IF NOT EXISTS paygo_tokens (
  id SERIAL PRIMARY KEY,
  buyer_email VARCHAR(255) NOT NULL,
  device_id VARCHAR(50) NOT NULL,
  kwh_amount DECIMAL(10,2) NOT NULL,
  token_hash VARCHAR(255) NOT NULL,    -- bcrypt hash, not the raw token
  transaction_id VARCHAR(100),
  auto_credited BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,       -- 72 hours from creation
  used BOOLEAN DEFAULT FALSE,
  redeemed_at TIMESTAMP
);
ALTER TABLE paygo_tokens ADD COLUMN IF NOT EXISTS paystack_reference VARCHAR(255) UNIQUE;
ALTER TABLE paygo_tokens ADD COLUMN IF NOT EXISTS transaction_id VARCHAR(100);
ALTER TABLE paygo_tokens ADD COLUMN IF NOT EXISTS auto_credited BOOLEAN DEFAULT FALSE;

-- Table for tracking devices and their balances
CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  device_id VARCHAR(50) UNIQUE NOT NULL,
  current_balance DECIMAL(10,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'OFFLINE',
  last_seen_at TIMESTAMP,
  last_updated TIMESTAMP DEFAULT NOW()
);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'OFFLINE';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP;

-- Table for transaction history
CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  device_id VARCHAR(50) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('topup', 'consumption')),
  amount DECIMAL(10,2) NOT NULL,       -- Money amount in Naira/Kobo
  kwh_amount DECIMAL(10,2) DEFAULT 0,  -- Energy amount in kWh
  transaction_id VARCHAR(100) UNIQUE,  -- Internal transaction ID (e.g. TXN_8F72A91)
  reference VARCHAR(255) UNIQUE,       -- Paystack payment reference
  hardware_status VARCHAR(20) DEFAULT 'PENDING', -- PENDING | CONFIRMED | FAILED
  retry_count INT DEFAULT 0,
  last_attempt_at TIMESTAMP,
  timestamp TIMESTAMP DEFAULT NOW()
);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS kwh_amount DECIMAL(10,2) DEFAULT 0;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transaction_id VARCHAR(100) UNIQUE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reference VARCHAR(255) UNIQUE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS hardware_status VARCHAR(20) DEFAULT 'PENDING';
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS retry_count INT DEFAULT 0;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMP;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tokens_device_id ON paygo_tokens(device_id);
CREATE INDEX IF NOT EXISTS idx_tokens_used ON paygo_tokens(used);
CREATE INDEX IF NOT EXISTS idx_tokens_expires_at ON paygo_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_transactions_device_id ON transactions(device_id);
CREATE INDEX IF NOT EXISTS idx_transactions_tx_id ON transactions(transaction_id);
CREATE INDEX IF NOT EXISTS idx_transactions_ref ON transactions(reference);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ======================================================
-- LOCAL ENERGY MARKETPLACE SCHEMA
-- ======================================================

-- User location records (GPS / Approximate)
CREATE TABLE IF NOT EXISTS user_locations (
  id SERIAL PRIMARY KEY,
  user_id INT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  latitude DECIMAL(10,8) NOT NULL,
  longitude DECIMAL(11,8) NOT NULL,
  location_source VARCHAR(20) DEFAULT 'GPS',
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Seller energy generation sources (Solar systems tied to devices)
CREATE TABLE IF NOT EXISTS energy_sources (
  id SERIAL PRIMARY KEY,
  owner_id INT NOT NULL REFERENCES users(id),
  device_id VARCHAR(50) NOT NULL REFERENCES devices(device_id),
  name VARCHAR(255) NOT NULL,
  latitude DECIMAL(10,8) NOT NULL,
  longitude DECIMAL(11,8) NOT NULL,
  service_radius_m INT DEFAULT 500 CHECK (service_radius_m > 0),
  status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'OFFLINE', 'DECOMMISSIONED')),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Available energy listings offered by sellers
CREATE TABLE IF NOT EXISTS energy_listings (
  id SERIAL PRIMARY KEY,
  energy_source_id INT NOT NULL REFERENCES energy_sources(id) ON DELETE CASCADE,
  seller_id INT NOT NULL REFERENCES users(id),
  available_kwh DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (available_kwh >= 0),
  reserved_kwh DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (reserved_kwh >= 0),
  price_per_kwh DECIMAL(10,2) NOT NULL CHECK (price_per_kwh > 0),
  status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED', 'SOLD_OUT', 'EXPIRED')),
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Marketplace purchase intents & orders
CREATE TABLE IF NOT EXISTS marketplace_purchases (
  id SERIAL PRIMARY KEY,
  purchase_reference VARCHAR(255) UNIQUE NOT NULL,
  listing_id INT NOT NULL REFERENCES energy_listings(id),
  buyer_id INT NOT NULL REFERENCES users(id),
  seller_id INT NOT NULL REFERENCES users(id),
  device_id VARCHAR(50) NOT NULL,
  distance_m INT NOT NULL,
  price_per_kwh DECIMAL(10,2) NOT NULL,
  kwh_requested DECIMAL(10,2) NOT NULL CHECK (kwh_requested > 0),
  amount DECIMAL(10,2) NOT NULL CHECK (amount >= 0),
  status VARCHAR(30) DEFAULT 'PAYMENT_PENDING' CHECK (status IN ('RESERVED', 'PAYMENT_PENDING', 'COMPLETED', 'CANCELLED', 'EXPIRED')),
  paystack_reference VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Marketplace Indexes
CREATE INDEX IF NOT EXISTS idx_user_locations_user ON user_locations(user_id);
CREATE INDEX IF NOT EXISTS idx_energy_sources_owner ON energy_sources(owner_id);
CREATE INDEX IF NOT EXISTS idx_energy_sources_device ON energy_sources(device_id);
CREATE INDEX IF NOT EXISTS idx_energy_listings_status ON energy_listings(status);
CREATE INDEX IF NOT EXISTS idx_energy_listings_source ON energy_listings(energy_source_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_purchases_ref ON marketplace_purchases(purchase_reference);
CREATE INDEX IF NOT EXISTS idx_marketplace_purchases_buyer ON marketplace_purchases(buyer_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_purchases_seller ON marketplace_purchases(seller_id);

-- ======================================================
-- SEED DEMO DATA FOR PROTOTYPE DEMONSTRATION
-- ======================================================
INSERT INTO devices (device_id, current_balance, status, last_seen_at)
VALUES ('DEVICE-001', 30.00, 'OFFLINE', NULL)
ON CONFLICT (device_id) DO NOTHING;

INSERT INTO users (email, phone, password_hash, role)
VALUES ('seller_demo@paygo.com', '+2349016971707', '$2b$10$e7K4y5Q8z1K3v7X8M9L0Oe.9.1.1.1.1.1.1.1.1', 'OWNER')
ON CONFLICT (email) DO NOTHING;

-- Seed Seller Sources near Ibadan test coordinates (7.44, 3.90)
INSERT INTO energy_sources (owner_id, device_id, name, latitude, longitude, service_radius_m, status)
SELECT u.id, 'DEVICE-001', 'Rooftop Solar Home A', 7.4416, 3.9000, 500, 'ACTIVE'
FROM users u WHERE u.email = 'seller_demo@paygo.com'
AND NOT EXISTS (SELECT 1 FROM energy_sources WHERE name = 'Rooftop Solar Home A');

INSERT INTO energy_sources (owner_id, device_id, name, latitude, longitude, service_radius_m, status)
SELECT u.id, 'DEVICE-001', 'Solar Microgrid B', 7.4438, 3.9000, 1000, 'ACTIVE'
FROM users u WHERE u.email = 'seller_demo@paygo.com'
AND NOT EXISTS (SELECT 1 FROM energy_sources WHERE name = 'Solar Microgrid B');

INSERT INTO energy_sources (owner_id, device_id, name, latitude, longitude, service_radius_m, status)
SELECT u.id, 'DEVICE-001', 'Distant Solar Array C', 7.4560, 3.9000, 500, 'ACTIVE'
FROM users u WHERE u.email = 'seller_demo@paygo.com'
AND NOT EXISTS (SELECT 1 FROM energy_sources WHERE name = 'Distant Solar Array C');

-- Seed Active Energy Listings
INSERT INTO energy_listings (energy_source_id, seller_id, available_kwh, reserved_kwh, price_per_kwh, status)
SELECT s.id, s.owner_id, 4.80, 0, 250.00, 'ACTIVE'
FROM energy_sources s WHERE s.name = 'Rooftop Solar Home A'
AND NOT EXISTS (SELECT 1 FROM energy_listings WHERE energy_source_id = s.id);

INSERT INTO energy_listings (energy_source_id, seller_id, available_kwh, reserved_kwh, price_per_kwh, status)
SELECT s.id, s.owner_id, 8.20, 0, 230.00, 'ACTIVE'
FROM energy_sources s WHERE s.name = 'Solar Microgrid B'
AND NOT EXISTS (SELECT 1 FROM energy_listings WHERE energy_source_id = s.id);

INSERT INTO energy_listings (energy_source_id, seller_id, available_kwh, reserved_kwh, price_per_kwh, status)
SELECT s.id, s.owner_id, 15.00, 0, 200.00, 'ACTIVE'
FROM energy_sources s WHERE s.name = 'Distant Solar Array C'
AND NOT EXISTS (SELECT 1 FROM energy_listings WHERE energy_source_id = s.id);