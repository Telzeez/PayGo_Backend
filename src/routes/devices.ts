import express, { Request, Response } from 'express';
import pool from '../db.js';
import { Device, Transaction } from '../types/index.js';

const router = express.Router();

router.get('/reset-offline', async (req: Request, res: Response) => {
  try {
    await pool.query("UPDATE devices SET status = 'OFFLINE', last_seen_at = NULL WHERE device_id = 'DEVICE-001'");
    res.json({ success: true, message: "DEVICE-001 has been reset to OFFLINE. You can safely remove this endpoint." });
  } catch (error) {
    console.error('Reset error:', error);
    res.status(500).json({ success: false, error: 'Failed to reset device' });
  }
});

router.get('/:deviceId', async (req: Request, res: Response) => {
  // Acquire a dedicated connection thread to maintain atomicity across our dual queries
  const client = await pool.connect();

  try {
    const deviceId = req.params.deviceId as string;

    if (!deviceId || typeof deviceId !== 'string' || deviceId.trim().length < 3) {
      client.release();
      return res.status(400).json({
        success: false,
        error: 'Invalid device ID specification',
      });
    }

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
    const status = balanceResult.rows[0].status || 'OFFLINE';
    const lastSeenAt = balanceResult.rows[0].last_seen_at;
    const lastUpdated = balanceResult.rows[0].last_updated;

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

    return res.json({
      success: true,
      deviceId,
      balance,
      status,
      lastSeenAt,
      lastUpdated,
      transactions,
    });

  } catch (error) {
    // Gracefully clean database stack traces on execution exceptions
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Failed to issue transaction rollback:', rollbackErr);
    }
    client.release();

    console.error('CRITICAL: Device profile synchronization failure:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal service synchronization failure',
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

export default router;
