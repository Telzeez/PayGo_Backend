import express, { Request, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import pool from '../db.js';
import { sendSms } from '../services/sms.js';
import { PaystackWebhookEvent } from '../types/index.js';
import { processSuccessfulPayment } from '../services/paymentProcessor.js';
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

        const buyerEmail: string = transaction.customer.email;
        const amountPaid: number = transaction.amount / 100; // Amount in Naira
        const deviceId: string = transaction.metadata.deviceId || transaction.metadata.deviceid || 'device_001';

        await processSuccessfulPayment(reference, buyerEmail, amountPaid, deviceId);

        client.release();
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
