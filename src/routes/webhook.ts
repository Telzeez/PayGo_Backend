import express, { Request, Response } from 'express';
import crypto from 'crypto';
import pool from '../db.js';
import { PaystackWebhookEvent } from '../types/index.js';
import { processSuccessfulPayment } from '../services/paymentProcessor.js';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();

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

        const amountPaid: number = transaction.amount / 100; // Amount in Naira
        const deviceId: string | undefined = transaction.metadata?.deviceId || transaction.metadata?.deviceid;
        if (!deviceId) {
          client.release();
          console.error(`Successful Paystack payment ${reference} is missing its meter ID.`);
          return res.status(400).send('Payment is missing its target meter');
        }

        const purchaseId = Number(transaction.metadata?.marketplacePurchaseId);
        const processed = await processSuccessfulPayment(
          reference,
          amountPaid,
          deviceId,
          Number.isInteger(purchaseId) && purchaseId > 0 ? purchaseId : undefined
        );

        client.release();
        return res.status(200).send(processed ? 'Webhook processed' : 'Webhook already processed');
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
