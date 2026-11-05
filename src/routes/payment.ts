import express, { Request, Response } from 'express';
import axios from 'axios';
import { PaymentInitialRequest } from '../types/index.js';
import dotenv from 'dotenv';
import pool from '../db.js';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/authMiddleware.js';

dotenv.config()

const router = express.Router();

router.post('/initiate', authenticateToken, async (req:AuthenticatedRequest, res:Response) => {
    try {
        if (!req.user) {
            return res.status(401).json({ success: false, error: 'Authentication required.' });
        }

        const {amount, email, deviceId, marketplacePurchaseId} = req.body as PaymentInitialRequest;

        if(!amount || !email || !deviceId){
            return res.status(400).json({
                success: false,
                error: `Missing required field: amount entered ${!amount? "null" : amount} email: ${!email? "null": email}, deviceId: ${!deviceId? "null" : deviceId}`
            })
        }
        if(amount < 100){
            return res.status(400).json({
                success: false,
                error: "Minimum payment is #100"
            })
        }

        if (email.toLowerCase() !== req.user.email.toLowerCase()) {
            return res.status(403).json({ success: false, error: 'Payment email must match the signed-in account.' });
        }

        const meterAccess = await pool.query(
            'SELECT 1 FROM user_devices WHERE user_id = $1 AND device_id = $2',
            [req.user.userId, deviceId]
        );
        if (meterAccess.rows.length === 0) {
            return res.status(403).json({ success: false, error: 'Payment target must be a meter linked to your account.' });
        }

        if (marketplacePurchaseId !== undefined) {
            const purchase = await pool.query(
                `SELECT 1 FROM marketplace_purchases
                 WHERE id = $1 AND buyer_id = $2 AND device_id = $3
                   AND amount = $4 AND status = 'RESERVED'`,
                [marketplacePurchaseId, req.user.userId, deviceId, amount]
            );
            if (purchase.rows.length === 0) {
                return res.status(403).json({ success: false, error: 'Marketplace purchase does not match your account, meter, or payment amount.' });
            }
        }

        // Determine frontend URL (env var, or dynamic request origin from browser, or localhost fallback)
        const requestOrigin = (req.headers.origin as string) || (req.headers.referer ? new URL(req.headers.referer).origin : undefined);
        const FRONTEND_URL = (process.env.FRONTEND_URL || requestOrigin || 'http://localhost:3000').replace(/\/+$/, '');
        const response = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: req.user.email,
                amount: amount* 100,
                metadata: { deviceId, ...(marketplacePurchaseId ? { marketplacePurchaseId } : {}) },
                callback_url: `${FRONTEND_URL}/verify`
            },
            {
                headers:{
                    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        )

    if(!response.data.status){
        return res.status(400).json({
            success: false,

            error: 'Paystack initialization failed'
        })
    }
    res.json({
        success: true,
        paymentUrl: response.data.data.authorization_url,
        reference: response.data.data.reference,
    })

    } catch (error) {
        console.error('Payment iniitation error ', error);
        res.status(500).json({
            success: false,
            error: 'Payment initiation failed'
        })
    }
    
})

export default router