import express, { Request, Response } from 'express';
import pool from '../db.js';
import { Device, Transaction } from '../types/index.js';

const router = express.Router();

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
      transactions: txResult.rows,
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

export default router;
