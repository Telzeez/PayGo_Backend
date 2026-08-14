import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  try {
    console.log('Connecting to remote database...');
    const result = await pool.query("UPDATE devices SET status = 'OFFLINE', last_seen_at = NULL WHERE device_id = 'DEVICE-001'");
    if (result.rowCount > 0) {
      console.log('✅ Successfully set DEVICE-001 to OFFLINE in the remote Render database.');
    } else {
      console.log('⚠️ Device DEVICE-001 not found.');
    }
  } catch (error) {
    console.error('Failed:', error.message);
  } finally {
    await pool.end();
  }
}

run();
