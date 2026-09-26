import pool from './src/db.js';

async function run() {
  try {
    await pool.query('ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;');
    console.log('Successfully dropped NOT NULL constraint on password_hash');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    process.exit(0);
  }
}

run();
