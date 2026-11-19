import crypto from 'crypto';
import pool from '../db.js';
import dotenv from 'dotenv';

dotenv.config();

const PRICE_PER_KWH: number = parseFloat(process.env.PRICE_PER_KWH || '200');

export async function processSuccessfulPayment(reference: string, buyerEmail: string, amountPaid: number, deviceId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existingTx = await client.query(
      'SELECT id FROM transactions WHERE reference = $1 FOR UPDATE',
      [reference]
    );
    if (existingTx.rows.length > 0) {
      await client.query('ROLLBACK');
      client.release();
      return false;
    }

    const kwhAmount = amountPaid / PRICE_PER_KWH;
    const txId = `TXN_${crypto.randomUUID().substring(0, 8).toUpperCase()}`;

    await client.query(
      `INSERT INTO devices (device_id, current_balance, last_updated)
       VALUES ($1, $2, NOW())
       ON CONFLICT (device_id)
       DO UPDATE SET current_balance = devices.current_balance + $2, last_updated = NOW()`,
      [deviceId, kwhAmount]
    );

    try {
      await client.query(
        `INSERT INTO transactions
         (device_id, type, amount, kwh_amount, transaction_id, reference, hardware_status, last_attempt_at)
         VALUES ($1, 'topup', $2, $3, $4, $5, 'PENDING', NOW())`,
        [deviceId, amountPaid, kwhAmount, txId, reference]
      );

      const mktRes = await client.query(
        `SELECT id, listing_id, kwh_requested
         FROM marketplace_purchases
         WHERE device_id = $1 AND status = 'RESERVED'
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [deviceId]
      );
      if (mktRes.rows.length > 0) {
        const purchase = mktRes.rows[0];
        const requestedKwh = parseFloat(purchase.kwh_requested);
        await client.query(
          `UPDATE marketplace_purchases
           SET status = 'COMPLETED', paystack_reference = $1, updated_at = NOW()
           WHERE id = $2`,
          [reference, purchase.id]
        );
        await client.query(
          `UPDATE energy_listings
           SET available_kwh = GREATEST(0, available_kwh - $1),
               reserved_kwh = GREATEST(0, reserved_kwh - $1),
               status = CASE WHEN (available_kwh - $1) <= 0 THEN 'SOLD_OUT' ELSE status END,
               updated_at = NOW()
           WHERE id = $2`,
          [requestedKwh, purchase.listing_id]
        );
      }
    } catch (dbError: any) {
      if (dbError.code === '23505') {
        await client.query('ROLLBACK');
        client.release();
        return false;
      }
      throw dbError;
    }

    await client.query('COMMIT');
    client.release();
    console.log(`Financial top-up committed for ${deviceId}; transaction ${txId}`);
    // The current ESP32 firmware obtains credits through HTTPS heartbeat/balance sync.
    // No keypad token, SMS redemption, or MQTT command is required.
    return true;
  } catch (error) {
    console.error('Payment processing error:', error);
    try { await client.query('ROLLBACK'); } catch (rollbackError) {
      console.error('Failed to roll back payment transaction:', rollbackError);
    }
    client.release();
    throw error;
  }
}
