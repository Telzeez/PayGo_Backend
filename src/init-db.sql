-- Table for storing generated tokens
CREATE TABLE IF NOT EXISTS paygo_tokens (
  id SERIAL PRIMARY KEY,
  buyer_email VARCHAR(255) NOT NULL,
  device_id VARCHAR(50) NOT NULL,
  kwh_amount DECIMAL(10,2) NOT NULL,
  token_hash VARCHAR(255) NOT NULL,    -- bcrypt hash, not the raw token
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,       -- 72 hours from creation
  used BOOLEAN DEFAULT FALSE,
  redeemed_at TIMESTAMP
);

-- Table for tracking devices and their balances
CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  device_id VARCHAR(50) UNIQUE NOT NULL,
  current_balance DECIMAL(10,2) DEFAULT 0,
  last_updated TIMESTAMP DEFAULT NOW()
);

-- Table for transaction history
CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  device_id VARCHAR(50) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('topup', 'consumption')),
  amount DECIMAL(10,2) NOT NULL,
  timestamp TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tokens_device_id ON paygo_tokens(device_id);
CREATE INDEX IF NOT EXISTS idx_tokens_used ON paygo_tokens(used);
CREATE INDEX IF NOT EXISTS idx_tokens_expires_at ON paygo_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_transactions_device_id ON transactions(device_id);