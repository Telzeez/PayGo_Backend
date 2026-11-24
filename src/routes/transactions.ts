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
        `SELECT 1 FROM devices d
         WHERE d.device_id = $1
           AND (d.owner_id = $2 OR EXISTS (
             SELECT 1 FROM customer_connections c
             JOIN energy_sources s ON s.id = c.source_id
             WHERE s.device_id = d.device_id AND c.customer_id = $2
               AND c.status IN ('APPROVED', 'PENDING_REVISION') AND c.installation_confirmed_at IS NOT NULL
           ))
         LIMIT 1`,
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
          const rawMarketplacePurchaseId = transaction.metadata?.marketplacePurchaseId;
          const marketplacePurchaseId = rawMarketplacePurchaseId === undefined ? undefined : Number(rawMarketplacePurchaseId);
          if (!deviceId || !(await canAccessDevice(deviceId)) ||
              (rawMarketplacePurchaseId !== undefined && (!Number.isInteger(marketplacePurchaseId) || marketplacePurchaseId! <= 0))) {
            return res.status(404).json({ status: 'failed', error: 'Transaction meter not found in your account' });
          }

          console.log(`[Active Fallback] Recovering missed webhook for reference: ${reference}`);
          
          const processed = await processSuccessfulPayment(reference as string, buyerEmail, amountPaid, deviceId, marketplacePurchaseId);
          
          if (processed) {
             const committed = await pool.query(
               `SELECT kwh_amount, hardware_status FROM transactions WHERE reference = $1 LIMIT 1`,
               [reference]
             );
             if (!committed.rows.length) {
               return res.status(200).json({ status: 'pending', message: 'Payment was accepted and is being recorded.' });
             }
             return res.status(200).json({
               status: 'success',
               data: {
                 kwhAmount: Number(committed.rows[0].kwh_amount),
                 hardwareStatus: committed.rows[0].hardware_status || 'PENDING',
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
