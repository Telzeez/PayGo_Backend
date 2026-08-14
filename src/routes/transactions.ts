import express, { Request, Response } from 'express';
import pool from '../db.js';

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
