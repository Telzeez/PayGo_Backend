import express, { Request, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import pool from '../db.js';
import { sendSms } from '../services/sms.js';
import { PaystackWebhookEvent } from '../types/index.js';
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
          'SELECT id FROM paygo_tokens WHERE paystack_reference = $1 FOR UPDATE',
          [reference]
        );

        if (existingTx.rows.length > 0) {
          console.log(`Duplicate webhook received. Reference ${reference} already processed.`);
          await client.query('ROLLBACK'); // Safely cancel transaction
          client.release();
          return res.status(200).send('Webhook already processed'); 
        }

        const buyerEmail: string = transaction.customer.email;
        const amountPaid: number = transaction.amount / 100; 
        const deviceId: string = transaction.metadata.deviceId || 'device_001';
        const kwhAmount: number = amountPaid / PRICE_PER_KWH;

        const tokenCode: string = crypto.randomInt(10000000, 99999999).toString();
        const hashedToken: string = await bcrypt.hash(tokenCode, SALT_ROUNDS);

        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + TOKEN_EXPIRY_HOURS);

        // STEP 3: Insert token within the transaction session
        try {
          await client.query(
            `INSERT INTO paygo_tokens 
             (buyer_email, device_id, kwh_amount, token_hash, expires_at, used, paystack_reference) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [buyerEmail, deviceId, kwhAmount, hashedToken, expiresAt, false, reference]
          );
        } catch (dbError: any) {
          if (dbError.code === '23505') { 
            console.log(` Race condition caught. Reference ${reference} processed concurrently.`);
            await client.query('ROLLBACK');
            client.release();
            return res.status(200).send('Webhook already processed');
          }
          throw dbError; // Pass up to the main catch block to trigger full rollback
        }

        // STEP 4: Send the SMS
        // If this throws an error, the catch block will run 'ROLLBACK', erasing the DB entry above
        await sendSms(buyerEmail, tokenCode);

        // STEP 5: COMMIT THE TRANSACTION
        // Only makes changes permanent if everything (including SMS) succeeded
        await client.query('COMMIT');
        client.release();

        console.log(`✅ Transaction fully processed. Token ${tokenCode} sent to ${buyerEmail}`);
        return res.status(200).send('Webhook processed');
      }

      client.release();
      res.status(200).send('Event ignored');
    } catch (error) {
      // CRITICAL PROTECTION: Erase database modifications if anything failed mid-process
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
