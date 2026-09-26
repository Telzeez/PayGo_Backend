import pool from './src/db.js';

async function run() {
  try {
    await pool.query('TRUNCATE TABLE transactions RESTART IDENTITY CASCADE;');
    await pool.query('TRUNCATE TABLE paygo_tokens RESTART IDENTITY CASCADE;');
    await pool.query('TRUNCATE TABLE marketplace_purchases RESTART IDENTITY CASCADE;');
    await pool.query('UPDATE devices SET current_balance = 0;');
    console.log('Successfully cleared all transactions, tokens, and reset balances');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    process.exit(0);
  }
}

run();
