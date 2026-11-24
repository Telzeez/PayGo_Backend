import express, { Response } from 'express';
import axios from 'axios';
import { PaymentInitialRequest } from '../types/index.js';
import pool from '../db.js';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/initiate', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { amount, email, deviceId, marketplacePurchaseId } = req.body as PaymentInitialRequest;
    if (!amount || !email || !deviceId) {
      return res.status(400).json({ success: false, error: 'Amount, email and deviceId are required' });
    }
    if (amount < 100) {
      return res.status(400).json({ success: false, error: 'Minimum payment is ₦100' });
    }
    if (email.toLowerCase() !== req.user!.email.toLowerCase()) {
      return res.status(403).json({ success: false, error: 'Payment email must match the signed-in account' });
    }

    const access = await pool.query(
      `SELECT d.owner_id,
              EXISTS (
                SELECT 1 FROM customer_connections c
                JOIN energy_sources s ON s.id = c.source_id
                WHERE s.device_id = d.device_id AND c.customer_id = $2
                  AND c.status IN ('APPROVED', 'PENDING_REVISION')
                  AND c.installation_confirmed_at IS NOT NULL
              ) AS "isConnectedBuyer"
       FROM devices d
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
    if (!access.rows.length) {
      return res.status(403).json({ success: false, error: 'You do not have permission to recharge this meter.' });
    }
    const isMeterOwner = Number(access.rows[0].owner_id) === req.user!.userId;
    if (!isMeterOwner && marketplacePurchaseId === undefined) {
      return res.status(403).json({ success: false, error: 'Connected buyers must purchase energy through an active marketplace listing.' });
    }

    let claimedPurchaseId: number | null = null;
    if (marketplacePurchaseId !== undefined) {
      if (!Number.isInteger(Number(marketplacePurchaseId)) || Number(marketplacePurchaseId) <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid marketplace purchase ID.' });
      }
      const purchase = await pool.query(
        `UPDATE marketplace_purchases
         SET status = 'PAYMENT_PENDING', updated_at = NOW()
         WHERE id = $1 AND buyer_id = $2 AND device_id = $3
           AND amount = $4 AND status = 'RESERVED'
         RETURNING id`,
        [Number(marketplacePurchaseId), req.user!.userId, deviceId, amount]
      );
      if (!purchase.rows.length) {
        return res.status(409).json({ success: false, error: 'This marketplace purchase is no longer available for payment.' });
      }
      claimedPurchaseId = Number(purchase.rows[0].id);
    }

    // Never derive a payment callback from the caller-controlled Origin/Referer headers.
    const configuredFrontendUrl = process.env.FRONTEND_URL || process.env.APP_BASE_URL ||
      (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000');
    if (!configuredFrontendUrl) {
      console.error('FRONTEND_URL must be configured before initiating payments in production.');
      return res.status(503).json({ success: false, error: 'Payment service is not fully configured.' });
    }

    let frontendUrl: string;
    try {
      const parsedFrontendUrl = new URL(configuredFrontendUrl);
      const isLocalHttp = parsedFrontendUrl.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(parsedFrontendUrl.hostname);
      if (parsedFrontendUrl.username || parsedFrontendUrl.password ||
          (parsedFrontendUrl.protocol !== 'https:' && !isLocalHttp)) {
        throw new Error('FRONTEND_URL must be an HTTPS origin (HTTP is allowed only for localhost).');
      }
      frontendUrl = parsedFrontendUrl.origin;
    } catch (configurationError) {
      console.error('Invalid FRONTEND_URL configuration:', configurationError);
      return res.status(503).json({ success: false, error: 'Payment service is not fully configured.' });
    }
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: amount * 100,
        metadata: { deviceId, ownerId: req.user!.userId, ...(claimedPurchaseId ? { marketplacePurchaseId: claimedPurchaseId } : {}) },
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
      if (claimedPurchaseId) {
        await pool.query(
          `UPDATE marketplace_purchases SET status = 'RESERVED', updated_at = NOW()
           WHERE id = $1 AND status = 'PAYMENT_PENDING' AND paystack_reference IS NULL`,
          [claimedPurchaseId]
        );
      }
      return res.status(400).json({ success: false, error: 'Paystack initialization failed' });
    }
    if (claimedPurchaseId) {
      await pool.query(
        `UPDATE marketplace_purchases SET paystack_reference = $2, updated_at = NOW()
         WHERE id = $1 AND status IN ('PAYMENT_PENDING', 'COMPLETED')`,
        [claimedPurchaseId, response.data.data.reference]
      );
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
