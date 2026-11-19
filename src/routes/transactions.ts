import express, { Request, Response } from 'express';
import axios from 'axios';
import pool from '../db.js';
import { processSuccessfulPayment } from '../services/paymentProcessor.js';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.get('/verify/:reference', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { reference } = req.params;
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

    if (!reference) {
      return res.status(400).json({ status: 'failed', error: 'Missing transaction reference' });
    }

    const canAccessDevice = async (deviceId: string) => {
      const access = await pool.query(
        'SELECT 1 FROM devices WHERE device_id = $1 AND owner_id = $2 LIMIT 1',
        [deviceId, req.user!.userId]
      );
      return access.rows.length > 0;
    };

    // Perform a lightweight, non-locking read query
    const result = await pool.query(
      `SELECT kwh_amount, expires_at, used, raw_token, device_id 
       FROM paygo_tokens 
       WHERE paystack_reference = $1`,
      [reference]
    );

    // CASE 1: Legacy token record. New payments no longer create keypad tokens.
    if (result.rows.length > 0 && !(await canAccessDevice(result.rows[0].device_id))) {
      return res.status(404).json({ status: 'failed', error: 'Transaction not found' });
    }

    // CASE 2: Current financial transaction record.
    if (result.rows.length === 0) {
      const txCheck = await pool.query(
        `SELECT kwh_amount, hardware_status, device_id FROM transactions WHERE reference = $1`,
        [reference]
      );
      if (txCheck.rows.length > 0) {
        if (!(await canAccessDevice(txCheck.rows[0].device_id))) {
          return res.status(404).json({ status: 'failed', error: 'Transaction not found' });
        }
        return res.status(200).json({
          status: 'success',
          data: {
            kwhAmount: parseFloat(txCheck.rows[0].kwh_amount),
            hardwareStatus: txCheck.rows[0].hardware_status,
            deviceId: txCheck.rows[0].device_id
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
          const deviceId: string | undefined = transaction.metadata?.deviceId || transaction.metadata?.deviceid;
          if (!deviceId || !(await canAccessDevice(deviceId))) {
            return res.status(404).json({ status: 'failed', error: 'Transaction meter not found in your account' });
          }

          console.log(`[Active Fallback] Recovering missed webhook for reference: ${reference}`);
          
          const processed = await processSuccessfulPayment(reference as string, buyerEmail, amountPaid, deviceId);
          
          if (processed) {
             const PRICE_PER_KWH = parseFloat(process.env.PRICE_PER_KWH || '200');
             const kwhAmount = amountPaid / PRICE_PER_KWH;
             
             return res.status(200).json({
               status: 'success',
               data: {
                 kwhAmount: kwhAmount,
                 hardwareStatus: 'PENDING',
                 deviceId
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

    // Legacy token record (kept readable for historical payments only).
    const tokenData = result.rows[0];
    return res.status(200).json({
      status: 'success',
      data: {
        kwhAmount: tokenData.kwh_amount,
        expiresAt: tokenData.expires_at,
        used: tokenData.used,
        fallbackToken: tokenData.raw_token,
        deviceId: tokenData.device_id
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
