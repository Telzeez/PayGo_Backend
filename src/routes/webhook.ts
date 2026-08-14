import express, { Request, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import pool from '../db.js';
import { sendSms } from '../services/sms.js';
import { PaystackWebhookEvent } from '../types/index.js';
import mqttService from '../mqtt-client.js';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();

const SALT_ROUNDS: number = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10', 10);
const TOKEN_EXPIRY_HOURS: number = parseInt(process.env.TOKEN_EXPIRY_HOURS || '72', 10);
const PRICE_PER_KWH: number = parseFloat(process.env.PRICE_PER_KWH || '200');

router.post(
  '/paystack',
  async (req: Request, res: Response) => {
    // 🔑 Get a dedicated client from the pool to handle the single transaction session
    const client = await pool.connect();

    try {
      const secret = process.env.PAYSTACK_SECRET_KEY || '';
      const signature = req.headers['x-paystack-signature'] as string;
      
      const rawBodyString = (req as any).rawBody ? (req as any).rawBody.toString('utf8') : JSON.stringify(req.body);
      const hash = crypto.createHmac('sha512', secret).update(rawBodyString).digest('hex');

      if (hash !== signature) {
        console.warn('Invalid Paystack signature');
        client.release(); // Always release the client back to the pool
        return res.status(401).send('Invalid signature');
      }

      const event = req.body as PaystackWebhookEvent;

      if (event.event === 'charge.success') {
        const transaction = event.data;
        const reference = transaction.reference;

        // STEP 1: START THE TRANSACTION
        await client.query('BEGIN');

        // STEP 2: Idempotency Check (Using 'FOR UPDATE' locks this specific row if it exists)
        const existingTx = await client.query(
          'SELECT id FROM transactions WHERE reference = $1 FOR UPDATE',
          [reference]
        );

        if (existingTx.rows.length > 0) {
          console.log(`Duplicate webhook received. Reference ${reference} already processed.`);
          await client.query('ROLLBACK'); // Safely cancel transaction
          client.release();
          return res.status(200).send('Webhook already processed'); 
        }

        const buyerEmail: string = transaction.customer.email;
        const amountPaid: number = transaction.amount / 100; // Amount in Naira
        const deviceId: string = transaction.metadata.deviceId || transaction.metadata.deviceid || 'device_001';
        const kwhAmount: number = amountPaid / PRICE_PER_KWH;

        // Generate clean internal transaction ID
        const txId = `TXN_${crypto.randomUUID().substring(0, 8).toUpperCase()}`;

        const tokenCode: string = (
          crypto.randomInt(10000000, 99999999).toString() + 
          crypto.randomInt(10000000, 99999999).toString()
        );
        const hashedToken: string = await bcrypt.hash(tokenCode, SALT_ROUNDS);

        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + TOKEN_EXPIRY_HOURS);

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

          // Settle any reserved marketplace purchase tied to this device & buyer
          const mktRes = await client.query(
            `SELECT id, listing_id, kwh_requested 
             FROM marketplace_purchases 
             WHERE device_id = $1 AND status = 'RESERVED' 
             ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
            [deviceId]
          );

          if (mktRes.rows.length > 0) {
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
            return res.status(200).send('Webhook already processed');
          }
          throw dbError;
        }

        // STEP 5: Insert fallback token record
        await client.query(
          `INSERT INTO paygo_tokens 
           (buyer_email, device_id, kwh_amount, token_hash, expires_at, used, paystack_reference, transaction_id, auto_credited) 
           VALUES ($1, $2, $3, $4, $5, false, $6, $7, true)`,
          [buyerEmail, deviceId, kwhAmount, hashedToken, expiresAt, reference, txId]
        );

        // STEP 6: Send SMS notification
        await sendSms(buyerEmail, tokenCode);

        // STEP 7: COMMIT THE TRANSACTION BEFORE MQTT PUBLISHING
        await client.query('COMMIT');
        client.release();

        console.log(`✅ Financial transaction committed for ${deviceId}. txId: ${txId}, reference: ${reference}`);

        // STEP 8: POST-COMMIT MQTT CREDIT COMMAND DISPATCH
        mqttService.publishCreditCommand(deviceId, kwhAmount, txId);

        return res.status(200).send('Webhook processed');
      }

      client.release();
      res.status(200).send('Event ignored');
    } catch (error) {
      console.error('Webhook error, rolling back modifications:', error);
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Failed to rollback transaction:', rollbackError);
      }
      client.release();
      res.status(500).send('Webhook processing failed');
    }
  }
);

export default router;
