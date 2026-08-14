import express, { Request, Response } from 'express';
import axios from 'axios';
import pool from '../db.js';
import { processSuccessfulPayment } from '../services/paymentProcessor.js';

const router = express.Router();

router.get('/verify/:reference', async (req: Request, res: Response) => {
  try {
    const { reference } = req.params;
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

    if (!reference) {
      return res.status(400).json({ status: 'failed', error: 'Missing transaction reference' });
    }

    // Perform a lightweight, non-locking read query
    const result = await pool.query(
      `SELECT kwh_amount, expires_at, used 
       FROM paygo_tokens 
       WHERE paystack_reference = $1`,
      [reference]
    );

    // CASE 1: Webhook has not executed yet in paygo_tokens, check transactions table
    if (result.rows.length === 0) {
      const txCheck = await pool.query(
        `SELECT kwh_amount, hardware_status FROM transactions WHERE reference = $1`,
        [reference]
      );
      if (txCheck.rows.length > 0) {
        return res.status(200).json({
          status: 'success',
          data: {
            kwhAmount: parseFloat(txCheck.rows[0].kwh_amount),
            hardwareStatus: txCheck.rows[0].hardware_status
          }
        });
      }

      // --- ACTIVE VERIFICATION FALLBACK ---
      try {
        const secret = process.env.PAYSTACK_SECRET_KEY || '';
        const paystackRes = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
          headers: { Authorization: `Bearer ${secret}` },
          timeout: 5000
        });

        if (paystackRes.data && paystackRes.data.status === true && paystackRes.data.data.status === 'success') {
          const transaction = paystackRes.data.data;
          const buyerEmail: string = transaction.customer.email;
          const amountPaid: number = transaction.amount / 100;
          const deviceId: string = transaction.metadata?.deviceId || transaction.metadata?.deviceid || 'device_001';

          console.log(`[Active Fallback] Recovering missed webhook for reference: ${reference}`);
          
          const processed = await processSuccessfulPayment(reference as string, buyerEmail, amountPaid, deviceId);
          
          if (processed) {
             const PRICE_PER_KWH = parseFloat(process.env.PRICE_PER_KWH || '200');
             const kwhAmount = amountPaid / PRICE_PER_KWH;
             
             return res.status(200).json({
               status: 'success',
               data: {
                 kwhAmount: kwhAmount,
                 hardwareStatus: 'PENDING'
               }
             });
          }
        }
      } catch (fallbackError: any) {
        // If Paystack returns a 400 (not found), just ignore and keep polling
        if (fallbackError.response && fallbackError.response.status !== 400) {
          console.error('Active verification fallback error:', fallbackError.message);
        }
      }

      return res.status(200).json({ 
        status: 'pending', 
        message: 'Payment confirmation processing by background workers.' 
      });
    }

    // CASE 2: Token row was successfully written by the webhook transaction
    const tokenData = result.rows[0];
    return res.status(200).json({
      status: 'success',
      data: {
        kwhAmount: tokenData.kwh_amount,
        expiresAt: tokenData.expires_at,
        used: tokenData.used
      }
    });

  } catch (error) {
    console.error('CRITICAL: Transaction verification failed:', error);
    return res.status(500).json({ 
      status: 'failed', 
      error: 'Internal database processing error' 
    });
  }
});

export default router;
