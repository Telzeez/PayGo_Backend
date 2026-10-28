// reset-balance.js
// Resets DEVICE-001 balance to 0 and status to OFFLINE for retesting.
// Does NOT touch transactions or tokens.
// Run with: node reset-balance.js

import pool from './dist/db.js';

async function run() {
  try {
    const result = await pool.query(
      `UPDATE devices
       SET current_balance = 0,
           status = 'OFFLINE',
           last_seen_at = NULL,
           last_updated = NOW()
       WHERE device_id = 'DEVICE-001'
       RETURNING device_id, current_balance, status`
    );

    if (result.rows.length === 0) {
      console.log('No device found with id DEVICE-001');
    } else {
      const row = result.rows[0];
      console.log('Reset complete:');
      console.log('  device_id:       ' + row.device_id);
      console.log('  current_balance: ' + row.current_balance + ' kWh');
      console.log('  status:          ' + row.status);
    }
  } catch (err) {
    console.error('Error resetting balance:', err);
  } finally {
    process.exit(0);
  }
}

run();
