import express, { Request, Response } from 'express';
import pool from '../db.js';
import { Transaction } from '../types/index.js';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/authMiddleware.js';

const router = express.Router();
const PRICE_PER_KWH = parseFloat(process.env.PRICE_PER_KWH || '200');

router.get('/reset-offline', async (req: Request, res: Response) => {
  try {
    await pool.query("UPDATE devices SET status = 'OFFLINE', last_seen_at = NULL WHERE device_id = 'DEVICE-001'");
    res.json({ success: true, message: "DEVICE-001 has been reset to OFFLINE. You can safely remove this endpoint." });
  } catch (error: any) {
    console.error('Reset error:', error);
    res.status(500).json({ success: false, error: error?.message || 'Failed to reset device' });
  }
});

router.all('/reset-all', async (req: Request, res: Response) => {
  try {
    await pool.query('TRUNCATE TABLE transactions RESTART IDENTITY CASCADE;');
    await pool.query('TRUNCATE TABLE marketplace_purchases RESTART IDENTITY CASCADE;');
    await pool.query("UPDATE devices SET current_balance = 0, status = 'OFFLINE', last_seen_at = NULL, last_updated = NOW(); DELETE FROM devices WHERE device_id = 'reset-all';");
    return res.json({
      success: true,
      message: "Successfully cleared all transactions and reset device balances to 0 kWh."
    });
  } catch (error: any) {
    console.error('Reset all error:', error);
    return res.status(500).json({ success: false, error: error?.message || 'Failed to reset database' });
  }
});

router.get('/mine', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Authentication required.' });
  }

  try {
    const result = await pool.query(
      `SELECT d.device_id AS "deviceId", d.current_balance AS balance, d.status,
              d.last_seen_at AS "lastSeenAt", d.last_updated AS "lastUpdated",
              ud.is_selected AS "isSelected"
       FROM user_devices ud
       JOIN devices d ON d.device_id = ud.device_id
       WHERE ud.user_id = $1 AND d.is_demo = false
       ORDER BY ud.is_selected DESC, ud.linked_at ASC`,
      [req.user.userId]
    );

    return res.json({
      success: true,
      devices: result.rows.map((device) => ({
        ...device,
        balance: Number(device.balance),
        status: device.status || 'OFFLINE',
      })),
      selectedDeviceId: result.rows.find((device) => device.isSelected)?.deviceId ?? null,
    });
  } catch (error) {
    console.error('Failed to retrieve account devices:', error);
    return res.status(500).json({ success: false, error: 'Failed to retrieve account devices.' });
  }
});

router.put('/mine/selected', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Authentication required.' });
  }

  const deviceId = typeof req.body.deviceId === 'string' ? req.body.deviceId.trim() : '';
  if (!deviceId) {
    return res.status(400).json({ success: false, error: 'A device ID is required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const links = await client.query<{ device_id: string }>(
      `SELECT ud.device_id
       FROM user_devices ud
       JOIN devices d ON d.device_id = ud.device_id
       WHERE ud.user_id = $1 AND d.is_demo = false
       FOR UPDATE OF ud`,
      [req.user.userId]
    );

    if (!links.rows.some((link) => link.device_id === deviceId)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, error: 'This meter is not linked to your account.' });
    }

    await client.query(
      'UPDATE user_devices SET is_selected = (device_id = $1) WHERE user_id = $2',
      [deviceId, req.user.userId]
    );
    await client.query('COMMIT');

    return res.json({ success: true, selectedDeviceId: deviceId });
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError) => {
      console.error('Failed to rollback selected meter update:', rollbackError);
    });
    console.error('Failed to select account meter:', error);
    return res.status(500).json({ success: false, error: 'Failed to select meter.' });
  } finally {
    client.release();
  }
});

router.get('/:deviceId', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  let client;

  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required.' });
    }

    const deviceId = req.params.deviceId as string;

    if (!deviceId || typeof deviceId !== 'string' || deviceId.trim().length < 3) {
      return res.status(400).json({
        success: false,
        error: 'Invalid device ID specification',
      });
    }

    if (req.user.role !== 'OWNER') {
      const access = await pool.query(
        'SELECT 1 FROM user_devices WHERE user_id = $1 AND device_id = $2',
        [req.user.userId, deviceId]
      );
      if (access.rows.length === 0) {
        return res.status(403).json({ success: false, error: 'This meter is not linked to your account.' });
      }
    }

    // Acquire a dedicated connection thread to maintain atomicity across our dual queries
    client = await pool.connect();

    // STEP 1: Initialize transaction boundary
    await client.query('BEGIN');

    // STEP 2: Atomic Upsert Pattern. Ensures device creation or retrieval in 1 statement.
    const balanceResult = await client.query<{ current_balance: any; status: string; last_seen_at: any; last_updated: any }>(
      `INSERT INTO devices (device_id, current_balance, status) 
       VALUES ($1, 0, 'OFFLINE')
       ON CONFLICT (device_id) 
       DO UPDATE SET last_updated = NOW() -- Soft modification to trigger output mapping
       RETURNING current_balance, status, last_seen_at, last_updated`,
      [deviceId]
    );

    const balance = parseFloat(balanceResult.rows[0].current_balance.toString());
    const rawStatus = balanceResult.rows[0].status || 'OFFLINE';
    const lastSeenAt = balanceResult.rows[0].last_seen_at;
    const lastUpdated = balanceResult.rows[0].last_updated;

    // OFFLINE staleness check — if the device hasn't sent a heartbeat in >30s
    // it is effectively offline even if the DB row still says ONLINE.
    // OFFLINE staleness threshold — reduced to 12s for fast offline detection
    const HEARTBEAT_TTL_MS = 12_000;
    let status = rawStatus;
    if (rawStatus === 'ONLINE') {
      const msAgo = lastSeenAt
        ? Date.now() - new Date(lastSeenAt).getTime()
        : Infinity;
      if (msAgo > HEARTBEAT_TTL_MS) {
        status = 'OFFLINE';
        // Persist the corrected status inside the open transaction
        await client.query(
          `UPDATE devices SET status = 'OFFLINE', last_updated = NOW() WHERE device_id = $1`,
          [deviceId]
        );
      }
    }

    // STEP 3: Execute ledger history slice extraction inside the locked transaction timeline
    const txResult = await client.query<Transaction>(
      `SELECT id, type, amount, kwh_amount, transaction_id, reference, hardware_status, timestamp 
       FROM transactions 
       WHERE device_id = $1 
       ORDER BY timestamp DESC 
       LIMIT 20`,
      [deviceId]
    );

    const transactions = txResult.rows.map((row: any) => ({
      id: row.id,
      type: row.type,
      amount: parseFloat(row.amount || 0),
      kwhAmount: parseFloat(row.kwh_amount || 0),
      transactionId: row.transaction_id,
      reference: row.reference,
      hardwareStatus: row.hardware_status || 'PENDING',
      timestamp: row.timestamp,
    }));

    // STEP 4: Commit changes to close database connection locks
    await client.query('COMMIT');
    client.release();
    client = undefined;

    return res.json({
      success: true,
      deviceId,
      balance,
      status,
      lastSeenAt,
      lastUpdated,
      transactions,
    });

  } catch (error: any) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Failed to issue transaction rollback:', rollbackErr);
      }
      try {
        client.release();
      } catch (releaseErr) {}
    }

    console.error('CRITICAL: Device profile synchronization failure:', error);
    return res.status(500).json({
      success: false,
      error: error?.message || 'Internal service synchronization failure',
      code: error?.code,
      detail: error?.detail,
      hint: error?.hint,
    });
  }
});

/**
 * HTTP FALLBACK ENDPOINTS FOR HARDWARE (ESP32)
 * Used when MQTT connection is offline or unavailable.
 */

// Balance Retrieval: GET /api/devices/:deviceId/balance
router.get('/:deviceId/balance', async (req: Request, res: Response) => {
  try {
    const deviceId = req.params.deviceId as string;
    if (!deviceId) {
      return res.status(400).json({ success: false, error: 'Missing device ID' });
    }

    const devRes = await pool.query(
      'SELECT current_balance, status FROM devices WHERE device_id = $1',
      [deviceId]
    );

    if (devRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }

    const balance = parseFloat(devRes.rows[0].current_balance);
    return res.json({
      success: true,
      deviceId,
      balance,
      status: devRes.rows[0].status,
    });
  } catch (err: any) {
    console.error('Error fetching device balance:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Server error' });
  }
});

// Balance Sync: PUT / POST /api/devices/:deviceId/balance
const handleBalanceUpdate = async (req: Request, res: Response) => {
  const deviceId = req.params.deviceId as string;
  const rawBalance = req.body.balance !== undefined ? req.body.balance : req.body.remaining_balance;
  const expected = typeof req.body.expected === 'number' && isFinite(req.body.expected) ? req.body.expected : null;

  if (!deviceId) {
    return res.status(400).json({ success: false, error: 'Missing device ID' });
  }

  if (typeof rawBalance !== 'number' || !isFinite(rawBalance) || rawBalance < 0) {
    return res.status(400).json({ success: false, error: 'Invalid balance value. Must be a non-negative number.' });
  }

  const newBalance = Math.max(0, rawBalance);
  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Acquire exclusive lock on device row
    const deviceRes = await client.query(
      'SELECT current_balance, status FROM devices WHERE device_id = $1 FOR UPDATE',
      [deviceId]
    );

    let currentServerBalance = 0;
    if (deviceRes.rows.length === 0) {
      await client.query(
        'INSERT INTO devices (device_id, current_balance, status, last_seen_at, last_updated) VALUES ($1, $2, \'ONLINE\', NOW(), NOW())',
        [deviceId, newBalance]
      );
      currentServerBalance = newBalance;
    } else {
      currentServerBalance = parseFloat(deviceRes.rows[0].current_balance);
    }

    // Check for conflict if expected balance was specified by hardware
    const EPSILON = 0.005; // 5 Wh tolerance
    if (expected !== null && Math.abs(currentServerBalance - expected) > EPSILON) {
      // Server balance has changed (e.g. top-up was processed or manual admin adjustment)
      await client.query(
        'UPDATE devices SET status = \'ONLINE\', last_seen_at = NOW(), last_updated = NOW() WHERE device_id = $1',
        [deviceId]
      );
      await client.query('COMMIT');
      client.release();
      client = undefined;

      console.log(`⚠️ Balance push conflict for ${deviceId}: expected ${expected}, server has ${currentServerBalance}. Returning 409.`);
      return res.status(409).json({
        success: false,
        conflict: true,
        balance: currentServerBalance,
        message: 'Server balance changed (e.g. top-up). Adopt server balance and retry.',
      });
    }

    // No conflict: persist updated balance
    await client.query(
      'UPDATE devices SET current_balance = $1, status = \'ONLINE\', last_seen_at = NOW(), last_updated = NOW() WHERE device_id = $2',
      [newBalance, deviceId]
    );

    // Calculate energy consumed
    const kwhConsumed = expected !== null
      ? Math.max(0, expected - newBalance)
      : Math.max(0, currentServerBalance - newBalance);

    if (kwhConsumed >= 0.001) {
      await client.query(
        'INSERT INTO transactions (device_id, type, amount, kwh_amount, hardware_status) VALUES ($1, \'consumption\', $2, $3, \'CONFIRMED\')',
        [deviceId, -(kwhConsumed * PRICE_PER_KWH), kwhConsumed]
      );
    }

    // A validated expected balance or an exact balance match confirms hardware has synced credits.
    if (expected !== null || Math.abs(currentServerBalance - newBalance) <= EPSILON) {
      await client.query(
        'UPDATE transactions SET hardware_status = \'CONFIRMED\' WHERE device_id = $1 AND type = \'topup\' AND hardware_status = \'PENDING\'',
        [deviceId]
      );
    }

    await client.query('COMMIT');
    client.release();
    client = undefined;

    console.log(`✅ Balance sync for ${deviceId}: updated to ${newBalance} kWh (deducted ${kwhConsumed.toFixed(4)} kWh)`);

    return res.status(200).json({
      success: true,
      deviceId,
      balance: newBalance,
      kwhDeducted: kwhConsumed,
      relayAction: newBalance > 0 ? 'OPEN' : 'CLOSE',
    });
  } catch (err: any) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      client.release();
    }
    console.error('Balance sync error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Server error' });
  }
};

router.put('/:deviceId/balance', handleBalanceUpdate);
router.post('/:deviceId/balance', handleBalanceUpdate);

// 1. Heartbeat / Sync: Hardware reports its remaining balance (hardware is authoritative).
//    - If the device sends `remaining_balance`, it is written directly to current_balance.
//    - On first boot (no NVS), the firmware omits remaining_balance so the server seeds it.
//    - pendingCredits (new top-ups) flow back down so the hardware can apply them locally.
router.post('/:deviceId/heartbeat', async (req: Request, res: Response) => {
  try {
    const deviceId = req.params.deviceId as string;
    const { remaining_balance } = req.body;

    if (!deviceId) {
      return res.status(400).json({ success: false, error: 'Missing device ID' });
    }

    const hasHardwareBalance =
      typeof remaining_balance === 'number' && isFinite(remaining_balance) && remaining_balance >= 0;

    if (hasHardwareBalance) {
      await pool.query(
        `UPDATE transactions
         SET hardware_status = 'CONFIRMED'
         WHERE device_id = $1 AND type = 'topup' AND hardware_status = 'PENDING'
           AND ABS($2::numeric - (
             SELECT current_balance FROM devices WHERE device_id = $1
           )) <= 0.005`,
        [deviceId, remaining_balance]
      );

      // Hardware is authoritative — write its reported balance directly to the DB
      await pool.query(
        `INSERT INTO devices (device_id, current_balance, status, last_seen_at, last_updated)
         VALUES ($1, $2, 'ONLINE', NOW(), NOW())
         ON CONFLICT (device_id)
         DO UPDATE SET status = 'ONLINE', last_seen_at = NOW(), last_updated = NOW(),
                       current_balance = EXCLUDED.current_balance`,
        [deviceId, remaining_balance]
      );
    } else {
      // First boot / no balance reported — just mark ONLINE; server keeps its stored balance
      await pool.query(
        `INSERT INTO devices (device_id, current_balance, status, last_seen_at, last_updated)
         VALUES ($1, 0, 'ONLINE', NOW(), NOW())
         ON CONFLICT (device_id)
         DO UPDATE SET status = 'ONLINE', last_seen_at = NOW(), last_updated = NOW()`,
        [deviceId]
      );
    }

    const devRes = await pool.query('SELECT current_balance FROM devices WHERE device_id = $1', [deviceId]);
    const balance = devRes.rows.length > 0 ? parseFloat(devRes.rows[0].current_balance) : 0;

    const pendingRes = await pool.query(
      `SELECT transaction_id AS "transactionId", kwh_amount AS "kwhAmount"
       FROM transactions
       WHERE device_id = $1 AND type = 'topup' AND hardware_status = 'PENDING'
       ORDER BY timestamp ASC`,
      [deviceId]
    );

    return res.json({
      success: true,
      deviceId,
      status: 'ONLINE',
      balance,
      relayAction: balance > 0 ? 'OPEN' : 'CLOSE',
      pendingCredits: pendingRes.rows.map((r: any) => ({
        transactionId: r.transactionId,
        kwh: parseFloat(r.kwhAmount),
      })),
    });
  } catch (err: any) {
    console.error('Hardware heartbeat error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Server error' });
  }
});

// 2. Hardware Credit ACK via HTTP
router.post('/:deviceId/ack', async (req: Request, res: Response) => {
  try {
    const deviceId = req.params.deviceId as string;
    const { transactionId, status, reason } = req.body;

    if (!deviceId || !transactionId) {
      return res.status(400).json({ success: false, error: 'Missing deviceId or transactionId' });
    }

    if (status === 'ACCEPTED') {
      await pool.query(
        `UPDATE transactions SET hardware_status = 'CONFIRMED' WHERE transaction_id = $1`,
        [transactionId]
      );
      await pool.query(
        `UPDATE devices SET status = 'ONLINE', last_seen_at = NOW(), last_updated = NOW() WHERE device_id = $1`,
        [deviceId]
      );
      return res.json({ success: true, message: 'Hardware credit confirmed' });
    } else if (status === 'REJECTED') {
      await pool.query(
        `UPDATE transactions SET hardware_status = 'FAILED' WHERE transaction_id = $1`,
        [transactionId]
      );
      return res.json({ success: true, message: `Hardware credit rejected: ${reason || 'Unknown'}` });
    }

    return res.status(400).json({ success: false, error: 'Invalid status. Must be ACCEPTED or REJECTED' });
  } catch (err: any) {
    console.error('Hardware ACK error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Server error' });
  }
});

// 3. Energy Consumption Report via HTTP
router.post('/:deviceId/energy', async (req: Request, res: Response) => {
  const deviceId = req.params.deviceId as string;
  const { wh_consumed } = req.body;

  if (typeof wh_consumed !== 'number' || wh_consumed <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid wh_consumed value' });
  }

  const kwhConsumed = wh_consumed / 1000;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const deviceRes = await client.query(
      `SELECT current_balance FROM devices WHERE device_id = $1 FOR UPDATE`,
      [deviceId]
    );

    if (deviceRes.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ success: false, error: 'Device record not found' });
    }

    const currentBalance = parseFloat(deviceRes.rows[0].current_balance);
    const newBalance = Math.max(0, currentBalance - kwhConsumed);

    await client.query(
      `UPDATE devices SET current_balance = $1, status = 'ONLINE', last_seen_at = NOW(), last_updated = NOW() WHERE device_id = $2`,
      [newBalance, deviceId]
    );

    await client.query(
      `INSERT INTO transactions (device_id, type, amount, kwh_amount) VALUES ($1, 'consumption', $2, $3)`,
      [deviceId, -(kwhConsumed * PRICE_PER_KWH), kwhConsumed]
    );

    await client.query('COMMIT');
    client.release();

    const relayAction = newBalance <= 0 ? 'CLOSE' : 'KEEP_OPEN';
    return res.json({
      success: true,
      balance: newBalance,
      kwhDeducted: kwhConsumed,
      relayAction,
    });
  } catch (err: any) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    client.release();
    console.error('Hardware energy report error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Server error' });
  }
});

export default router;
