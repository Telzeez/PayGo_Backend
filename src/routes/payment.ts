import express, { Response } from 'express';
import axios from 'axios';
import { PaymentInitialRequest } from '../types/index.js';
import pool from '../db.js';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/initiate', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { amount, email, deviceId } = req.body as PaymentInitialRequest;
    if (!amount || !email || !deviceId) {
      return res.status(400).json({ success: false, error: 'Amount, email and deviceId are required' });
    }
    if (amount < 100) {
      return res.status(400).json({ success: false, error: 'Minimum payment is ₦100' });
    }
    if (email.toLowerCase() !== req.user!.email.toLowerCase()) {
      return res.status(403).json({ success: false, error: 'Payment email must match the signed-in account' });
    }

    const owned = await pool.query(
      `SELECT 1 FROM devices d
       WHERE d.device_id = $1
         AND (d.owner_id = $2 OR EXISTS (
           SELECT 1 FROM energy_sources es WHERE es.device_id = d.device_id AND es.owner_id = $2
         ))
       LIMIT 1`,
      [deviceId, req.user!.userId]
    );
    if (!owned.rows.length) {
      return res.status(403).json({ success: false, error: 'You do not have permission to recharge this meter' });
    }

    const requestOrigin = (req.headers.origin as string) ||
      (req.headers.referer ? new URL(req.headers.referer).origin : undefined);
    const frontendUrl = (process.env.FRONTEND_URL || requestOrigin || 'http://localhost:3000').replace(/\/+$/, '');
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: amount * 100,
        metadata: { deviceId, ownerId: req.user!.userId },
        callback_url: `${frontendUrl}/verify`,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    if (!response.data.status) {
      return res.status(400).json({ success: false, error: 'Paystack initialization failed' });
    }
    return res.json({
      success: true,
      paymentUrl: response.data.data.authorization_url,
      reference: response.data.data.reference,
    });
  } catch (error) {
    console.error('Payment initiation error:', error);
    return res.status(500).json({ success: false, error: 'Payment initiation failed' });
  }
});

export default router;
