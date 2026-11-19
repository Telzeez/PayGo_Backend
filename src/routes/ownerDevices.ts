import express, { Response } from 'express';
import pool from '../db.js';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/authMiddleware.js';

const router = express.Router();
router.use(authenticateToken);

router.post('/claim', async (req: AuthenticatedRequest, res: Response) => {
  const ownerId = req.user!.userId;
  const deviceId = String(req.body?.deviceId || '').trim();

  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,49}$/.test(deviceId)) {
    return res.status(400).json({ success: false, error: 'Enter a valid meter device ID (3–50 letters, numbers, hyphens or underscores).' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO devices (device_id, owner_id, current_balance, status)
       VALUES ($1, $2, 0, 'OFFLINE')
       ON CONFLICT (device_id)
       DO UPDATE SET owner_id = COALESCE(devices.owner_id, EXCLUDED.owner_id)
       WHERE devices.owner_id IS NULL OR devices.owner_id = EXCLUDED.owner_id
       RETURNING device_id AS "deviceId", current_balance AS balance, status,
                 last_seen_at AS "lastSeenAt", last_updated AS "lastUpdated"`,
      [deviceId, ownerId]
    );

    if (!result.rows.length) {
      return res.status(409).json({ success: false, error: 'This meter is already assigned to another account.' });
    }

    return res.status(201).json({
      success: true,
      device: { ...result.rows[0], balance: Number(result.rows[0].balance || 0) },
      message: 'Meter connected to your account.',
    });
  } catch (error: any) {
    console.error('Meter claim error:', error);
    return res.status(500).json({ success: false, error: 'Unable to connect this meter right now.' });
  }
});

router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.user!.userId;
    const result = await pool.query(
      `SELECT DISTINCT d.device_id AS "deviceId", d.current_balance AS balance,
              d.status, d.last_seen_at AS "lastSeenAt", d.last_updated AS "lastUpdated"
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
      Date.now() - new Date(meter.lastSeenAt).getTime() <= 12000;
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
    const intervals: Record<string, string> = { day: '1 day', week: '7 days', month: '1 month' };
    if (!intervals[period]) {
      return res.status(400).json({ success: false, error: 'Period must be day, week or month' });
    }

    const owned = await pool.query(
      `SELECT 1 FROM devices d
       WHERE d.device_id = $1
         AND (d.owner_id = $2 OR EXISTS (
           SELECT 1 FROM energy_sources es WHERE es.device_id = d.device_id AND es.owner_id = $2
         )) LIMIT 1`,
      [deviceId, ownerId]
    );
    if (!owned.rows.length) {
      return res.status(404).json({ success: false, error: 'Meter not found in your account' });
    }

    const result = await pool.query(
      `SELECT date_trunc('day', recorded_at) AS date,
              SUM(kwh_consumed)::numeric(12,4) AS "kwhConsumed"
       FROM meter_readings
       WHERE device_id = $1 AND recorded_at >= NOW() - $2::interval
       GROUP BY date_trunc('day', recorded_at)
       ORDER BY date ASC`,
      [deviceId, intervals[period]]
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
      status: row.status || 'OFFLINE',
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
