-- Table for storing registered users (Buyers & Solar Owners)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(50),
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('BUYER', 'OWNER')) DEFAULT 'BUYER',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
ALTER TABLE users ADD CONSTRAINT unique_email UNIQUE (email);

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