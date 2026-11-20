import express, { Response } from 'express';
import crypto from 'crypto';
import pool from '../db.js';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/authMiddleware.js';

const router = express.Router();
router.use(authenticateToken);

const validDeviceId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{2,49}$/.test(value.trim());

// Prosumer claims a factory/pre-registered meter using the one-time credential
// supplied with that physical unit. A device ID by itself is never sufficient.
router.post('/claim', async (req: AuthenticatedRequest, res: Response) => {
  const deviceId = String(req.body?.deviceId || '').trim();
  const claimCode = String(req.body?.claimCode || '').trim();
  const purpose = String(req.body?.purpose || '').toUpperCase();

  if (!validDeviceId(deviceId) || !/^[A-Fa-f0-9]{16,128}$/.test(claimCode) ||
      !['GENERATION', 'RECEIVING'].includes(purpose)) {
    return res.status(400).json({ success: false, error: 'Provide a valid meter ID, its one-time claim credential, and meter purpose.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const device = await client.query(
      `SELECT device_id, owner_id, assignment_status
       FROM devices WHERE device_id = $1 FOR UPDATE`,
      [deviceId]
    );
    if (!device.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'This meter is not in the PAYGO device registry. Contact PAYGO hardware provisioning.' });
    }
    if (device.rows[0].owner_id !== null || device.rows[0].assignment_status !== 'UNASSIGNED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'This meter has already been claimed or assigned.' });
    }

    const tokenHash = crypto.createHash('sha256').update(claimCode.toUpperCase()).digest('hex');
    const token = await client.query(
      `SELECT id FROM device_claim_tokens
       WHERE device_id = $1 AND token_hash = $2
         AND claimed_at IS NULL AND expires_at > NOW()
       FOR UPDATE`,
      [deviceId, tokenHash]
    );
    if (!token.rows.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, error: 'Invalid, expired, or already used meter claim credential.' });
    }

    await client.query(
      `UPDATE devices SET owner_id = $2, meter_purpose = $3,
         assignment_status = 'ACTIVATED', assigned_at = NOW(), claimed_at = NOW(),
         last_updated = NOW()
       WHERE device_id = $1 AND owner_id IS NULL`,
      [deviceId, req.user!.userId, purpose]
    );
    await client.query(
      'UPDATE device_claim_tokens SET claimed_at = NOW() WHERE id = $1',
      [token.rows[0].id]
    );
    if (purpose === 'GENERATION') {
      await client.query(
        `UPDATE users SET is_seller = TRUE, role = 'OWNER', updated_at = NOW()
         WHERE id = $1`,
        [req.user!.userId]
      );
    }
    await client.query('COMMIT');
    return res.status(201).json({
      success: true,
      deviceId,
      purpose,
      assignmentStatus: 'ACTIVATED',
      message: 'Meter successfully claimed and added to your PAYGO meter inventory.'
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Meter claim error:', error);
    return res.status(500).json({ success: false, error: 'Unable to claim this meter.' });
  } finally {
    client.release();
  }
});

// Prosumer assigns one of their available receiving meters to an approved buyer connection.
router.post('/:deviceId/assign', async (req: AuthenticatedRequest, res: Response) => {
  const deviceId = String(req.params.deviceId || '').trim();
  const connectionId = Number(req.body?.connectionId);
  if (!validDeviceId(deviceId) || !Number.isInteger(connectionId) || connectionId <= 0) {
    return res.status(400).json({ success: false, error: 'A valid meter ID and approved connection ID are required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const connection = await client.query(
      `SELECT c.id, c.customer_id, c.status, c.approved_power_w, s.owner_id
       FROM customer_connections c
       JOIN energy_sources s ON s.id = c.source_id
       WHERE c.id = $1
       FOR UPDATE OF c, s`,
      [connectionId]
    );
    if (!connection.rows.length || Number(connection.rows[0].owner_id) !== req.user!.userId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Approved connection not found in your energy sources.' });
    }
    const requestedConnection = connection.rows[0];
    if (!['APPROVED', 'PENDING_REVISION'].includes(requestedConnection.status) ||
        requestedConnection.approved_power_w === null) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'Only a connection with an approved load allocation can receive a meter.' });
    }
    if (requestedConnection.receiving_device_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'This customer connection already has a receiving meter.' });
    }

    const device = await client.query(
      `SELECT device_id, owner_id, meter_purpose, assignment_status
       FROM devices WHERE device_id = $1 FOR UPDATE`,
      [deviceId]
    );
    if (!device.rows.length || Number(device.rows[0].owner_id) !== req.user!.userId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Meter not found in your prosumer inventory.' });
    }
    if (device.rows[0].meter_purpose !== 'RECEIVING' ||
        device.rows[0].assignment_status !== 'ACTIVATED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'Only a claimed, activated receiving meter can be assigned.' });
    }

    const linked = await client.query(
      `UPDATE customer_connections SET receiving_device_id = $2, updated_at = NOW()
       WHERE id = $1 AND receiving_device_id IS NULL
         AND status IN ('APPROVED', 'PENDING_REVISION')
         AND approved_power_w IS NOT NULL`,
      [connectionId, deviceId]
    );
    if (linked.rowCount !== 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'The connection or meter was assigned concurrently. Refresh and try again.' });
    }
    await client.query('COMMIT');
    return res.json({
      success: true,
      deviceId,
      connectionId,
      customerId: requestedConnection.customer_id,
      message: 'Receiving meter assigned. It remains in your prosumer inventory; the buyer can now view its readings.'
    });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => {});
    if (error?.code === '23505') {
      return res.status(409).json({ success: false, error: 'This receiving meter is already assigned to another active customer connection.' });
    }
    console.error('Receiving meter assignment error:', error);
    return res.status(500).json({ success: false, error: 'Unable to assign this receiving meter.' });
  } finally {
    client.release();
  }
});

// Owners see all their meters; buyers see only meters linked to their own connections.
router.get('/me', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [owned, customer] = await Promise.all([
      pool.query(
        `SELECT d.device_id AS "deviceId", d.meter_purpose AS purpose,
                d.assignment_status AS "assignmentStatus", d.status,
                d.current_balance AS balance, d.last_seen_at AS "lastSeenAt",
                d.firmware_version AS "firmwareVersion",
                c.id AS "connectionId", c.customer_id AS "customerId",
                u.email AS "customerEmail", c.status AS "connectionStatus"
         FROM devices d
         LEFT JOIN customer_connections c
           ON c.receiving_device_id = d.device_id
          AND c.status IN ('APPROVED', 'PENDING_REVISION')
         LEFT JOIN users u ON u.id = c.customer_id
         WHERE d.owner_id = $1
         ORDER BY d.device_id`,
        [req.user!.userId]
      ),
      pool.query(
        `SELECT d.device_id AS "deviceId", d.meter_purpose AS purpose,
                d.assignment_status AS "assignmentStatus", d.status,
                d.current_balance AS balance, d.last_seen_at AS "lastSeenAt",
                c.id AS "connectionId", s.name AS "sourceName",
                s.owner_id AS "prosumerId"
         FROM customer_connections c
         JOIN devices d ON d.device_id = c.receiving_device_id
         JOIN energy_sources s ON s.id = c.source_id
         WHERE c.customer_id = $1
           AND c.status IN ('APPROVED', 'PENDING_REVISION')
         ORDER BY c.updated_at DESC`,
        [req.user!.userId]
      )
    ]);
    return res.setHeader('Cache-Control', 'no-store').json({
      success: true,
      ownedMeters: owned.rows.map((row: any) => ({ ...row, balance: Number(row.balance || 0) })),
      customerMeters: customer.rows.map((row: any) => ({ ...row, balance: Number(row.balance || 0) }))
    });
  } catch (error) {
    console.error('Meter inventory error:', error);
    return res.status(500).json({ success: false, error: 'Unable to load meter inventory.' });
  }
});

// Shared detail endpoint, but access is scoped to the prosumer or the assigned buyer.
router.get('/:deviceId', async (req: AuthenticatedRequest, res: Response) => {
  const deviceId = String(req.params.deviceId || '').trim();
  if (!validDeviceId(deviceId)) return res.status(400).json({ success: false, error: 'Invalid meter ID.' });
  try {
    const access = await pool.query(
      `SELECT d.device_id AS "deviceId", d.meter_purpose AS purpose,
              d.assignment_status AS "assignmentStatus", d.status,
              d.current_balance AS balance, d.last_seen_at AS "lastSeenAt",
              d.last_updated AS "lastUpdated",
              EXISTS (SELECT 1 FROM customer_connections c
                WHERE c.receiving_device_id = d.device_id
                  AND c.customer_id = $2
                  AND c.status IN ('APPROVED', 'PENDING_REVISION')) AS "isAssignedBuyer"
       FROM devices d
       WHERE d.device_id = $1
         AND (d.owner_id = $2 OR EXISTS (
           SELECT 1 FROM customer_connections c
           WHERE c.receiving_device_id = d.device_id
             AND c.customer_id = $2
             AND c.status IN ('APPROVED', 'PENDING_REVISION')
         ))
       LIMIT 1`,
      [deviceId, req.user!.userId]
    );
    if (!access.rows.length) return res.status(404).json({ success: false, error: 'Meter not found in your account.' });

    const [transactions, readings] = await Promise.all([
      pool.query(
        `SELECT id, type, amount, kwh_amount AS "kwhAmount", transaction_id AS "transactionId",
                reference, hardware_status AS "hardwareStatus", timestamp
         FROM transactions WHERE device_id = $1
         ORDER BY timestamp DESC LIMIT 30`,
        [deviceId]
      ),
      pool.query(
        `SELECT id, kwh_consumed AS "kwhConsumed", source, recorded_at AS "recordedAt"
         FROM meter_readings WHERE device_id = $1
         ORDER BY recorded_at DESC LIMIT 30`,
        [deviceId]
      )
    ]);
    return res.setHeader('Cache-Control', 'no-store').json({
      success: true,
      meter: { ...access.rows[0], balance: Number(access.rows[0].balance || 0) },
      transactions: transactions.rows,
      readings: readings.rows.map((row: any) => ({ ...row, kwhConsumed: Number(row.kwhConsumed || 0) }))
    });
  } catch (error) {
    console.error('Meter detail error:', error);
    return res.status(500).json({ success: false, error: 'Unable to load meter details.' });
  }
});

export default router;
