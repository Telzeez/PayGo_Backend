import crypto from 'crypto';
import pool from '../db.js';
import mqttService from '../mqtt-client.js';
import dotenv from 'dotenv';

dotenv.config();

const PRICE_PER_KWH: number = parseFloat(process.env.PRICE_PER_KWH || '200');

export async function processSuccessfulPayment(
  reference: string,
  amountPaid: number,
  deviceId: string,
  marketplacePurchaseId?: number
): Promise<boolean> {
  const client = await pool.connect();

  try {
    // STEP 1: START THE TRANSACTION
    await client.query('BEGIN');

    // STEP 2: Idempotency Check
    const existingTx = await client.query(
      'SELECT id FROM transactions WHERE reference = $1 FOR UPDATE',
      [reference]
    );

    if (existingTx.rows.length > 0) {
      console.log(`Duplicate payment verification received. Reference ${reference} already processed.`);
      await client.query('ROLLBACK');
      client.release();
      return false; // Already processed
    }

    const kwhAmount: number = amountPaid / PRICE_PER_KWH;
    const txId = `TXN_${crypto.randomUUID().substring(0, 8).toUpperCase()}`;

    // STEP 3: Financial Credit to DB Balance (Upsert device)
    await client.query(
      `INSERT INTO devices (device_id, current_balance, last_updated)
       VALUES ($1, $2, NOW())
       ON CONFLICT (device_id)
       DO UPDATE SET current_balance = devices.current_balance + $2, last_updated = NOW()`,
      [deviceId, kwhAmount]
    );

    // STEP 4: Insert transaction record
    try {
      await client.query(
        `INSERT INTO transactions 
         (device_id, type, amount, kwh_amount, transaction_id, reference, hardware_status, last_attempt_at) 
         VALUES ($1, 'topup', $2, $3, $4, $5, 'PENDING', NOW())`,
        [deviceId, amountPaid, kwhAmount, txId, reference]
      );

      if (marketplacePurchaseId !== undefined) {
        const mktRes = await client.query(
          `SELECT id, listing_id, kwh_requested
           FROM marketplace_purchases
           WHERE id = $1 AND device_id = $2 AND amount = $3 AND status = 'RESERVED'
           FOR UPDATE`,
          [marketplacePurchaseId, deviceId, amountPaid]
        );
        if (mktRes.rows.length === 0) {
          throw new Error(`Marketplace purchase ${marketplacePurchaseId} is not valid for this payment`);
        }
        const mktPurchase = mktRes.rows[0];
        const kwhReq = parseFloat(mktPurchase.kwh_requested);

        // Update purchase record to COMPLETED
        await client.query(
          `UPDATE marketplace_purchases 
           SET status = 'COMPLETED', paystack_reference = $1, updated_at = NOW() 
           WHERE id = $2`,
          [reference, mktPurchase.id]
        );

        // Reconcile reserved_kwh and available_kwh on the energy listing
        await client.query(
          `UPDATE energy_listings 
           SET available_kwh = GREATEST(0, available_kwh - $1),
               reserved_kwh = GREATEST(0, reserved_kwh - $1),
               status = CASE WHEN (available_kwh - $1) <= 0 THEN 'SOLD_OUT' ELSE status END,
               updated_at = NOW()
           WHERE id = $2`,
          [kwhReq, mktPurchase.listing_id]
        );

        console.log(`✅ Marketplace purchase #${mktPurchase.id} settled. Energy deducted: ${kwhReq} kWh.`);
      }

    } catch (dbError: any) {
      if (dbError.code === '23505') { 
        console.log(`Race condition caught. Reference ${reference} processed concurrently.`);
        await client.query('ROLLBACK');
        client.release();
        return false;
      }
      throw dbError;
    }

    // Commit the payment before dispatching the remote hardware credit.
    await client.query('COMMIT');
    client.release();

    console.log(`✅ Financial transaction committed for ${deviceId}. txId: ${txId}, reference: ${reference}`);

    // STEP 8: POST-COMMIT MQTT CREDIT COMMAND DISPATCH
    mqttService.publishCreditCommand(deviceId, kwhAmount, txId);

    return true;

  } catch (error) {
    console.error('Payment processing error, rolling back modifications:', error);
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Failed to rollback transaction:', rollbackError);
    }
    client.release();
    throw error;
  }
}
