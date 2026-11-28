import express, { Response } from 'express';
import crypto from 'crypto';
import { sendMeterActivationEmail } from '../services/email.js';
import pool from '../db.js';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/authMiddleware.js';

const router = express.Router();
router.use(authenticateToken);

// Keep owner-facing status consistent with the device heartbeat endpoint.
const HEARTBEAT_TTL_MS = 5_000;
function getEffectiveDeviceStatus(
  status: string | null | undefined,
  lastSeenAt: string | Date | null | undefined
): 'ONLINE' | 'OFFLINE' {
  if (status !== 'ONLINE' || !lastSeenAt) return 'OFFLINE';
  const lastSeenMs = new Date(lastSeenAt).getTime();
  const ageMs = Date.now() - lastSeenMs;
  return Number.isFinite(lastSeenMs) && ageMs >= 0 && ageMs <= HEARTBEAT_TTL_MS
    ? 'ONLINE'
    : 'OFFLINE';
}

// Platform-controlled provisioning. The meter must already exist in the device registry.
router.post('/:deviceId/provision', async (req: AuthenticatedRequest, res: Response) => {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'Administrator access required' });
  }
  const deviceId = String(req.params.deviceId || '').trim();
  const ownerId = Number(req.body?.ownerId);
  const meterPurpose = String(req.body?.purpose || 'GENERATION').toUpperCase();
  const connectionId = req.body?.connectionId === undefined ? null : Number(req.body.connectionId);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,49}$/.test(deviceId) || !Number.isInteger(ownerId) || ownerId <= 0 || !['GENERATION', 'RECEIVING'].includes(meterPurpose) ||
      (meterPurpose === 'RECEIVING' && (!Number.isInteger(connectionId) || Number(connectionId) <= 0)) ||
      (meterPurpose === 'GENERATION' && connectionId !== null)) {
    return res.status(400).json({ success: false, error: 'A valid registered device ID and owner account ID are required.' });
  }

  const client = await pool.connect();
  let rawCode = '';
  let recipientEmail = '';
  try {
    await client.query('BEGIN');
    const user = await client.query('SELECT id, email, email_verified FROM users WHERE id = $1', [ownerId]);
    if (!user.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Target owner account was not found.' });
    }
    if (!user.rows[0].email_verified) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'The target owner must verify their email before a meter can be assigned.' });
    }
    if (meterPurpose === 'RECEIVING') {
      const approvedConnection = await client.query(
        `SELECT id FROM customer_connections
         WHERE id = $1 AND customer_id = $2
           AND status IN ('APPROVED', 'PENDING_REVISION')
           AND approved_power_w IS NOT NULL AND receiving_device_id IS NULL
         FOR UPDATE`,
        [connectionId, ownerId]
      );
      if (!approvedConnection.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, error: 'A receiving meter can only be assigned to an approved connection request belonging to this customer.' });
      }
    }
    const device = await client.query(
      `SELECT device_id, owner_id, assignment_status, meter_purpose FROM devices WHERE device_id = $1 FOR UPDATE`,
      [deviceId]
    );
    if (!device.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Meter is not registered in the PAYGO device registry.' });
    }
    if (device.rows[0].owner_id && Number(device.rows[0].owner_id) !== ownerId) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'Meter is already assigned to another account.' });
    }
    if (device.rows[0].assignment_status === 'ACTIVATED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'Meter has already been activated.' });
    }

    rawCode = crypto.randomBytes(5).toString('hex').toUpperCase();
    const codeHash = crypto.createHash('sha256').update(rawCode).digest('hex');
    await client.query(
      `UPDATE devices SET owner_id = $2, assignment_status = 'ASSIGNED', assigned_at = NOW(), meter_purpose = $3
       WHERE device_id = $1`,
      [deviceId, ownerId, meterPurpose]
    );
    if (meterPurpose === 'RECEIVING') {
      const linked = await client.query(
        `UPDATE customer_connections SET receiving_device_id = $2, updated_at = NOW()
         WHERE id = $1 AND customer_id = $3
           AND status IN ('APPROVED', 'PENDING_REVISION')
           AND approved_power_w IS NOT NULL AND receiving_device_id IS NULL`,
        [connectionId, deviceId, ownerId]
      );
      if (linked.rowCount !== 1) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, error: 'Unable to link the receiving meter to this approved connection.' });
      }
    }
    await client.query(
      `UPDATE device_activation_codes SET used_at = NOW()
       WHERE device_id = $1 AND used_at IS NULL`,
      [deviceId]
    );
    await client.query(
      `INSERT INTO device_activation_codes (device_id, owner_id, code_hash, expires_at, created_by)
       VALUES ($1, $2, $3, NOW() + INTERVAL '72 hours', $4)`,
      [deviceId, ownerId, codeHash, req.user.userId]
    );
    recipientEmail = user.rows[0].email;
    // The assignment and hashed code are durable before attempting external email delivery.
    await client.query('COMMIT');
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Meter provisioning error:', error);
    return res.status(500).json({ success: false, error: 'Unable to provision this meter.' });
  } finally {
    client.release();
  }

  let activationEmailSent = true;
  try {
    await sendMeterActivationEmail(recipientEmail, deviceId, rawCode);
  } catch (error: any) {
    activationEmailSent = false;
    // Never log the one-time activation code. The admin can safely generate a new code via resend.
    console.warn('Meter activation email delivery failed after provisioning:', error?.message || 'Unknown email delivery error');
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(201).json({
    success: true,
    deviceId,
    ownerId,
    activationEmailSent,
    // Temporary admin-only recovery display: returned only when email delivery fails.
    activationCode: activationEmailSent ? null : rawCode,
    expiresInHours: 72,
    connectionId,
    message: activationEmailSent
      ? 'Meter assigned. A one-time activation code has been sent to the verified email address on the owner account.'
      : 'Meter assigned successfully, but the activation email could not be sent. The activation code is displayed below for manual activation.',
  });
});

// Admin-only recovery for an activated meter. Existing hardware credentials and
// operational history are deliberately left unchanged.
router.post('/:deviceId/recover-activated', async (req: AuthenticatedRequest, res: Response) => {
  if (req.user?.role !== 'ADMIN') return res.status(403).json({ success: false, error: 'Administrator access required.' });
  const deviceId = String(req.params.deviceId || '').trim();
  const ownerId = Number(req.body?.ownerId);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,49}$/.test(deviceId) || !Number.isInteger(ownerId) || ownerId <= 0) return res.status(400).json({ success: false, error: 'A valid meter ID and target account user ID are required.' });
  const client = await pool.connect();
  let rawCode = '';
  let recipientEmail = '';
  try {
    await client.query('BEGIN');
    const user = await client.query('SELECT id, email, email_verified FROM users WHERE id = $1 FOR SHARE', [ownerId]);
    if (!user.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Target owner account was not found.' }); }
    if (!user.rows[0].email_verified) { await client.query('ROLLBACK'); return res.status(409).json({ success: false, error: 'The target owner must verify their email before meter recovery.' }); }
    const device = await client.query('SELECT device_id, owner_id, assignment_status FROM devices WHERE device_id = $1 FOR UPDATE', [deviceId]);
    if (!device.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Meter not found in the PAYGO device registry.' }); }
    if (device.rows[0].assignment_status !== 'ACTIVATED') { await client.query('ROLLBACK'); return res.status(409).json({ success: false, error: 'Recovery is only available for an activated meter.' }); }
    if (Number(device.rows[0].owner_id) === ownerId) { await client.query('ROLLBACK'); return res.status(409).json({ success: false, error: 'This meter already belongs to the selected account.' }); }
    rawCode = crypto.randomBytes(5).toString('hex').toUpperCase();
    const codeHash = crypto.createHash('sha256').update(rawCode).digest('hex');
    await client.query('UPDATE device_activation_codes SET used_at = NOW() WHERE device_id = $1 AND used_at IS NULL', [deviceId]);
    await client.query("UPDATE devices SET owner_id = $2, assignment_status = 'ASSIGNED', assigned_at = NOW(), last_updated = NOW() WHERE device_id = $1", [deviceId, ownerId]);
    await client.query("INSERT INTO device_activation_codes (device_id, owner_id, code_hash, expires_at, created_by) VALUES ($1, $2, $3, NOW() + INTERVAL '72 hours', $4)", [deviceId, ownerId, codeHash, req.user.userId]);
    recipientEmail = user.rows[0].email;
    await client.query('COMMIT');
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Activated meter recovery error:', error);
    return res.status(500).json({ success: false, error: 'Unable to recover this activated meter.' });
  } finally { client.release(); }
  let activationEmailSent = true;
  try { await sendMeterActivationEmail(recipientEmail, deviceId, rawCode); }
  catch (error: any) { activationEmailSent = false; console.warn('Recovered meter activation email delivery failed:', error?.message || 'Unknown email delivery error'); }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  return res.json({ success: true, deviceId, ownerId, activationEmailSent, activationCode: rawCode, expiresInHours: 72, message: activationEmailSent ? 'Meter ownership transferred and a fresh activation code emailed. The code is also displayed here for admin-assisted activation.' : 'Meter ownership transferred. Email delivery failed; use the fresh activation code displayed here.' });
});
// Generate a fresh one-time code for an assigned, not-yet-activated meter.
// The hashed code is committed before email delivery; email failure never rolls back the assignment.
router.post('/:deviceId/resend-activation', async (req: AuthenticatedRequest, res: Response) => {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'Administrator access required.' });
  }

  const deviceId = String(req.params.deviceId || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,49}$/.test(deviceId)) {
    return res.status(400).json({ success: false, error: 'Invalid meter ID.' });
  }

  const client = await pool.connect();
  let rawCode = '';
  let recipientEmail = '';
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT d.owner_id, d.assignment_status, u.email, u.email_verified
       FROM devices d
       JOIN users u ON u.id = d.owner_id
       WHERE d.device_id = $1
       FOR UPDATE OF d`,
      [deviceId]
    );
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Assigned meter or owner account was not found.' });
    }
    const meter = result.rows[0];
    if (meter.assignment_status !== 'ASSIGNED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'Only an assigned, not-yet-activated meter can receive a new activation code.' });
    }
    if (!meter.email_verified) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'The owner must verify their email before an activation code can be sent.' });
    }

    rawCode = crypto.randomBytes(5).toString('hex').toUpperCase();
    const codeHash = crypto.createHash('sha256').update(rawCode).digest('hex');
    await client.query(
      `UPDATE device_activation_codes SET used_at = NOW()
       WHERE device_id = $1 AND owner_id = $2 AND used_at IS NULL`,
      [deviceId, meter.owner_id]
    );
    await client.query(
      `INSERT INTO device_activation_codes (device_id, owner_id, code_hash, expires_at, created_by)
       VALUES ($1, $2, $3, NOW() + INTERVAL '72 hours', $4)`,
      [deviceId, meter.owner_id, codeHash, req.user.userId]
    );
    recipientEmail = meter.email;
    await client.query('COMMIT');
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Meter activation code regeneration error:', error);
    return res.status(500).json({ success: false, error: 'Unable to generate a new activation code.' });
  } finally {
    client.release();
  }

  let activationEmailSent = true;
  try {
    await sendMeterActivationEmail(recipientEmail, deviceId, rawCode);
  } catch (error: any) {
    activationEmailSent = false;
    console.warn('Meter activation email resend failed:', error?.message || 'Unknown email delivery error');
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    success: true,
    deviceId,
    activationEmailSent,
    // Temporary admin-only recovery display: returned only when email delivery fails.
    activationCode: activationEmailSent ? null : rawCode,
    expiresInHours: 72,
    message: activationEmailSent
      ? 'A fresh one-time activation code has been emailed. Any previous unused code is now invalid.'
      : 'A fresh code was generated and the previous code was invalidated. The new activation code is displayed below for manual activation.',
  });
});


/**
 * Rotate a physical meter's API credential. The raw key is returned exactly
 * once; only its SHA-256 hash is persisted. The device must be reflashed with
 * the new key before its next HTTPS heartbeat.
 */
router.post('/:deviceId/rotate-api-key', async (req: AuthenticatedRequest, res: Response) => {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'Administrator access required.' });
  }

  const deviceId = String(req.params.deviceId || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,49}$/.test(deviceId)) {
    return res.status(400).json({ success: false, error: 'Invalid meter ID.' });
  }

  try {
    const deviceApiKey = crypto.randomBytes(32).toString('base64url');
    const keyHash = crypto.createHash('sha256').update(deviceApiKey).digest('hex');
    const updated = await pool.query(
      'UPDATE devices SET device_api_key_hash = $2, last_updated = NOW() WHERE device_id = $1 RETURNING device_id',
      [deviceId, keyHash]
    );
    if (updated.rowCount !== 1) {
      return res.status(404).json({ success: false, error: 'Meter not found in the PAYGO device registry.' });
    }

    return res.json({
      success: true,
      deviceId,
      deviceApiKey,
      message: 'Copy this key now and store it securely in this meter’s local DeviceConfig.h. It will not be shown again.',
    });
  } catch (error) {
    console.error('Device API key rotation failed:', error);
    return res.status(500).json({ success: false, error: 'Unable to rotate the meter API key.' });
  }
});

// Owner activates only a meter that the platform has already assigned to their account.
router.post('/activate', async (req: AuthenticatedRequest, res: Response) => {
  const ownerId = req.user!.userId;
  const deviceId = String(req.body?.deviceId || '').trim();
  const code = String(req.body?.activationCode || '').trim().toUpperCase();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,49}$/.test(deviceId) || !/^[A-F0-9]{10}$/.test(code)) {
    return res.status(400).json({ success: false, error: 'Enter the meter ID and the 10-character one-time code supplied by PAYGO.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const device = await client.query(
      `SELECT device_id, owner_id, assignment_status, meter_purpose FROM devices
       WHERE device_id = $1 FOR UPDATE`,
      [deviceId]
    );
    if (!device.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Meter not found in the PAYGO registry.' });
    }

    // Compatibility path for the currently deployed 10-character activation form.
    // A short one-time credential can claim an unassigned registered meter without
    // requiring a Vercel frontend deployment. It is still hashed, expiring, single-use,
    // and limited to five failed attempts.
    if (device.rows[0].owner_id === null && device.rows[0].assignment_status === 'UNASSIGNED') {
      const shortCodeHash = crypto.createHash('sha256').update(code).digest('hex');
      const claim = await client.query(
        `SELECT id FROM device_claim_tokens
         WHERE device_id = $1 AND token_hash = $2
           AND claimed_at IS NULL AND expires_at > NOW() AND failed_attempts < 5
         FOR UPDATE`,
        [deviceId, shortCodeHash]
      );

      if (!claim.rows.length) {
        await client.query(
          `UPDATE device_claim_tokens SET failed_attempts = failed_attempts + 1
           WHERE device_id = $1 AND claimed_at IS NULL
             AND expires_at > NOW() AND failed_attempts < 5`,
          [deviceId]
        );
        await client.query('COMMIT');
        return res.status(400).json({ success: false, error: 'Invalid, expired, or previously used activation code.' });
      }

      const purpose = device.rows[0].meter_purpose;
      if (!['GENERATION', 'RECEIVING'].includes(purpose)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, error: 'This meter has no valid registered purpose.' });
      }

      await client.query(
        `UPDATE devices SET owner_id = $2, assignment_status = 'ACTIVATED',
           assigned_at = NOW(), claimed_at = NOW(), last_updated = NOW()
         WHERE device_id = $1 AND owner_id IS NULL AND assignment_status = 'UNASSIGNED'`,
        [deviceId, ownerId]
      );
      await client.query(
        'UPDATE device_claim_tokens SET claimed_at = NOW() WHERE id = $1',
        [claim.rows[0].id]
      );
      if (purpose === 'GENERATION') {
        await client.query(
          `UPDATE users SET is_seller = TRUE, role = 'OWNER', updated_at = NOW()
           WHERE id = $1`,
          [ownerId]
        );
      }
      await client.query('COMMIT');
      return res.json({
        success: true,
        deviceId,
        message: purpose === 'GENERATION'
          ? 'Your generation meter is now activated on your prosumer account.'
          : 'Your receiving meter is now activated on your account.'
      });
    }

    if (Number(device.rows[0].owner_id) !== ownerId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'No meter has been assigned to this account with that ID.' });
    }
    if (device.rows[0].assignment_status === 'ACTIVATED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'This meter is already activated on your account.' });
    }
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    const activation = await client.query(
      `SELECT id, failed_attempts FROM device_activation_codes
       WHERE device_id = $1 AND owner_id = $2 AND code_hash = $3
         AND used_at IS NULL AND expires_at > NOW() AND failed_attempts < 5
       FOR UPDATE`,
      [deviceId, ownerId, codeHash]
    );
    if (!activation.rows.length) {
      await client.query(
        `UPDATE device_activation_codes SET failed_attempts = failed_attempts + 1
         WHERE device_id = $1 AND owner_id = $2 AND used_at IS NULL AND expires_at > NOW()`,
        [deviceId, ownerId]
      );
      await client.query('COMMIT');
      return res.status(400).json({ success: false, error: 'Invalid, expired, or previously used activation code.' });
    }
    await client.query('UPDATE device_activation_codes SET used_at = NOW() WHERE id = $1', [activation.rows[0].id]);
    await client.query(
      `UPDATE devices SET assignment_status = 'ACTIVATED' WHERE device_id = $1 AND owner_id = $2`,
      [deviceId, ownerId]
    );
    // Activation unlocks the seller capability without creating a second account.
    if (device.rows[0].meter_purpose === 'GENERATION') {
      await client.query(
        `UPDATE users SET is_seller = TRUE, role = 'OWNER', updated_at = NOW() WHERE id = $1`,
        [ownerId]
      );
    }
    await client.query('COMMIT');
    return res.json({ success: true, deviceId, message: 'Your PAYGO meter is now activated.' });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Meter activation error:', error);
    return res.status(500).json({ success: false, error: 'Unable to activate this meter.' });
  } finally {
    client.release();
  }
});

router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.user!.userId;
    const result = await pool.query(
      `SELECT DISTINCT d.device_id AS "deviceId", d.current_balance AS balance,
              d.status, d.assignment_status AS "assignmentStatus", d.meter_purpose AS "meterPurpose",
              d.last_seen_at AS "lastSeenAt", d.last_updated AS "lastUpdated"
       FROM devices d
       WHERE d.owner_id = $1
       ORDER BY d.device_id`,
      [ownerId]
    );
    return res.json({
      success: true,
      devices: result.rows.map((row: any) => ({
        ...row,
        balance: Number(row.balance || 0),
        status: getEffectiveDeviceStatus(row.status, row.lastSeenAt),
      })),
    });
  } catch (error: any) {
    console.error('Owner device list error:', error);
    return res.status(500).json({ success: false, error: 'Unable to load your meters' });
  }
});


router.post('/:deviceId/reset-balance', async (req: AuthenticatedRequest, res: Response) => {
  const ownerId = req.user!.userId;
  const deviceId = String(req.params.deviceId || '').trim();
  if (!deviceId) {
    return res.status(400).json({ success: false, error: 'Missing meter ID' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT current_balance AS balance, status, last_seen_at AS "lastSeenAt"
       FROM devices
       WHERE device_id = $1 AND owner_id = $2
       FOR UPDATE`,
      [deviceId, ownerId]
    );

    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, code: 'METER_NOT_FOUND', error: 'Meter not found in your account' });
    }

    const meter = result.rows[0];
    const isFresh = meter.lastSeenAt &&
      Date.now() - new Date(meter.lastSeenAt).getTime() <= 30_000;
    if (meter.status !== 'ONLINE' || !isFresh) {
      await client.query(
        `UPDATE devices SET status = 'OFFLINE'
         WHERE device_id = $1 AND owner_id = $2`,
        [deviceId, ownerId]
      );
      await client.query('COMMIT');
      return res.status(409).json({
        success: false,
        code: 'DEVICE_OFFLINE',
        error: "You can't reset this meter right now because it is offline. Reconnect the meter and try again."
      });
    }

    const previousBalance = Number(meter.balance || 0);
    await client.query(
      `UPDATE devices
       SET current_balance = 0,
           balance_reset_requested_at = NOW(),
           last_updated = NOW()
       WHERE device_id = $1 AND owner_id = $2`,
      [deviceId, ownerId]
    );
    await client.query(
      `INSERT INTO device_balance_resets (device_id, owner_id, previous_balance, new_balance)
       VALUES ($1, $2, $3, 0)`,
      [deviceId, ownerId, previousBalance]
    );
    await client.query('COMMIT');

    return res.json({
      success: true,
      deviceId,
      balance: 0,
      previousBalance,
      message: 'Balance reset requested. The online meter will apply zero balance on its next HTTPS heartbeat.'
    });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Owner meter balance reset error:', error);
    return res.status(500).json({ success: false, error: 'Unable to reset meter balance' });
  } finally {
    client.release();
  }
});

router.get('/:deviceId/consumption', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.user!.userId;
    const { deviceId } = req.params;
    const period = String(req.query.period || 'week');
    const intervals: Record<string, string> = { day: '1 day', week: '7 days', month: '1 month', year: '1 year' };
    if (!intervals[period]) {
      return res.status(400).json({ success: false, error: 'Period must be day, week, month or year' });
    }

    const owned = await pool.query(
      `SELECT 1 FROM devices d
       WHERE d.device_id = $1
         AND (d.owner_id = $2 OR EXISTS (
           SELECT 1 FROM energy_sources es WHERE es.device_id = d.device_id AND es.owner_id = $2
         ) OR EXISTS (
           SELECT 1 FROM customer_connections c
           JOIN energy_sources es ON es.id = c.source_id
           WHERE es.device_id = d.device_id AND c.customer_id = $2
             AND c.status IN ('APPROVED', 'PENDING_REVISION')
             AND c.installation_confirmed_at IS NOT NULL
         )) LIMIT 1`,
      [deviceId, ownerId]
    );
    if (!owned.rows.length) {
      return res.status(404).json({ success: false, error: 'Meter not found in your account' });
    }

    const result = await pool.query(
      `SELECT date_trunc($3, recorded_at) AS date,
              SUM(kwh_consumed)::numeric(12,4) AS "kwhConsumed"
       FROM meter_readings
       WHERE device_id = $1 AND recorded_at >= NOW() - $2::interval
       GROUP BY date_trunc($3, recorded_at)
       ORDER BY date ASC`,
      [deviceId, intervals[period], period === 'year' ? 'month' : 'day']
    );
    return res.setHeader('Cache-Control', 'no-store').json({
      success: true,
      deviceId,
      period,
      readings: result.rows.map((row: any) => ({
        date: row.date,
        kwhConsumed: Number(row.kwhConsumed || 0),
      })),
    });
  } catch (error: any) {
    console.error('Owner consumption report error:', error);
    return res.status(500).json({ success: false, error: 'Unable to load consumption report' });
  }
});

router.get('/:deviceId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.user!.userId;
    const { deviceId } = req.params;
    const owned = await pool.query(
      `SELECT d.device_id AS "deviceId", d.current_balance AS balance, d.status,
              d.last_seen_at AS "lastSeenAt", d.last_updated AS "lastUpdated"
       FROM devices d
       WHERE d.device_id = $1 AND d.owner_id = $2
       LIMIT 1`,
      [deviceId, ownerId]
    );
    if (!owned.rows.length) {
      return res.status(404).json({ success: false, error: 'Meter not found in your account' });
    }

    const [txResult, readingResult] = await Promise.all([
      pool.query(
        `SELECT id, type, amount, kwh_amount, transaction_id, reference,
                hardware_status, timestamp
         FROM transactions
         WHERE device_id = $1 AND type = 'topup'
         ORDER BY timestamp DESC LIMIT 20`,
        [deviceId]
      ),
      pool.query(
        `SELECT id, kwh_consumed AS "kwhConsumed", source, recorded_at AS "recordedAt"
         FROM meter_readings
         WHERE device_id = $1
         ORDER BY recorded_at DESC LIMIT 20`,
        [deviceId]
      ),
    ]);

    const row = owned.rows[0];
    return res.setHeader('Cache-Control', 'no-store').json({
      success: true,
      deviceId: row.deviceId,
      balance: Number(row.balance || 0),
      status: getEffectiveDeviceStatus(row.status, row.lastSeenAt),
      lastSeenAt: row.lastSeenAt,
      lastUpdated: row.lastUpdated,
      transactions: txResult.rows.map((tx: any) => ({
        id: tx.id, type: tx.type, amount: Number(tx.amount || 0),
        kwhAmount: Number(tx.kwh_amount || 0), transactionId: tx.transaction_id,
        reference: tx.reference, hardwareStatus: tx.hardware_status || 'PENDING',
        timestamp: tx.timestamp,
      })),
      readings: readingResult.rows.map((reading: any) => ({
        ...reading, kwhConsumed: Number(reading.kwhConsumed),
      })),
    });
  } catch (error: any) {
    console.error('Owner device detail error:', error);
    return res.status(500).json({ success: false, error: 'Unable to load meter details' });
  }
});

export default router;
