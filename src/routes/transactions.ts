import express, { Request, Response } from 'express';
import axios from 'axios';
import pool from '../db.js';
import { processSuccessfulPayment } from '../services/paymentProcessor.js';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.get('/verify/:reference', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ status: 'failed', error: 'Authentication required.' });
    }

    const reference = req.params.reference as string;
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

    if (!reference) {
      return res.status(400).json({ status: 'failed', error: 'Missing transaction reference' });
    }

    const findTransaction = () => pool.query(
      `SELECT t.kwh_amount, t.hardware_status, t.device_id
       FROM transactions t
       JOIN user_devices ud ON ud.device_id = t.device_id
       WHERE t.reference = $1 AND ud.user_id = $2`,
      [reference, req.user!.userId]
    );
    const respondWithTransaction = (transaction: { kwh_amount: string | number; hardware_status: string; device_id: string }) =>
      res.status(200).json({
        status: 'success',
        data: {
          kwhAmount: parseFloat(String(transaction.kwh_amount)),
          hardwareStatus: transaction.hardware_status,
          deviceId: transaction.device_id,
        },
      });

    const existingTransaction = await findTransaction();
    if (existingTransaction.rows.length > 0) {
      return respondWithTransaction(existingTransaction.rows[0]);
    }

    // Recover a successful payment if its webhook has not arrived yet.
    try {
      const secret = process.env.PAYSTACK_SECRET_KEY || '';
      const paystackRes = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
        headers: { Authorization: `Bearer ${secret}` },
        timeout: 5000,
      });

      if (paystackRes.data?.status === true && paystackRes.data.data?.status === 'success') {
        const transaction = paystackRes.data.data;
        const amountPaid: number = transaction.amount / 100;
        const deviceId: string | undefined =
          transaction.metadata?.deviceId || transaction.metadata?.deviceid;

        if (!deviceId) {
          return res.status(200).json({
            status: 'failed',
            error: 'Payment confirmation is missing its target meter.',
          });
        }

        const meterAccess = await pool.query(
          'SELECT 1 FROM user_devices WHERE user_id = $1 AND device_id = $2',
          [req.user.userId, deviceId]
        );
        if (meterAccess.rows.length === 0) {
          return res.status(404).json({ status: 'failed', error: 'Payment reference not found for this account.' });
        }

        console.log(`[Active Verification] Recovering missed webhook for reference: ${reference}`);
        const purchaseId = Number(transaction.metadata?.marketplacePurchaseId);
        await processSuccessfulPayment(
          reference,
          amountPaid,
          deviceId,
          Number.isInteger(purchaseId) && purchaseId > 0 ? purchaseId : undefined
        );

        const recoveredTransaction = await findTransaction();
        if (recoveredTransaction.rows.length > 0) {
          return respondWithTransaction(recoveredTransaction.rows[0]);
        }
      }
    } catch (verificationError: any) {
      if (verificationError.response && verificationError.response.status !== 400) {
        console.error('Active verification error:', verificationError.message);
      }
    }

    return res.status(200).json({
      status: 'pending',
      message: 'Payment confirmation processing by background workers.',
    });
  } catch (error) {
    console.error('CRITICAL: Transaction verification failed:', error);
    return res.status(500).json({
      status: 'failed',
      error: 'Internal database processing error',
    });
  }
});

export default router;
