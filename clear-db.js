import pool from './dist/db.js';

async function run() {
  try {
    console.log('Resetting database balance and transactions...');
    await pool.query('TRUNCATE TABLE transactions RESTART IDENTITY CASCADE;');
    await pool.query('TRUNCATE TABLE paygo_tokens RESTART IDENTITY CASCADE;');
    await pool.query('TRUNCATE TABLE marketplace_purchases RESTART IDENTITY CASCADE;');
    await pool.query('UPDATE devices SET current_balance = 0, last_seen_at = NULL, last_updated = NOW();');
    console.log('✅ Successfully cleared all transactions, tokens, and reset device balances to 0 kWh.');
  } catch (err) {
    console.error('Error resetting database:', err);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

run();
