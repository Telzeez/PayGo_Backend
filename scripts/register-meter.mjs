import 'dotenv/config';
import crypto from 'node:crypto';
import { Pool } from 'pg';

const deviceId = String(process.argv[2] || '').trim();
const purpose = String(process.argv[3] || 'RECEIVING').toUpperCase();

if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,49}$/.test(deviceId) ||
    !['GENERATION', 'RECEIVING'].includes(purpose)) {
  console.error('Usage: node scripts/register-meter.mjs <DEVICE_ID> [GENERATION|RECEIVING]');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});
const claimCode = crypto.randomBytes(16).toString('hex').toUpperCase();
const tokenHash = crypto.createHash('sha256').update(claimCode).digest('hex');
const client = await pool.connect();

try {
  await client.query('BEGIN');
  await client.query(
    `INSERT INTO devices (device_id, current_balance, status, assignment_status, meter_purpose)
     VALUES ($1, 0, 'OFFLINE', 'UNASSIGNED', $2)
     ON CONFLICT (device_id) DO NOTHING`,
    [deviceId, purpose]
  );
  const existing = await client.query(
    `SELECT owner_id, assignment_status FROM devices
     WHERE device_id = $1 FOR UPDATE`,
    [deviceId]
  );
  if (!existing.rows.length || existing.rows[0].owner_id !== null ||
      existing.rows[0].assignment_status !== 'UNASSIGNED') {
    throw new Error('This device is already claimed or assigned; refusing to issue another claim credential.');
  }
  // Rotate any previous unused code so only the newly printed code can claim this meter.
  await client.query(
    `UPDATE device_claim_tokens SET claimed_at = NOW()
     WHERE device_id = $1 AND claimed_at IS NULL`,
    [deviceId]
  );
  await client.query(
    `INSERT INTO device_claim_tokens (device_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
    [deviceId, tokenHash]
  );
  await client.query('COMMIT');
  console.log('Meter registered. Give this one-time claim code to the physical meter owner securely:');
  console.log(claimCode);
  console.log('The code is shown once. Store it securely; it cannot be retrieved from the database.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
