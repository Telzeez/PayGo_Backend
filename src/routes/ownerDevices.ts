import express, { Response } from 'express';
import pool from '../db.js';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/authMiddleware.js';

const router = express.Router();
router.use(authenticateToken);

router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.user!.userId;
    const result = await pool.query(
      `SELECT DISTINCT d.device_id AS "deviceId", d.current_balance AS balance,
              d.status, d.last_seen_at AS "lastSeenAt", d.last_updated AS "lastUpdated"
       FROM devices d
       LEFT JOIN energy_sources es ON es.device_id = d.device_id
       WHERE d.owner_id = $1 OR es.owner_id = $1
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

router.get('/:deviceId/consumption', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.user!.userId;
    const { deviceId } = req.params;
    const period = String(req.query.period || 'week');
    const intervals: Record<string, string> = { day: '1 day', week: '7 days', month: '30 days' };
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
