import express, { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import pool from '../db.js';
import { Device, Transaction } from '../types/index.js';

const router = express.Router();

router.get('/reset-offline', async (req: Request, res: Response) => {
  try {
    await pool.query("UPDATE devices SET status = 'OFFLINE', last_seen_at = NULL WHERE device_id = 'DEVICE-001'");
    res.json({ success: true, message: "DEVICE-001 has been reset to OFFLINE. You can safely remove this endpoint." });
  } catch (error: any) {
    console.error('Reset error:', error);
    res.status(500).json({ success: false, error: error?.message || 'Failed to reset device' });
  }
});

router.get('/:deviceId', async (req: Request, res: Response) => {
  let client;

  try {
    const deviceId = req.params.deviceId as string;

    if (!deviceId || typeof deviceId !== 'string' || deviceId.trim().length < 3) {
      return res.status(400).json({
        success: false,
        error: 'Invalid device ID specification',
      });
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
    const HEARTBEAT_TTL_MS = 30_000;
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

router.get('/:deviceId/tokens', async (req: Request, res: Response) => {
  try {
    const deviceId = req.params.deviceId as string;

    if (!deviceId) {
      return res.status(400).json({ success: false, error: 'Missing device ID' });
    }

    const result = await pool.query(
      `SELECT id, kwh_amount, expires_at, used, auto_credited, transaction_id, created_at
       FROM paygo_tokens 
       WHERE device_id = $1 
       ORDER BY created_at DESC 
       LIMIT 10`,
      [deviceId]
    );

    const tokens = result.rows.map((row) => ({
      id: row.id,
      kwhAmount: parseFloat(row.kwh_amount),
      expiresAt: row.expires_at,
      used: row.used,
      autoCredited: row.auto_credited,
      transactionId: row.transaction_id,
      createdAt: row.created_at,
    }));

    return res.json({
      success: true,
      deviceId,
      tokens,
    });
  } catch (error) {
    console.error('Error fetching device tokens:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch tokens' });
  }
});

/**
 * HTTP FALLBACK ENDPOINTS FOR HARDWARE (ESP32)
 * Used when MQTT connection is offline or unavailable.
 */

// 1. Heartbeat / Sync: Returns device status, current balance, and any unacknowledged pending credits
router.post('/:deviceId/heartbeat', async (req: Request, res: Response) => {
  try {
    const deviceId = req.params.deviceId as string;

    if (!deviceId) {
      return res.status(400).json({ success: false, error: 'Missing device ID' });
    }

    await pool.query(
      `INSERT INTO devices (device_id, current_balance, status, last_seen_at, last_updated)
       VALUES ($1, 0, 'ONLINE', NOW(), NOW())
       ON CONFLICT (device_id)
       DO UPDATE SET status = 'ONLINE', last_seen_at = NOW(), last_updated = NOW()`,
      [deviceId]
    );

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
      `INSERT INTO transactions (device_id, type, amount, kwh_amount) VALUES ($1, 'consumption', 0, $2)`,
      [deviceId, kwhConsumed]
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

// 4. Keypad Token Redemption via HTTP
router.post('/:deviceId/redeem', async (req: Request, res: Response) => {
  const deviceId = req.params.deviceId as string;
  const { code } = req.body;

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing token code' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT id, token_hash, kwh_amount, auto_credited, transaction_id 
       FROM paygo_tokens 
       WHERE device_id = $1 AND used = false AND expires_at > NOW()
       ORDER BY created_at DESC 
       FOR UPDATE`,
      [deviceId]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ success: false, error: 'No valid tokens found' });
    }

    let matchedTokenRow: any = null;
    for (const row of result.rows) {
      const isMatch = await bcrypt.compare(code, row.token_hash);
      if (isMatch) {
        matchedTokenRow = row;
        break;
      }
    }

    if (!matchedTokenRow) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({ success: false, error: 'Invalid or expired token code' });
    }

    const tokenId = matchedTokenRow.id;
    const kwhAmount = parseFloat(matchedTokenRow.kwh_amount);
    const autoCredited = matchedTokenRow.auto_credited === true;
    const txId = matchedTokenRow.transaction_id || `TXN_${crypto.randomUUID().substring(0, 8).toUpperCase()}`;

    await client.query(`UPDATE paygo_tokens SET used = true, redeemed_at = NOW() WHERE id = $1`, [tokenId]);

    let newBalance = 0;
    if (autoCredited) {
      const devRes = await client.query('SELECT current_balance FROM devices WHERE device_id = $1', [deviceId]);
      newBalance = devRes.rows.length > 0 ? parseFloat(devRes.rows[0].current_balance) : 0;
    } else {
      const updateRes = await client.query(
        `UPDATE devices SET current_balance = current_balance + $1, status = 'ONLINE', last_seen_at = NOW(), last_updated = NOW() WHERE device_id = $2 RETURNING current_balance`,
        [kwhAmount, deviceId]
      );
      newBalance = parseFloat(updateRes.rows[0].current_balance);
      await client.query(
        `INSERT INTO transactions (device_id, type, amount, kwh_amount, transaction_id, hardware_status, last_attempt_at)
         VALUES ($1, 'topup', 0, $2, $3, 'CONFIRMED', NOW())`,
        [deviceId, kwhAmount, txId]
      );
    }

    await client.query('COMMIT');
    client.release();

    return res.json({
      success: true,
      message: `${kwhAmount} kWh credited successfully`,
      kwhAdded: kwhAmount,
      balance: newBalance,
      relayAction: 'OPEN',
    });
  } catch (err: any) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    client.release();
    console.error('Hardware redeem error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Server error' });
  }
});

export default router;
